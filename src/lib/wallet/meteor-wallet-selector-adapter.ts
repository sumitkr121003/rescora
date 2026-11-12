import type {
  Account as SelectorAccount,
  WalletModuleFactory,
  WalletSelector,
  WalletSelectorEvents,
} from "@near-wallet-selector/core";
import {
  isNearAccountId,
  isNearPublicKey,
  TESTNET_IDENTITY_RPC_ENDPOINTS,
} from "@/lib/near-rpc/client";
import { logWalletDebug } from "./diagnostics";
import type { WalletProvider, WalletProviderEvent, WalletTestnetVerification } from "./session";

export const METEOR_WALLET_ID = "meteor-wallet" as const;
export const METEOR_WALLET_SELECTOR_NETWORK = "testnet" as const;
export const TESTNET_RPC_ENDPOINT = TESTNET_IDENTITY_RPC_ENDPOINTS[0];
const TESTNET_VERIFICATION_ROUTE = "/api/wallet/verify-testnet-account";

const ALLOWED_METHODS = new Set([
  "near_requestAccounts",
  "near_accounts",
  "near_verifyTestnetAccount",
  "near_signOut",
]);

type MeteorWallet = {
  signIn(params: { contractId?: string; methodNames?: string[] }): Promise<SelectorAccount[]>;
  signOut(): Promise<void>;
  getAccounts(): Promise<SelectorAccount[]>;
};

function verificationFailure(reason: string, message: string): WalletTestnetVerification {
  return { verified: false, reason, message };
}

function accountList(accounts: readonly SelectorAccount[]): {
  accounts: readonly SelectorAccount[];
} {
  return { accounts };
}

function safeAccounts(accounts: readonly SelectorAccount[]): SelectorAccount[] {
  return accounts.map((account) => ({
    accountId: typeof account?.accountId === "string" ? account.accountId : "",
    ...(typeof account?.publicKey === "string" ? { publicKey: account.publicKey } : {}),
  }));
}

function sameAccounts(
  left: readonly SelectorAccount[],
  right: readonly SelectorAccount[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (account, index) =>
        account.accountId === right[index]?.accountId &&
        account.publicKey === right[index]?.publicKey,
    )
  );
}

function logAccountResponse(source: string, accounts: readonly SelectorAccount[]): void {
  logWalletDebug("meteor.account-response", {
    source,
    accountCount: accounts.length,
    accountChecks: accounts.map((account) => ({
      accountIdReturned: typeof account.accountId === "string" && account.accountId.length > 0,
      accountIdFormatValid:
        typeof account.accountId === "string" && isNearAccountId(account.accountId),
      publicKeyReturned: typeof account.publicKey === "string" && account.publicKey.length > 0,
      publicKeyFormatValid:
        typeof account.publicKey === "string" && isNearPublicKey(account.publicKey),
    })),
  });
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "RPC_ERROR";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "RPC_ERROR";
}

function rpcFailure(error: unknown): WalletTestnetVerification {
  const code = errorCode(error);
  const reason =
    code === "TIMEOUT"
      ? "rpc-timeout"
      : code === "ACCESS_KEY_NOT_FOUND"
        ? "access-key-not-found"
        : code === "ACCOUNT_NOT_FOUND"
          ? "account-not-found"
          : code === "ACCOUNT_MISMATCH"
            ? "account-mismatch"
            : code === "PUBLIC_KEY_MISMATCH"
              ? "public-key-mismatch"
              : code === "INVALID_ACCOUNT_ID"
                ? "invalid-account-id-format"
                : code === "INVALID_REQUEST"
                  ? "invalid-public-key-format"
                  : code === "MALFORMED_RESPONSE"
                    ? "malformed-rpc-response"
                    : code === "NETWORK_FAILURE" || code === "HTTP_ERROR"
                      ? "rpc-unavailable"
                      : "rpc-error";
  const message =
    reason === "rpc-timeout"
      ? "NEAR Testnet RPC timed out while verifying the account. Check the connection and retry."
      : reason === "access-key-not-found"
        ? "The exact account/public-key pair was not found on NEAR Testnet. Select a Testnet account in Meteor and reconnect."
        : reason === "account-not-found"
          ? "The selected account was not found on NEAR Testnet. Select a Testnet account in Meteor and reconnect."
          : reason === "account-mismatch"
            ? "NEAR Testnet RPC returned a different account than Meteor selected. Reconnect to refresh the wallet identity."
            : reason === "public-key-mismatch"
              ? "NEAR Testnet RPC returned a different public key than Meteor selected. Reconnect to refresh the wallet identity."
              : reason === "invalid-account-id-format"
                ? "The returned account ID is not valid for NEAR. Select a valid NEAR account and reconnect."
                : reason === "invalid-public-key-format"
                  ? "The returned public key is malformed or unsupported. Select another account or reconnect."
                  : reason === "malformed-rpc-response"
                    ? "NEAR Testnet RPC returned an invalid access-key response. Retry after checking the RPC connection."
                    : reason === "rpc-unavailable"
                      ? "NEAR Testnet RPC could not be reached. Check the connection and retry."
                      : "NEAR Testnet RPC could not verify the account/public-key pair. Retry; the account remains disconnected.";
  logWalletDebug("identity.verification.rejected", { reason, rpcErrorCode: code });
  return verificationFailure(reason, message);
}

export async function verifyTestnetIdentityViaServer(
  accountId: string,
  publicKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetchImpl(TESTNET_VERIFICATION_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId, publicKey }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    throw Object.assign(
      new Error(
        timeout ? "Testnet identity verification timed out." : "Verification service unavailable.",
      ),
      { code: timeout ? "TIMEOUT" : "NETWORK_FAILURE" },
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw Object.assign(new Error("Verification service returned an invalid response."), {
      code: "MALFORMED_RESPONSE",
    });
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw Object.assign(new Error("Verification service returned an invalid response."), {
      code: "MALFORMED_RESPONSE",
    });
  }
  const body = result as Record<string, unknown>;
  const allowedHosts = new Set(
    TESTNET_IDENTITY_RPC_ENDPOINTS.map((endpoint) => new URL(endpoint).hostname),
  );
  if (Array.isArray(body.attempts)) {
    for (const attempt of body.attempts) {
      if (typeof attempt !== "object" || attempt === null || Array.isArray(attempt)) continue;
      const item = attempt as Record<string, unknown>;
      if (
        typeof item.endpoint !== "string" ||
        !allowedHosts.has(item.endpoint) ||
        (item.outcome !== "verified" && item.outcome !== "failed")
      ) {
        continue;
      }
      logWalletDebug("identity.rpc.endpoint.completed", {
        endpoint: item.endpoint,
        outcome: item.outcome,
        ...(typeof item.code === "string" ? { failureCode: item.code } : {}),
        ...(typeof item.httpStatus === "number" ? { httpStatus: item.httpStatus } : {}),
        ...(typeof item.rpcCode === "number" || typeof item.rpcCode === "string"
          ? { rpcCode: item.rpcCode }
          : {}),
        ...(typeof item.transportFailureKind === "string"
          ? { transportFailureKind: item.transportFailureKind }
          : {}),
        ...(typeof item.elapsedMs === "number" ? { elapsedMs: item.elapsedMs } : {}),
      });
    }
  }
  if (response.ok && body.verified === true) {
    const verifiedEndpoint =
      typeof body.verifiedEndpoint === "string" && allowedHosts.has(body.verifiedEndpoint)
        ? body.verifiedEndpoint
        : "unknown";
    logWalletDebug("identity.rpc.failover.completed", {
      outcome: "verified",
      verifiedEndpoint,
    });
    return true;
  }
  if (response.ok && body.verified === false && body.code === "ACCESS_KEY_NOT_FOUND") {
    logWalletDebug("identity.rpc.failover.completed", {
      outcome: "rejected",
      failureCode: "ACCESS_KEY_NOT_FOUND",
    });
    return false;
  }

  const allowedCodes = new Set([
    "TIMEOUT",
    "NETWORK_FAILURE",
    "HTTP_ERROR",
    "RPC_ERROR",
    "MALFORMED_RESPONSE",
    "ACCOUNT_NOT_FOUND",
    "ACCOUNT_MISMATCH",
    "PUBLIC_KEY_MISMATCH",
  ]);
  const code =
    typeof body.code === "string" && allowedCodes.has(body.code) ? body.code : "HTTP_ERROR";
  logWalletDebug("identity.rpc.failover.completed", {
    outcome: "rejected",
    failureCode: code,
  });
  throw Object.assign(new Error("Testnet identity verification failed."), { code });
}

export function createMeteorWalletSelectorProviderAdapter(
  selector: WalletSelector,
  verifyAccessKey: (accountId: string, publicKey: string) => Promise<boolean>,
): WalletProvider {
  const listeners = new Map<WalletProviderEvent, Set<(payload?: unknown) => void>>();
  let activeWallet: MeteorWallet | null = null;
  let latestAccounts: readonly SelectorAccount[] = [];
  let lifecycleRevision = 0;
  let networkRevision = 0;

  const emit = (event: WalletProviderEvent, payload?: unknown) => {
    listeners.get(event)?.forEach((listener) => listener(payload));
  };
  const onSignedIn = (event: WalletSelectorEvents["signedIn"]) => {
    if (event.walletId !== METEOR_WALLET_ID) return;
    const accounts = safeAccounts(event.accounts);
    if (accounts.length === 0 || sameAccounts(latestAccounts, accounts)) return;
    latestAccounts = accounts;
    logAccountResponse("selector:signedIn", accounts);
    emit("accountsChanged", accountList(accounts));
  };
  const onSignedOut = (event: WalletSelectorEvents["signedOut"]) => {
    if (event.walletId !== METEOR_WALLET_ID) return;
    const wasConnected = activeWallet !== null || latestAccounts.length > 0;
    lifecycleRevision += 1;
    latestAccounts = [];
    activeWallet = null;
    if (wasConnected) emit("disconnect");
  };
  const onAccountsChanged = (event: WalletSelectorEvents["accountsChanged"]) => {
    if (event.walletId !== METEOR_WALLET_ID) return;
    const accounts = safeAccounts(event.accounts);
    // Wallet Selector can emit transient empty/duplicate events; signedOut is the
    // authoritative disconnect signal. Do not discard a verified identity on empty events.
    if (accounts.length === 0 || sameAccounts(latestAccounts, accounts)) return;
    latestAccounts = accounts;
    logAccountResponse("selector:accountsChanged", accounts);
    emit("accountsChanged", accountList(accounts));
  };
  const onNetworkChanged = (event: WalletSelectorEvents["networkChanged"]) => {
    if (event.walletId !== METEOR_WALLET_ID) return;
    networkRevision += 1;
    latestAccounts = [];
    const networkId = /^[A-Za-z0-9_-]{1,32}$/.test(event.networkId) ? event.networkId : "unknown";
    logWalletDebug("meteor.network-changed", {
      networkId,
    });
    emit("networkChanged", { networkId });
  };
  const subscriptions = [
    selector.on("signedIn", onSignedIn),
    selector.on("signedOut", onSignedOut),
    selector.on("accountsChanged", onAccountsChanged),
    selector.on("networkChanged", onNetworkChanged),
  ];

  const revalidateOnFocus = () => emit("revalidate");
  if (typeof window !== "undefined") {
    window.addEventListener("focus", revalidateOnFocus);
    document.addEventListener("visibilitychange", revalidateOnFocus);
  }

  const provider: WalletProvider = {
    name: "Meteor Wallet",
    version: "Wallet Selector 10.1.4",
    detectWalletInstalled: async () =>
      selector.store.getState().modules.some((module) => module.id === METEOR_WALLET_ID),
    request: async ({ method, params }) => {
      if (!ALLOWED_METHODS.has(method)) {
        throw Object.assign(new Error("Unsupported wallet operation."), { code: -32601 });
      }

      if (method === "near_requestAccounts") {
        const requestRevision = lifecycleRevision;
        const wallet = (await selector.wallet(METEOR_WALLET_ID)) as MeteorWallet;
        if (requestRevision !== lifecycleRevision) return accountList([]);
        activeWallet = wallet;
        latestAccounts = [];
        // This is the only sign-in operation. No function-call key options are configured.
        const signedInAccounts = safeAccounts(await wallet.signIn({}));
        if (requestRevision !== lifecycleRevision || activeWallet !== wallet)
          return accountList([]);
        logAccountResponse("wallet.signIn", signedInAccounts);
        const accounts = safeAccounts(await wallet.getAccounts());
        if (requestRevision !== lifecycleRevision || activeWallet !== wallet)
          return accountList([]);
        latestAccounts = accounts;
        logAccountResponse("wallet.getAccounts", accounts);
        return accountList(accounts);
      }

      if (method === "near_accounts") {
        if (!activeWallet) return accountList([]);
        const requestRevision = lifecycleRevision;
        const wallet = activeWallet;
        const accounts = safeAccounts(await wallet.getAccounts());
        if (requestRevision !== lifecycleRevision || activeWallet !== wallet)
          return accountList([]);
        latestAccounts = accounts;
        logAccountResponse("wallet.getAccounts", accounts);
        return accountList(accounts);
      }

      if (method === "near_verifyTestnetAccount") {
        const account =
          typeof params === "object" && params !== null
            ? (params as { account?: { accountId?: unknown; publicKey?: unknown } }).account
            : undefined;
        if (
          !account ||
          typeof account.accountId !== "string" ||
          !account.accountId ||
          typeof account.publicKey !== "string" ||
          !account.publicKey
        ) {
          return verificationFailure(
            !account || typeof account.accountId !== "string" || !account.accountId
              ? "missing-account-id"
              : "missing-public-key",
            !account || typeof account.accountId !== "string" || !account.accountId
              ? "Meteor Wallet Selector did not return an account ID. Unlock Meteor and reconnect."
              : "Meteor Wallet Selector did not return a public key. Unlock Meteor and select an account with an available key.",
          );
        }
        if (!isNearAccountId(account.accountId)) {
          return verificationFailure(
            "invalid-account-id-format",
            "Meteor returned an invalid NEAR account ID. Select a valid account and reconnect.",
          );
        }
        if (!isNearPublicKey(account.publicKey)) {
          return verificationFailure(
            "invalid-public-key-format",
            "Meteor returned a malformed or unsupported public key. Reconnect to try again.",
          );
        }
        if (
          !latestAccounts.some(
            (latest) =>
              latest.accountId === account.accountId && latest.publicKey === account.publicKey,
          )
        ) {
          return verificationFailure(
            "account-key-mismatch",
            "Meteor's selected account or public key changed before Testnet verification. Reconnect to refresh the wallet identity.",
          );
        }

        const requestNetworkRevision = networkRevision;
        try {
          const verified = await verifyAccessKey(account.accountId, account.publicKey);
          if (requestNetworkRevision !== networkRevision) {
            return verificationFailure(
              "network-changed-during-verification",
              "Meteor reported a network change during verification. Reconnect and verify the account again.",
            );
          }
          if (
            !latestAccounts.some(
              (latest) =>
                latest.accountId === account.accountId && latest.publicKey === account.publicKey,
            )
          ) {
            return verificationFailure(
              "account-changed-during-verification",
              "Meteor's selected account changed during Testnet verification. Reconnect to refresh the wallet identity.",
            );
          }
          return verified
            ? {
                verified: true,
                reason: "exact-account-key-pair-found-on-testnet",
                message: "The account/public-key pair was found on NEAR Testnet.",
              }
            : verificationFailure(
                "access-key-not-found",
                "The exact account/public-key pair was not found on NEAR Testnet. Select a Testnet account in Meteor and reconnect.",
              );
        } catch (error) {
          return rpcFailure(error);
        }
      }

      const wallet = activeWallet;
      lifecycleRevision += 1;
      latestAccounts = [];
      activeWallet = null;
      if (wallet) await wallet.signOut();
      return undefined;
    },
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener as (payload?: unknown) => void);
    },
    dispose: () => {
      subscriptions.forEach((subscription) => subscription.remove());
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", revalidateOnFocus);
        document.removeEventListener("visibilitychange", revalidateOnFocus);
      }
      lifecycleRevision += 1;
      latestAccounts = [];
      activeWallet = null;
      listeners.clear();
    },
  };
  return provider;
}

export function createMeteorWalletSelectorOptions(setupMeteorWallet: () => WalletModuleFactory) {
  return {
    network: METEOR_WALLET_SELECTOR_NETWORK,
    modules: [setupMeteorWallet()],
    debug: false,
    optimizeWalletOrder: false,
    randomizeWalletOrder: false,
  };
}

export async function createMeteorWalletSelectorProvider(): Promise<WalletProvider> {
  const [{ setupWalletSelector }, { setupMeteorWallet }] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/meteor-wallet"),
  ]);
  const selector = await setupWalletSelector(createMeteorWalletSelectorOptions(setupMeteorWallet));
  return createMeteorWalletSelectorProviderAdapter(selector, (accountId, publicKey) =>
    verifyTestnetIdentityViaServer(accountId, publicKey),
  );
}
