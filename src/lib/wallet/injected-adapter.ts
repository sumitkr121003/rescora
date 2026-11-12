import type { WalletAccount, WalletProvider } from "./session";

type InjectedWallet = {
  id?: unknown;
  network?: unknown;
  accounts?: unknown;
  connect?: (params: { networkId: "testnet" }) => Promise<unknown>;
  disconnect?: () => Promise<void>;
  on?: (event: "accountsChanged", listener: (payload: unknown) => void) => (() => void) | void;
  off?: (event: "accountsChanged", listener: (payload: unknown) => void) => void;
};

export type DiscoveredWallet = Readonly<{ id: string; name: string; create: () => WalletProvider }>;

function isWallet(value: unknown): value is InjectedWallet {
  if (typeof value !== "object" || value === null) return false;
  const wallet = value as InjectedWallet;
  return typeof wallet.connect === "function" && typeof wallet.disconnect === "function";
}

function toAccounts(value: unknown): WalletAccount[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const account = item as { accountId?: unknown; publicKey?: unknown };
    if (typeof account.accountId !== "string" || !account.accountId) return [];
    const publicKey =
      typeof account.publicKey === "string" ? account.publicKey : String(account.publicKey ?? "");
    return publicKey ? [{ accountId: account.accountId, publicKey }] : [];
  });
}

/** Discovers only NEP-408-style injected wallets that report their own network. */
export function discoverInjectedWallets(): DiscoveredWallet[] {
  if (typeof window === "undefined") return [];
  const near = (window as Window & { near?: Record<string, unknown> }).near;
  if (!near || typeof near !== "object") return [];
  return Object.entries(near).flatMap(([key, candidate]) => {
    if (!isWallet(candidate) || typeof candidate.network !== "object" || candidate.network === null)
      return [];
    const reportedId = typeof candidate.id === "string" ? candidate.id : key;
    return [
      { id: `injected:${key}`, name: reportedId, create: () => createInjectedProvider(candidate) },
    ];
  });
}

function createInjectedProvider(wallet: InjectedWallet): WalletProvider {
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  const accountListener = (payload: unknown) => {
    const record = payload as { accounts?: unknown } | null;
    emit("accountsChanged", { accounts: toAccounts(record?.accounts) });
  };
  const emit = (event: string, payload?: unknown) =>
    listeners.get(event)?.forEach((listener) => listener(payload));
  const unsubscribe = wallet.on?.("accountsChanged", accountListener);
  const onFocus = () => emit("networkChanged", wallet.network);
  const poll = typeof window !== "undefined" ? window.setInterval(onFocus, 2_000) : undefined;
  if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
  return {
    name: typeof wallet.id === "string" ? wallet.id : "NEAR injected wallet",
    detectWalletInstalled: async () => true,
    request: async ({ method }) => {
      if (method === "near_requestAccounts")
        return { accounts: toAccounts(await wallet.connect!({ networkId: "testnet" })) };
      if (method === "near_accounts") return { accounts: toAccounts(wallet.accounts) };
      if (method === "near_networkInfo") {
        const network = wallet.network as { networkId?: unknown; nodeUrl?: unknown } | null;
        if (!network || typeof network.networkId !== "string") return network;
        return {
          networkId: network.networkId,
          ...(typeof network.nodeUrl === "string" ? { nodeUrls: [network.nodeUrl] } : {}),
        };
      }
      if (method === "near_signOut") return wallet.disconnect!();
      throw Object.assign(new Error(`Unsupported injected wallet request: ${method}`), {
        code: -32601,
      });
    },
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener as (payload?: unknown) => void);
      if (event === "accountsChanged") {
        if (typeof unsubscribe === "function") unsubscribe();
        else wallet.off?.("accountsChanged", accountListener);
      }
      if (event === "networkChanged" && typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
        if (poll !== undefined) window.clearInterval(poll);
      }
    },
  };
}
