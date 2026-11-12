import { logWalletDebug } from "./diagnostics";
import { isNearAccountId, isNearPublicKey } from "@/lib/near-rpc/client";

export const TARGET_NETWORK = "testnet" as const;
const PROVIDER_REQUEST_TIMEOUT_MS = 32_000;

export type WalletAccount = Readonly<{ accountId: string; publicKey: string }>;
export type WalletNetwork = Readonly<{ networkId: string; nodeUrls?: readonly string[] }>;
export type WalletStatus =
  | "checking"
  | "unavailable"
  | "disconnected"
  | "connecting"
  | "connected"
  | "unsupported-network"
  | "unsupported-wallet"
  | "unverified"
  | "error"
  | "cancelled"
  | "timeout"
  | "missing-account"
  | "locked";

export type WalletDiagnosticEvent = Readonly<{
  at: string;
  event: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type WalletTestnetVerification = Readonly<{
  verified: boolean;
  reason: string;
  message: string;
}>;

export type WalletState = Readonly<{
  status: WalletStatus;
  account: WalletAccount | null;
  network: WalletNetwork | null;
  observedAt: string | null;
  error: string | null;
  testnetVerificationStatus: "pending" | "verified" | "unavailable" | "rejected";
  testnetVerificationError: string | null;
  diagnostics: readonly WalletDiagnosticEvent[];
}>;

export const EMPTY_WALLET_STATE: WalletState = {
  status: "checking",
  account: null,
  network: null,
  observedAt: null,
  error: null,
  testnetVerificationStatus: "pending",
  testnetVerificationError: null,
  diagnostics: [],
};

export type WalletProviderEvent =
  "accountsChanged" | "networkChanged" | "disconnect" | "unlockChanged" | "revalidate";

export type WalletProvider = {
  name?: string;
  version?: string;
  detectWalletInstalled(): Promise<boolean>;
  request(input: { method: string; params?: unknown }): Promise<unknown>;
  on(event: WalletProviderEvent, listener: (payload?: unknown) => void): unknown;
  off(event: WalletProviderEvent, listener: (...args: never[]) => void): unknown;
  dispose?(): void;
};

type AllowedMethod =
  "near_requestAccounts" | "near_accounts" | "near_verifyTestnetAccount" | "near_signOut";

class UnsupportedWalletMethodError extends Error {
  constructor(
    readonly method: AllowedMethod,
    readonly originalError: unknown,
    walletName: string,
  ) {
    super(`${walletName} does not support ${method}.`);
    this.name = "UnsupportedWalletMethodError";
  }
}

export class ProviderRequestTimeoutError extends Error {
  readonly code = 4500;

  constructor(
    readonly method: AllowedMethod,
    timeoutMs: number,
    walletName: string,
  ) {
    super(`${walletName} ${method} timed out after ${timeoutMs}ms.`);
    this.name = "ProviderRequestTimeoutError";
  }
}

/** Serializes provider requests and retains a timed-out request until its promise settles. */
export class ProviderRequestGate {
  private pending = false;

  constructor(private readonly onPendingChange: () => void = () => undefined) {}

  get isPending(): boolean {
    return this.pending;
  }

  async request<T>(
    provider: WalletProvider,
    method: AllowedMethod,
    timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS,
    params?: unknown,
  ): Promise<T> {
    if (this.pending) {
      throw new Error(
        `A previous ${provider.name ?? "wallet"} request is still pending. Close its wallet dialog and wait for it to finish before retrying.`,
      );
    }
    this.pending = true;
    this.onPendingChange();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let underlying: Promise<unknown>;
    try {
      underlying = Promise.resolve(
        provider.request({ method, ...(params === undefined ? {} : { params }) }),
      );
    } catch (error) {
      this.pending = false;
      this.onPendingChange();
      throw error;
    }
    void underlying
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
              reject(new ProviderRequestTimeoutError(method, timeoutMs, provider.name ?? "Wallet")),
            timeoutMs,
          );
        }),
      ])) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

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
      !isNearAccountId(account.accountId) ||
      typeof account.publicKey !== "string" ||
      !isNearPublicKey(account.publicKey)
    ) {
      return null;
    }
    result.push({ accountId: account.accountId, publicKey: account.publicKey });
  }
  return result;
}

function accountResponseError(value: unknown, walletName: string): string {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.accounts)) {
    return `${walletName} did not return a readable account list. Reopen the wallet and reconnect.`;
  }
  const account = record.accounts.find((item) => {
    const candidate = asRecord(item);
    return (
      !candidate ||
      typeof candidate.accountId !== "string" ||
      !isNearAccountId(candidate.accountId) ||
      typeof candidate.publicKey !== "string" ||
      !isNearPublicKey(candidate.publicKey)
    );
  });
  if (account) {
    const candidate = asRecord(account);
    return !candidate || typeof candidate.accountId !== "string" || !candidate.accountId
      ? `${walletName} did not return a valid account ID. Select a NEAR account in the wallet and reconnect.`
      : `${walletName} did not return a valid public key for the selected account. Select another account or reconnect.`;
  }
  return `${walletName} returned account data RESCORA could not validate. Reconnect to refresh the wallet identity.`;
}

function parseTestnetVerification(value: unknown): WalletTestnetVerification | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.verified !== "boolean" ||
    typeof record.reason !== "string" ||
    typeof record.message !== "string"
  ) {
    return null;
  }
  return {
    verified: record.verified,
    reason: /^[a-z0-9-]{1,80}$/.test(record.reason) ? record.reason : "invalid-result-reason",
    message: record.message.slice(0, 240),
  };
}

function parseNetwork(value: unknown): WalletNetwork | null {
  const record = asRecord(value);
  if (!record || typeof record.networkId !== "string" || !record.networkId) return null;
  if (
    record.nodeUrls !== undefined &&
    (!Array.isArray(record.nodeUrls) || !record.nodeUrls.every((url) => typeof url === "string"))
  ) {
    return null;
  }
  return {
    networkId: record.networkId,
    ...(Array.isArray(record.nodeUrls) ? { nodeUrls: record.nodeUrls as string[] } : {}),
  };
}

function userRejected(error: unknown): boolean {
  const record = asRecord(error);
  return (
    record?.code === 4001 || record?.code === "4001" || record?.name === "UserRejectedRequestError"
  );
}

function isTimeout(error: unknown): boolean {
  const record = asRecord(error);
  return (
    error instanceof ProviderRequestTimeoutError ||
    record?.code === 4500 ||
    record?.code === "4500" ||
    record?.code === "TIMEOUT" ||
    record?.name === "TimeoutError"
  );
}

function isUnsupportedMethod(error: unknown): boolean {
  const record = asRecord(error);
  const code = record?.code;
  const message = errorMessage(error, "").toLowerCase();
  return (
    code === -32601 ||
    code === "-32601" ||
    code === 4200 ||
    code === "4200" ||
    /method (was )?not found|method (is )?not supported/.test(message)
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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
  private accountEventSeen = false;
  private invalidEvent = false;
  private reconcileRequested = false;
  private disconnectedInFlow = false;
  private unlockStateKnown = false;
  private unlocked = false;
  private diagnosticEvents: WalletDiagnosticEvent[] = [];
  private removeProviderEvents: (() => void) | null = null;
  private readonly requestTimeoutMs: number;

  get isBusy(): boolean {
    return this.flowActive;
  }

  private get walletName(): string {
    return this.provider?.name ?? "NEAR wallet";
  }

  dispose(): void {
    this.generation += 1;
    this.removeProviderEvents?.();
    this.removeProviderEvents = null;
    this.provider?.dispose?.();
    this.provider = null;
    this.listeners.clear();
  }

  constructor(
    private readonly createProvider: () => WalletProvider | Promise<WalletProvider>,
    options: Readonly<{ requestTimeoutMs?: number }> = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? PROVIDER_REQUEST_TIMEOUT_MS;
    this.gate = new ProviderRequestGate(() => this.publish());
  }

  subscribe(listener: (state: WalletState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getSnapshot = (): WalletState => this.state;

  private publish(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private setState(next: Partial<Omit<WalletState, "diagnostics">>): void {
    this.state = { ...this.state, ...next, diagnostics: this.diagnosticEvents };
    this.publish();
  }

  private diagnose(
    event: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    this.diagnosticEvents = [
      ...this.diagnosticEvents,
      Object.freeze({ at: new Date().toISOString(), event, ...(details ? { details } : {}) }),
    ].slice(-40);
    this.state = { ...this.state, diagnostics: this.diagnosticEvents };
    logWalletDebug(event, details ?? {});
    this.publish();
  }

  private invalidate(status: WalletStatus, error: string | null = null): void {
    this.generation += 1;
    this.eventRevision += 1;
    this.diagnose("session.invalidated", { status });
    this.setState({
      status,
      account: null,
      network: null,
      observedAt: null,
      error,
      testnetVerificationStatus: "pending",
      testnetVerificationError: null,
    });
  }

  private async request<T>(
    provider: WalletProvider,
    method: AllowedMethod,
    params?: unknown,
  ): Promise<T> {
    const startedAt = Date.now();
    let verificationTimer: ReturnType<typeof setTimeout> | undefined;
    this.diagnose("provider.request.started", { method });
    try {
      const result =
        method === "near_verifyTestnetAccount"
          ? ((await Promise.race([
              Promise.resolve(
                provider.request({ method, ...(params === undefined ? {} : { params }) }),
              ),
              new Promise<never>(
                (_, reject) =>
                  (verificationTimer = setTimeout(
                    () =>
                      reject(
                        new ProviderRequestTimeoutError(
                          method,
                          this.requestTimeoutMs,
                          provider.name ?? "Wallet",
                        ),
                      ),
                    this.requestTimeoutMs,
                  )),
              ),
            ])) as T)
          : await this.gate.request<T>(provider, method, this.requestTimeoutMs, params);
      if (verificationTimer) clearTimeout(verificationTimer);
      const accounts =
        method === "near_requestAccounts" || method === "near_accounts"
          ? parseAccounts(result)
          : null;
      const verification =
        method === "near_verifyTestnetAccount" ? parseTestnetVerification(result) : null;
      const details = {
        method,
        outcome: "resolved",
        elapsedMs: Math.max(0, Date.now() - startedAt),
        ...(method === "near_requestAccounts" || method === "near_accounts"
          ? {
              accountRequestSucceeded: accounts !== null && accounts.length > 0,
              accountResponseValid: accounts !== null,
              accountCount: accounts?.length ?? 0,
            }
          : {}),
        ...(method === "near_verifyTestnetAccount"
          ? {
              testnetAccountKeyVerified: verification?.verified === true,
              verificationReason: verification?.reason ?? "invalid-verification-response",
            }
          : {}),
      } as const;
      this.diagnose("provider.request.completed", details);
      return result;
    } catch (error) {
      if (verificationTimer) clearTimeout(verificationTimer);
      const outcome = userRejected(error) ? "cancelled" : isTimeout(error) ? "timeout" : "failure";
      const record = asRecord(error);
      const errorName =
        typeof record?.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(record.name)
          ? record.name
          : error instanceof Error
            ? "Error"
            : null;
      const errorCode =
        typeof record?.code === "string" && /^[A-Z_]{1,40}$/.test(record.code)
          ? record.code
          : typeof record?.code === "number" && Number.isSafeInteger(record.code)
            ? record.code
            : null;
      const details = {
        method,
        outcome: "rejected",
        failureKind: outcome,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        ...(method === "near_requestAccounts" || method === "near_accounts"
          ? { accountRequestSucceeded: false }
          : {}),
        ...(method === "near_verifyTestnetAccount" ? { testnetAccountKeyVerified: false } : {}),
        errorName,
        errorCode,
        errorMessage: "Provider verification failed; details omitted for safety.",
      } as const;
      this.diagnose("provider.request.completed", details);
      if (isUnsupportedMethod(error))
        throw new UnsupportedWalletMethodError(method, error, provider.name ?? "Wallet");
      throw error;
    }
  }

  async connect(): Promise<void> {
    if (this.flowActive) return;
    if (this.gate.isPending) {
      this.setState({
        status: "timeout",
        account: null,
        network: null,
        observedAt: null,
        error: `The previous ${this.walletName} request has not settled. Close its dialog and retry after it closes or times out.`,
      });
      this.diagnose("connect.retry_blocked", { reason: "previous-provider-request-pending" });
      return;
    }
    this.flowActive = true;
    const operation = ++this.generation;
    this.expectedAccountEvent = null;
    this.accountEventSeen = false;
    this.invalidEvent = false;
    this.disconnectedInFlow = false;
    this.diagnose("connect.started", { provider: this.walletName });
    this.setState({
      status: "connecting",
      account: null,
      network: null,
      observedAt: null,
      error: null,
    });
    try {
      let provider = this.provider;
      if (!provider) {
        this.diagnose("provider.initialization.started");
        provider = await this.createProvider();
        this.provider = provider;
        this.diagnose("provider.initialization.completed", { outcome: "success" });
      }
      this.bindEvents(provider);
      this.diagnose("provider.detection.started", { method: "detectWalletInstalled" });
      if (!(await provider.detectWalletInstalled())) {
        this.diagnose("provider.detection.completed", { installed: false });
        if (operation === this.generation) {
          this.setState({
            status: "unavailable",
            account: null,
            network: null,
            observedAt: null,
            error: `${this.walletName} was not detected. Install or enable the provider in this browser profile, then reload RESCORA.`,
          });
        }
        return;
      }
      this.diagnose("provider.detection.completed", { installed: true });
      if (operation !== this.generation || this.disconnectedInFlow) return;

      const requestedResponse = await this.request<unknown>(provider, "near_requestAccounts");
      const requestedAccounts = parseAccounts(requestedResponse);
      this.diagnose("account.discovery.completed", {
        method: "near_requestAccounts",
        validResponse: requestedAccounts !== null,
        accountCount: requestedAccounts?.length ?? 0,
      });
      if (operation !== this.generation || this.disconnectedInFlow) return;
      if (!requestedAccounts) {
        this.setState({
          status: "unverified",
          account: null,
          network: null,
          observedAt: null,
          error: accountResponseError(requestedResponse, this.walletName),
        });
        return;
      }
      if (requestedAccounts.length === 0) {
        this.reportMissingAccount();
        return;
      }

      const freshResponse = await this.request<unknown>(provider, "near_accounts");
      const freshAccounts = parseAccounts(freshResponse);
      this.diagnose("account.discovery.completed", {
        method: "near_accounts",
        validResponse: freshAccounts !== null,
        accountCount: freshAccounts?.length ?? 0,
      });
      if (operation !== this.generation || this.disconnectedInFlow) return;
      if (!freshAccounts || freshAccounts.length === 0) {
        if (freshAccounts?.length === 0) this.reportMissingAccount();
        else {
          this.setState({
            status: "unverified",
            account: null,
            network: null,
            observedAt: null,
            error: accountResponseError(freshResponse, this.walletName),
          });
        }
        return;
      }

      const account = freshAccounts.length === 1 ? freshAccounts[0] : null;
      if (!account) {
        this.setState({
          status: "unverified",
          account: null,
          network: null,
          observedAt: null,
          error: `${this.walletName} returned multiple accounts. Select a single active account in the wallet, then reconnect.`,
        });
        return;
      }
      if (
        !requestedAccounts.some(
          (requested) =>
            requested.accountId === account.accountId && requested.publicKey === account.publicKey,
        )
      ) {
        this.setState({
          status: "unverified",
          account: null,
          network: null,
          observedAt: null,
          error: `${this.walletName}'s connection response and current account do not match. Reconnect to verify the active account.`,
        });
        return;
      }
      const expectedAccountEvent = this.currentExpectedAccountEvent();
      if (
        this.invalidEvent ||
        (this.accountEventSeen &&
          (!expectedAccountEvent ||
            expectedAccountEvent.accountId !== account.accountId ||
            expectedAccountEvent.publicKey !== account.publicKey))
      ) {
        this.invalidate(
          "disconnected",
          "A wallet event conflicts with the fresh provider account state.",
        );
        return;
      }
      this.diagnose("connect.completed", {
        outcome: "wallet-connected-verification-pending",
      });
      this.setState({
        status: "connected",
        account,
        network: null,
        observedAt: new Date().toISOString(),
        error: null,
        testnetVerificationStatus: "pending",
        testnetVerificationError: null,
      });
      void this.verifyAccount(provider, account, operation, this.eventRevision);
    } catch (error) {
      if (operation !== this.generation) return;
      if (!this.provider) {
        this.diagnose("provider.initialization.completed", {
          outcome: "failure",
          error: "Provider initialization failed; details omitted for safety.",
        });
      }
      if (userRejected(error)) {
        this.diagnose("connect.completed", { outcome: "cancelled" });
        this.setState({
          status: "cancelled",
          account: null,
          network: null,
          observedAt: null,
          error: `${this.walletName} connection was cancelled. You can retry when ready.`,
        });
      } else if (isTimeout(error)) {
        this.diagnose("connect.completed", { outcome: "timeout" });
        this.setState({
          status: "timeout",
          account: null,
          network: null,
          observedAt: null,
          error: `${this.walletName} did not finish the request before the deadline. If its dialog is still open, close it before retrying.`,
        });
      } else if (error instanceof UnsupportedWalletMethodError) {
        const message = `${this.walletName} does not support the required ${error.method} operation. RESCORA cannot verify the wallet session, so the account remains disconnected.`;
        this.diagnose("connect.completed", {
          outcome: "unsupported-provider-method",
          method: error.method,
        });
        this.setState({
          status: "unsupported-wallet",
          account: null,
          network: null,
          observedAt: null,
          error: message,
        });
      } else {
        this.diagnose("connect.completed", {
          outcome: "provider-failure",
          error: "Wallet request failed; details omitted for safety.",
        });
        this.setState({
          status: "error",
          account: null,
          network: null,
          observedAt: null,
          error: errorMessage(
            error,
            `${this.walletName} connection failed. Check that the wallet is unlocked and try again.`,
          ),
        });
      }
    } finally {
      this.flowActive = false;
      this.publish();
    }
  }

  private reportMissingAccount(): void {
    const status = this.unlockStateKnown && !this.unlocked ? "locked" : "missing-account";
    const error =
      status === "locked"
        ? `${this.walletName} reports that the wallet is locked. Unlock it, select a NEAR account, then reconnect.`
        : `${this.walletName} returned no NEAR account. Unlock the wallet and select or add a NEAR account before retrying. No account was connected.`;
    this.diagnose("account.discovery.empty", {
      locked: status === "locked",
      unlockStateKnown: this.unlockStateKnown,
    });
    this.setState({ status, account: null, network: null, observedAt: null, error });
  }

  private currentExpectedAccountEvent(): WalletAccount | null {
    return this.expectedAccountEvent;
  }

  private async verifyAccount(
    provider: WalletProvider,
    account: WalletAccount,
    operation: number,
    revision: number,
  ): Promise<void> {
    try {
      const response = await this.request<unknown>(provider, "near_verifyTestnetAccount", {
        account,
      });
      const verification = parseTestnetVerification(response);
      if (
        operation !== this.generation ||
        revision !== this.eventRevision ||
        !this.isCurrentAccount(account)
      )
        return;
      if (verification?.verified) {
        this.diagnose("identity.verification.completed", {
          accepted: true,
          reason: verification.reason,
        });
        this.diagnose("network.discovery.completed", {
          validResponse: true,
          networkId: TARGET_NETWORK,
          evidence: "testnet-account-access-key",
        });
        this.setState({
          status: "connected",
          account,
          network: { networkId: TARGET_NETWORK },
          observedAt: new Date().toISOString(),
          testnetVerificationStatus: "verified",
          testnetVerificationError: null,
        });
        return;
      }
      const reason = verification?.reason ?? "invalid-verification-response";
      const definitiveRejection = [
        "access-key-not-found",
        "account-not-found",
        "account-mismatch",
        "public-key-mismatch",
        "invalid-account-id-format",
        "invalid-public-key-format",
      ].includes(reason);
      const unavailable = !definitiveRejection;
      const message =
        verification?.message ?? "Testnet identity verification returned an invalid response.";
      this.diagnose("identity.verification.completed", { accepted: false, reason });
      this.setState({
        status: "connected",
        account,
        network: null,
        error: null,
        testnetVerificationStatus: unavailable ? "unavailable" : "rejected",
        testnetVerificationError: message,
      });
    } catch (error) {
      if (
        operation !== this.generation ||
        revision !== this.eventRevision ||
        !this.isCurrentAccount(account)
      )
        return;
      const message = isTimeout(error)
        ? "Testnet identity verification timed out. The wallet remains connected; retry verification later."
        : "Testnet identity verification is unavailable. The wallet remains connected.";
      this.diagnose("identity.verification.completed", {
        accepted: false,
        reason: isTimeout(error) ? "rpc-timeout" : "rpc-unavailable",
      });
      this.setState({
        status: "connected",
        account,
        network: null,
        error: null,
        testnetVerificationStatus: "unavailable",
        testnetVerificationError: message,
      });
    }
  }

  private isCurrentAccount(account: WalletAccount): boolean {
    return (
      this.state.status === "connected" &&
      this.state.account?.accountId === account.accountId &&
      this.state.account.publicKey === account.publicKey
    );
  }

  async disconnect(): Promise<void> {
    if (this.flowActive || this.gate.isPending) return;
    this.flowActive = true;
    const provider = this.provider;
    this.invalidate("disconnected", "Wallet disconnected; account-bound data was cleared.");
    try {
      if (provider) await this.request(provider, "near_signOut");
    } catch {
      this.diagnose("disconnect.provider_signout_failed", {
        error: "Wallet sign-out failed; details omitted for safety.",
      });
    } finally {
      this.flowActive = false;
      this.setState({
        status: "disconnected",
        account: null,
        network: null,
        observedAt: null,
        error: null,
      });
    }
  }

  private bindEvents(provider: WalletProvider): void {
    this.removeProviderEvents?.();
    const onDisconnect = () => {
      this.disconnectedInFlow = true;
      this.expectedAccountEvent = null;
      this.diagnose("wallet.event.disconnect");
      this.invalidateFromEvent(
        "disconnected",
        `${provider.name ?? "Wallet"} disconnected; account-bound data was cleared.`,
      );
    };
    const onAccountsChanged = (payload: unknown) => {
      const wasConnected = this.state.status === "connected";
      const parsed = parseAccounts(payload);
      const account = parsed?.length === 1 ? parsed[0] : null;
      this.accountEventSeen = true;
      if (!parsed) this.invalidEvent = true;
      if (parsed && parsed.length === 0) this.disconnectedInFlow = true;
      this.expectedAccountEvent = account;
      this.diagnose("wallet.event.accountsChanged", {
        validResponse: parsed !== null,
        accountCount: parsed?.length ?? 0,
      });
      this.invalidateFromEvent(
        account ? "unverified" : "disconnected",
        account
          ? `${provider.name ?? "Wallet"} account changed; checking fresh wallet identity.`
          : `${provider.name ?? "Wallet"} no longer exposes an account; account-bound data was cleared.`,
      );
      if (account && wasConnected) {
        if (this.flowActive) this.reconcileRequested = true;
        else void this.reconcile(provider);
      }
    };
    const onNetworkChanged = (payload: unknown) => {
      const network = parseNetwork(payload);
      if (!network) this.invalidEvent = true;
      this.diagnose("wallet.event.networkChanged", {
        validResponse: network !== null,
        networkId:
          typeof network?.networkId === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(network.networkId)
            ? network.networkId
            : null,
      });
      const account = this.state.account;
      if (!network || !account || this.state.status !== "connected") {
        this.invalidateFromEvent(
          "disconnected",
          `${provider.name ?? "Wallet"} network state changed before a valid account was available.`,
        );
        return;
      }
      this.eventRevision += 1;
      this.diagnose("identity.verification.restarted", { trigger: "network-changed" });
      this.setState({
        status: "connected",
        account,
        network: null,
        error: null,
        testnetVerificationStatus: "pending",
        testnetVerificationError:
          "Wallet network changed; checking the account/key pair against Testnet again.",
      });
      if (this.flowActive) this.reconcileRequested = true;
      else void this.reconcile(provider);
    };
    const onRevalidate = () => {
      if (this.flowActive || this.state.status !== "connected") return;
      this.eventRevision += 1;
      this.setState({
        network: null,
        testnetVerificationStatus: "pending",
        testnetVerificationError: null,
      });
      void this.reconcile(provider);
    };
    const onUnlockChanged = (payload: unknown) => {
      const value = asRecord(payload)?.isUnlocked;
      if (typeof value !== "boolean") {
        this.diagnose("wallet.event.unlockChanged", { validResponse: false });
        return;
      }
      this.unlockStateKnown = true;
      this.unlocked = value;
      this.diagnose("wallet.event.unlockChanged", { validResponse: true, isUnlocked: value });
      if (!value) {
        this.invalidEvent = true;
        if (this.flowActive) this.disconnectedInFlow = true;
        this.invalidateFromEvent(
          "locked",
          `${provider.name ?? "Wallet"} locked; account-bound data was cleared.`,
        );
      } else if (this.state.status === "locked") {
        this.invalidateFromEvent(
          "disconnected",
          `${provider.name ?? "Wallet"} is unlocked. Reconnect to verify the account and network.`,
        );
      }
    };
    provider.on("disconnect", onDisconnect);
    provider.on("accountsChanged", onAccountsChanged);
    provider.on("networkChanged", onNetworkChanged);
    provider.on("unlockChanged", onUnlockChanged);
    provider.on("revalidate", onRevalidate);
    this.removeProviderEvents = () => {
      provider.off("disconnect", onDisconnect as (...args: never[]) => void);
      provider.off("accountsChanged", onAccountsChanged as (...args: never[]) => void);
      provider.off("networkChanged", onNetworkChanged as (...args: never[]) => void);
      provider.off("unlockChanged", onUnlockChanged as (...args: never[]) => void);
      provider.off("revalidate", onRevalidate as (...args: never[]) => void);
    };
  }

  private invalidateFromEvent(
    status: WalletStatus,
    error: string | null = null,
    network: WalletNetwork | null = null,
  ): void {
    if (!this.flowActive) this.generation += 1;
    this.eventRevision += 1;
    this.diagnose("session.invalidated", { status });
    this.setState({ status, account: null, network, observedAt: null, error });
  }

  private async reconcile(provider: WalletProvider): Promise<void> {
    if (this.flowActive || this.gate.isPending) return;
    this.flowActive = true;
    const operation = this.generation;
    const revision = this.eventRevision;
    this.diagnose("wallet.reconcile.started");
    try {
      const accountResponse = await this.request<unknown>(provider, "near_accounts");
      const freshAccounts = parseAccounts(accountResponse);
      if (operation !== this.generation) return;
      const account = freshAccounts?.length === 1 ? freshAccounts[0] : null;
      if (revision !== this.eventRevision || operation !== this.generation) return;
      if (
        !account ||
        this.invalidEvent ||
        (this.accountEventSeen &&
          (!this.expectedAccountEvent ||
            this.expectedAccountEvent.accountId !== account.accountId ||
            this.expectedAccountEvent.publicKey !== account.publicKey))
      ) {
        this.invalidate(
          "disconnected",
          freshAccounts
            ? "Wallet event and fresh provider account could not be reconciled. Reconnect to refresh the active account."
            : accountResponseError(accountResponse, provider.name ?? "Wallet"),
        );
        return;
      }
      this.setState({
        status: "connected",
        account,
        network: null,
        observedAt: new Date().toISOString(),
        error: null,
        testnetVerificationStatus: "pending",
        testnetVerificationError: null,
      });
      this.diagnose("wallet.reconcile.completed", { outcome: "account-refreshed" });
      void this.verifyAccount(provider, account, operation, revision);
    } catch (error) {
      if (operation === this.generation) {
        this.diagnose("wallet.reconcile.failed", {
          reason: isTimeout(error) ? "account-request-timeout" : "account-request-failed",
        });
        this.invalidate(
          "disconnected",
          "Wallet account could not be refreshed. Reconnect to restore the session.",
        );
      }
    } finally {
      this.flowActive = false;
      this.publish();
      if (this.reconcileRequested) {
        this.reconcileRequested = false;
        if (this.provider && this.state.status !== "disconnected") {
          queueMicrotask(() => void this.reconcile(provider));
        }
      }
    }
  }
}
