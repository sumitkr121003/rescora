export const TARGET_NETWORK = "testnet" as const;

export type WalletAccount = Readonly<{ accountId: string; publicKey: string }>;
export type WalletNetwork = Readonly<{ networkId: string; nodeUrls?: readonly string[] }>;
export type WalletStatus =
  | "checking"
  | "unavailable"
  | "disconnected"
  | "connecting"
  | "connected"
  | "unsupported-network"
  | "unverified"
  | "error"
  | "cancelled";
export type WalletState = Readonly<{
  status: WalletStatus;
  account: WalletAccount | null;
  network: WalletNetwork | null;
  observedAt: string | null;
  error: string | null;
}>;

export const EMPTY_WALLET_STATE: WalletState = {
  status: "checking",
  account: null,
  network: null,
  observedAt: null,
  error: null,
};

export type WalletProvider = {
  detectWalletInstalled(): Promise<boolean>;
  request(input: { method: string }): Promise<unknown>;
  on(event: "accountsChanged", listener: (payload: unknown) => void): unknown;
  on(event: "networkChanged", listener: (payload: unknown) => void): unknown;
  on(event: "disconnect", listener: () => void): unknown;
  off(
    event: "accountsChanged" | "networkChanged" | "disconnect",
    listener: (...args: never[]) => void,
  ): unknown;
};

type Timer = ReturnType<typeof setTimeout>;

/** Serializes the complete underlying provider promise, including timed-out requests. */
export class ProviderRequestGate {
  private pending = false;

  constructor(private readonly onPendingChange: () => void = () => undefined) {}

  get isPending(): boolean {
    return this.pending;
  }

  async request<T>(
    provider: WalletProvider,
    method: AllowedMethod,
    timeoutMs = 12_000,
  ): Promise<T> {
    if (this.pending)
      throw new Error("A wallet request is still pending. Reload the page if it does not settle.");
    this.pending = true;
    this.onPendingChange();
    let timer: Timer | undefined;
    const underlying = provider.request({ method });
    underlying
      .finally(() => {
        this.pending = false;
        this.onPendingChange();
      })
      .catch(() => undefined);
    try {
      return (await Promise.race([
        underlying,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Wallet request timed out. Reload the page before trying again if it remains pending.",
                ),
              ),
            timeoutMs,
          );
        }),
      ])) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

type AllowedMethod = "near_requestAccounts" | "near_accounts" | "near_networkInfo" | "near_signOut";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAccounts(value: unknown): WalletAccount[] | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.accounts)) return null;
  const result: WalletAccount[] = [];
  for (const item of record.accounts) {
    const account = asRecord(item);
    if (
      !account ||
      typeof account.accountId !== "string" ||
      !account.accountId ||
      typeof account.publicKey !== "string" ||
      !account.publicKey
    )
      return null;
    result.push({ accountId: account.accountId, publicKey: account.publicKey });
  }
  return result;
}

function parseNetwork(value: unknown): WalletNetwork | null {
  const record = asRecord(value);
  if (!record || typeof record.networkId !== "string" || !record.networkId) return null;
  if (
    record.nodeUrls !== undefined &&
    (!Array.isArray(record.nodeUrls) || !record.nodeUrls.every((url) => typeof url === "string"))
  )
    return null;
  return {
    networkId: record.networkId,
    ...(Array.isArray(record.nodeUrls) ? { nodeUrls: record.nodeUrls as string[] } : {}),
  };
}

function parseAccountEvent(value: unknown): WalletAccount | null {
  const accounts = parseAccounts(value);
  return accounts?.length === 1 ? accounts[0] : null;
}

function userRejected(error: unknown): boolean {
  const record = asRecord(error);
  return (
    record?.code === 4001 || record?.code === "4001" || record?.name === "UserRejectedRequestError"
  );
}

export class WalletSessionController {
  private state: WalletState = EMPTY_WALLET_STATE;
  private listeners = new Set<(state: WalletState) => void>();
  private provider: WalletProvider | null = null;
  private gate: ProviderRequestGate;
  private flowActive = false;
  private generation = 0;
  private eventRevision = 0;
  private expectedAccountEvent: WalletAccount | null = null;
  private expectedNetworkEvent: WalletNetwork | null = null;
  private accountEventSeen = false;
  private networkEventSeen = false;
  private invalidEvent = false;
  private disconnectedInFlow = false;
  private removeProviderEvents: (() => void) | null = null;

  get isBusy(): boolean {
    return this.flowActive || this.gate.isPending;
  }

  constructor(private readonly createProvider: () => WalletProvider | Promise<WalletProvider>) {
    this.gate = new ProviderRequestGate(() => this.publish());
  }

  subscribe(listener: (state: WalletState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getSnapshot = (): WalletState => this.state;

  private setState(next: WalletState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  private invalidate(status: WalletStatus, error: string | null = null): void {
    this.generation += 1;
    this.eventRevision += 1;
    this.setState({ status, account: null, network: null, observedAt: null, error });
  }

  async connect(): Promise<void> {
    if (this.flowActive || this.gate.isPending) return;
    this.flowActive = true;
    const operation = ++this.generation;
    this.expectedAccountEvent = null;
    this.expectedNetworkEvent = null;
    this.accountEventSeen = false;
    this.networkEventSeen = false;
    this.invalidEvent = false;
    this.disconnectedInFlow = false;
    this.setState({
      status: "connecting",
      account: null,
      network: null,
      observedAt: null,
      error: null,
    });
    try {
      const provider = this.provider ?? (await this.createProvider());
      this.provider = provider;
      this.bindEvents(provider);
      if (!(await provider.detectWalletInstalled())) {
        if (operation === this.generation)
          this.setState({
            status: "unavailable",
            account: null,
            network: null,
            observedAt: null,
            error: "OneKey wallet was not detected.",
          });
        return;
      }
      if (operation !== this.generation || this.disconnectedInFlow) return;
      await this.gate.request(provider, "near_requestAccounts");
      if (operation !== this.generation) return;
      if (this.disconnectedInFlow) return;
      const freshAccounts = parseAccounts(await this.gate.request(provider, "near_accounts"));
      if (operation !== this.generation) return;
      if (this.disconnectedInFlow) return;
      const freshNetwork = parseNetwork(await this.gate.request(provider, "near_networkInfo"));
      if (operation !== this.generation) return;
      if (this.disconnectedInFlow) return;
      const account = freshAccounts?.length === 1 ? freshAccounts[0] : null;
      if (!account || !freshNetwork) {
        this.invalidate(
          "unverified",
          "The wallet did not return one valid account and active network.",
        );
        return;
      }
      if (this.disconnectedInFlow) {
        this.invalidate("disconnected");
        return;
      }
      const expectedAccountEvent = this.currentExpectedAccountEvent();
      const expectedNetworkEvent = this.currentExpectedNetworkEvent();
      if (
        this.invalidEvent ||
        (this.accountEventSeen &&
          (!expectedAccountEvent ||
            expectedAccountEvent.accountId !== account.accountId ||
            expectedAccountEvent.publicKey !== account.publicKey)) ||
        (this.networkEventSeen &&
          (!expectedNetworkEvent || expectedNetworkEvent.networkId !== freshNetwork.networkId))
      ) {
        this.invalidate("unverified", "A wallet change event conflicts with fresh provider state.");
        return;
      }
      if (freshNetwork.networkId !== TARGET_NETWORK) {
        this.invalidate(
          "unsupported-network",
          `OneKey reports ${freshNetwork.networkId}; only testnet is supported.`,
        );
        return;
      }
      this.setState({
        status: "connected",
        account,
        network: freshNetwork,
        observedAt: new Date().toISOString(),
        error: null,
      });
    } catch (error) {
      if (operation === this.generation) {
        this.setState({
          status: userRejected(error) ? "cancelled" : "error",
          account: null,
          network: null,
          observedAt: null,
          error: error instanceof Error ? error.message : "Wallet connection failed.",
        });
      }
    } finally {
      this.flowActive = false;
      this.publish();
    }
  }

  async disconnect(): Promise<void> {
    if (this.flowActive || this.gate.isPending) return;
    this.flowActive = true;
    const provider = this.provider;
    this.invalidate("disconnected");
    try {
      if (provider) await this.gate.request(provider, "near_signOut");
      this.setState({
        status: "disconnected",
        account: null,
        network: null,
        observedAt: null,
        error: provider
          ? "Local identity cleared. OneKey SDK does not confirm wallet-side sign-out completion."
          : null,
      });
    } catch (error) {
      this.setState({
        status: "disconnected",
        account: null,
        network: null,
        observedAt: null,
        error:
          error instanceof Error
            ? error.message
            : "Wallet sign-out failed; local identity remains cleared.",
      });
    } finally {
      this.flowActive = false;
      this.publish();
    }
  }

  private bindEvents(provider: WalletProvider): void {
    this.removeProviderEvents?.();
    const onDisconnect = () => {
      this.disconnectedInFlow = true;
      this.expectedAccountEvent = null;
      this.expectedNetworkEvent = null;
      this.invalidateFromEvent("disconnected");
    };
    const onAccountsChanged = (payload: unknown) => {
      const parsed = parseAccounts(payload);
      const account = parsed?.length === 1 ? parseAccountEvent(payload) : null;
      this.accountEventSeen = true;
      if (!parsed) this.invalidEvent = true;
      if (parsed && parsed.length === 0) this.disconnectedInFlow = true;
      this.expectedAccountEvent = account;
      this.invalidateFromEvent(
        account ? "unverified" : "disconnected",
        account ? "Account changed; checking fresh wallet identity." : null,
      );
      if (!this.flowActive && account) void this.reconcile(provider);
    };
    const onNetworkChanged = (payload: unknown) => {
      const network = parseNetwork(payload);
      this.networkEventSeen = true;
      if (!network) this.invalidEvent = true;
      this.expectedNetworkEvent = network;
      this.invalidateFromEvent("unverified", "Network changed; checking fresh wallet identity.");
      if (!network || network.networkId !== TARGET_NETWORK) {
        this.setState({
          status: "unsupported-network",
          account: null,
          network: null,
          observedAt: null,
          error: network
            ? `OneKey reports ${network.networkId}; only testnet is supported.`
            : "Malformed wallet network event.",
        });
      } else if (!this.flowActive) void this.reconcile(provider);
    };
    provider.on("disconnect", onDisconnect);
    provider.on("accountsChanged", onAccountsChanged);
    provider.on("networkChanged", onNetworkChanged);
    this.removeProviderEvents = () => {
      provider.off("disconnect", onDisconnect as (...args: never[]) => void);
      provider.off("accountsChanged", onAccountsChanged as (...args: never[]) => void);
      provider.off("networkChanged", onNetworkChanged as (...args: never[]) => void);
    };
  }

  private invalidateFromEvent(status: WalletStatus, error: string | null = null): void {
    if (!this.flowActive) this.generation += 1;
    this.eventRevision += 1;
    this.setState({ status, account: null, network: null, observedAt: null, error });
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private currentExpectedAccountEvent(): WalletAccount | null {
    return this.expectedAccountEvent;
  }

  private currentExpectedNetworkEvent(): WalletNetwork | null {
    return this.expectedNetworkEvent;
  }

  private async reconcile(provider: WalletProvider): Promise<void> {
    if (this.flowActive || this.gate.isPending) return;
    this.flowActive = true;
    const operation = this.generation;
    const revision = this.eventRevision;
    try {
      const freshAccounts = parseAccounts(await this.gate.request(provider, "near_accounts"));
      if (operation !== this.generation) return;
      const freshNetwork = parseNetwork(await this.gate.request(provider, "near_networkInfo"));
      if (operation !== this.generation) return;
      const account = freshAccounts?.length === 1 ? freshAccounts[0] : null;
      if (
        revision !== this.eventRevision ||
        !account ||
        !freshNetwork ||
        this.invalidEvent ||
        (this.accountEventSeen &&
          (!this.expectedAccountEvent ||
            this.expectedAccountEvent.accountId !== account.accountId ||
            this.expectedAccountEvent.publicKey !== account.publicKey)) ||
        (this.networkEventSeen &&
          (!this.expectedNetworkEvent ||
            this.expectedNetworkEvent.networkId !== freshNetwork.networkId))
      ) {
        this.invalidate(
          "unverified",
          "Wallet event and fresh provider state could not be reconciled.",
        );
        return;
      }
      if (freshNetwork.networkId !== TARGET_NETWORK) {
        this.invalidate(
          "unsupported-network",
          `OneKey reports ${freshNetwork.networkId}; only testnet is supported.`,
        );
        return;
      }
      this.setState({
        status: "connected",
        account,
        network: freshNetwork,
        observedAt: new Date().toISOString(),
        error: null,
      });
    } catch (error) {
      if (operation === this.generation)
        this.invalidate(
          "unverified",
          error instanceof Error ? error.message : "Wallet revalidation failed.",
        );
    } finally {
      this.flowActive = false;
    }
  }
}
