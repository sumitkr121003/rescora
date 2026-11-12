import { describe, expect, it } from "vitest";
import { ProviderRequestGate, WalletSessionController, type WalletProvider } from "./session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeWallet() {
  const handlers = new Map<string, (payload?: unknown) => void>();
  let account = {
    accountId: "alice.testnet",
    publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
  };
  let network = { networkId: "testnet", nodeUrls: ["https://rpc.testnet.near.org"] };
  const calls: string[] = [];
  const provider = {
    detectWalletInstalled: async () => true,
    request: async ({ method }: { method: string }): Promise<unknown> => {
      calls.push(method);
      if (method === "near_requestAccounts") return { accounts: [account] };
      if (method === "near_accounts") return { accounts: [account] };
      if (method === "near_verifyTestnetAccount") {
        return network.networkId === "testnet"
          ? {
              verified: true,
              reason: "exact-account-key-pair-found-on-testnet",
              message: "The account/public-key pair was found on NEAR Testnet.",
            }
          : {
              verified: false,
              reason: "access-key-not-found",
              message: "The account/public-key pair was not found on NEAR Testnet.",
            };
      }
      if (method === "near_signOut") return undefined;
      throw new Error(`unexpected method ${method}`);
    },
    on: (event: string, listener: (payload?: unknown) => void) => {
      handlers.set(event, listener);
    },
    off: () => undefined,
  } as unknown as WalletProvider;
  return {
    provider,
    calls,
    setAccount(value: typeof account) {
      account = value;
    },
    setNetwork(value: typeof network) {
      network = value;
    },
    emit(event: string, payload?: unknown) {
      handlers.get(event)?.(payload);
    },
  };
}

describe("wallet session safety", () => {
  it("invalidates account identity on a network change", async () => {
    const wallet = fakeWallet();
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();

    wallet.emit("networkChanged", { networkId: "mainnet" });

    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "alice.testnet" },
    });
    expect(session.getSnapshot().diagnostics).toContainEqual(
      expect.objectContaining({ event: "wallet.event.networkChanged" }),
    );
  });

  it("accepts only a fresh account/key pair verified by the provider on Testnet", async () => {
    const wallet = fakeWallet();
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: {
        accountId: "alice.testnet",
        publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
      },
      testnetVerificationStatus: "pending",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot().testnetVerificationStatus).toBe("verified");
    expect(wallet.calls).toEqual([
      "near_requestAccounts",
      "near_accounts",
      "near_verifyTestnetAccount",
    ]);
  });

  it("keeps the connected wallet separate when the exact pair is absent from Testnet", async () => {
    const wallet = fakeWallet();
    wallet.setNetwork({ networkId: "mainnet", nodeUrls: ["https://rpc.mainnet.near.org"] });
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "alice.testnet" },
      network: null,
      testnetVerificationStatus: "rejected",
      testnetVerificationError: expect.stringContaining("not found on NEAR Testnet"),
    });
  });

  it("keeps the session unverified when the Testnet RPC cannot verify the pair", async () => {
    const wallet = fakeWallet();
    const request = wallet.provider.request.bind(wallet.provider);
    wallet.provider.request = async ({ method }) =>
      method === "near_verifyTestnetAccount"
        ? {
            verified: false,
            reason: "access-key-not-found",
            message: "The exact account/public-key pair was not found on NEAR Testnet.",
          }
        : request({ method });
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "alice.testnet" },
      network: null,
      testnetVerificationStatus: "rejected",
      testnetVerificationError: expect.stringContaining(
        "exact account/public-key pair was not found",
      ),
    });
    expect(wallet.calls).toContain("near_requestAccounts");
    expect(wallet.calls).toContain("near_accounts");
  });

  it("keeps the wallet connected when Testnet verification is unsupported", async () => {
    const wallet = fakeWallet();
    const request = wallet.provider.request.bind(wallet.provider);
    wallet.provider.request = async ({ method }) => {
      if (method === "near_verifyTestnetAccount") {
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      }
      return request({ method });
    };
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "alice.testnet" },
      network: null,
      testnetVerificationStatus: "unavailable",
    });
  });

  it("connects immediately while Testnet RPC verification is still pending", async () => {
    const wallet = fakeWallet();
    const pending = deferred<unknown>();
    const started = deferred<void>();
    const request = wallet.provider.request.bind(wallet.provider);
    wallet.provider.request = async ({ method, params }) => {
      if (method === "near_verifyTestnetAccount") {
        started.resolve();
        return pending.promise;
      }
      return request({ method, params });
    };
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    await started.promise;
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "alice.testnet" },
      testnetVerificationStatus: "pending",
    });
    pending.resolve({
      verified: true,
      reason: "exact-account-key-pair-found-on-testnet",
      message: "Verified.",
    });
  });

  it("leaves the wallet connected and marks all Testnet RPC endpoints unavailable", async () => {
    const wallet = fakeWallet();
    const request = wallet.provider.request.bind(wallet.provider);
    wallet.provider.request = async ({ method, params }) =>
      method === "near_verifyTestnetAccount"
        ? {
            verified: false,
            reason: "rpc-unavailable",
            message: "All Testnet RPC endpoints failed.",
          }
        : request({ method, params });
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "alice.testnet" },
      testnetVerificationStatus: "unavailable",
    });
  });

  it("keeps a connected wallet rejected when Testnet confirms a public-key mismatch", async () => {
    const wallet = fakeWallet();
    const request = wallet.provider.request.bind(wallet.provider);
    wallet.provider.request = async ({ method, params }) =>
      method === "near_verifyTestnetAccount"
        ? {
            verified: false,
            reason: "public-key-mismatch",
            message: "Testnet returned a different public key.",
          }
        : request({ method, params });
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "alice.testnet" },
      network: null,
      testnetVerificationStatus: "rejected",
    });
  });

  it("treats verifier timeouts as unavailable without disconnecting the wallet", async () => {
    const wallet = fakeWallet();
    const request = wallet.provider.request.bind(wallet.provider);
    wallet.provider.request = async ({ method, params }) =>
      method === "near_verifyTestnetAccount"
        ? Promise.reject(Object.assign(new Error("network timeout"), { code: 4500 }))
        : request({ method, params });
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "alice.testnet" },
      testnetVerificationStatus: "unavailable",
    });
  });

  it("rejects malformed account identity data before connecting", async () => {
    const wallet = fakeWallet();
    const provider = wallet.provider as WalletProvider;
    provider.request = async ({ method }) =>
      method === "near_requestAccounts" || method === "near_accounts"
        ? { accounts: [{ accountId: "alice.testnet", publicKey: "not-a-key" }] }
        : undefined;
    const session = new WalletSessionController(() => provider);
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({ status: "unverified", account: null });
    expect(wallet.calls).not.toContain("near_verifyTestnetAccount");
  });

  it("reports an empty account response with actionable guidance and permits retry", async () => {
    const wallet = fakeWallet();
    const request = wallet.provider.request.bind(wallet.provider);
    let empty = true;
    wallet.provider.request = async ({ method }) => {
      if (method === "near_requestAccounts" && empty) return { accounts: [] };
      return request({ method });
    };
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({
      status: "missing-account",
      account: null,
      error: expect.stringContaining("select or add a NEAR account"),
    });
    empty = false;
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({ status: "connected" });
  });

  it("reports a locked wallet when a provider explicitly emitted locked state", async () => {
    const wallet = fakeWallet();
    const request = wallet.provider.request.bind(wallet.provider);
    wallet.provider.request = async ({ method }) =>
      method === "near_requestAccounts" ? { accounts: [] } : request({ method });
    wallet.provider.detectWalletInstalled = async () => {
      wallet.emit("unlockChanged", { isUnlocked: false });
      return true;
    };
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({
      status: "locked",
      error: expect.stringContaining("Wallet locked"),
    });
  });

  it("distinguishes provider timeout and allows retry after the request settles", async () => {
    const wallet = fakeWallet();
    const request = wallet.provider.request.bind(wallet.provider);
    let timeout = true;
    wallet.provider.request = async ({ method }) => {
      if (method === "near_requestAccounts" && timeout) {
        await Promise.resolve();
        throw Object.assign(new Error("Provider timed out"), { code: 4500 });
      }
      return request({ method });
    };
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({ status: "timeout", account: null });
    expect(session.isBusy).toBe(false);
    timeout = false;
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({ status: "connected" });
  });

  it("does not start duplicate connection requests while one is active", async () => {
    const wallet = fakeWallet();
    const pending = deferred<unknown>();
    let started!: () => void;
    let requestCount = 0;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const request = wallet.provider.request.bind(wallet.provider);
    wallet.provider.request = ({ method }) => {
      if (method === "near_requestAccounts") {
        requestCount += 1;
        started();
        return pending.promise;
      }
      return request({ method });
    };
    const session = new WalletSessionController(() => wallet.provider);
    const first = session.connect();
    await requestStarted;
    await session.connect();
    expect(requestCount).toBe(1);
    pending.resolve({
      accounts: [
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
        },
      ],
    });
    await first;
    expect(session.getSnapshot()).toMatchObject({ status: "connected" });
  });

  it("does not restore a timed-out session from a late provider response", async () => {
    const wallet = fakeWallet();
    const pending = deferred<unknown>();
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    wallet.provider.request = ({ method }) => {
      if (method === "near_requestAccounts") {
        started();
        return pending.promise;
      }
      return Promise.resolve(null);
    };
    const session = new WalletSessionController(() => wallet.provider, { requestTimeoutMs: 5 });
    await session.connect();
    await requestStarted;
    expect(session.getSnapshot()).toMatchObject({ status: "timeout", account: null });
    pending.resolve({
      accounts: [
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.getSnapshot()).toMatchObject({ status: "timeout", account: null });
  });

  it("reports an unavailable wallet without asking for account access", async () => {
    const wallet = fakeWallet();
    wallet.provider.detectWalletInstalled = async () => false;
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({
      status: "unavailable",
      account: null,
      network: null,
    });
    expect(wallet.calls).toEqual([]);
  });

  it("reports provider initialization failure and allows a clean retry", async () => {
    const wallet = fakeWallet();
    let failInitialization = true;
    const session = new WalletSessionController(() => {
      if (failInitialization) throw new Error("Provider initialization failed");
      return wallet.provider;
    });
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({ status: "error", account: null });
    expect(session.getSnapshot().diagnostics).toContainEqual(
      expect.objectContaining({
        event: "provider.initialization.completed",
        details: expect.objectContaining({ outcome: "failure" }),
      }),
    );
    failInitialization = false;
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({ status: "connected" });
  });

  it("treats a rejected account-only prompt as cancellation", async () => {
    const wallet = fakeWallet();
    const request = wallet.provider.request.bind(wallet.provider);
    wallet.provider.request = async ({ method }) => {
      if (method === "near_requestAccounts")
        throw Object.assign(new Error("Rejected"), { code: 4001 });
      return request({ method });
    };
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({
      status: "cancelled",
      account: null,
      network: null,
    });
  });

  it("allows a clean retry after user cancellation", async () => {
    const wallet = fakeWallet();
    const request = wallet.provider.request.bind(wallet.provider);
    let cancel = true;
    wallet.provider.request = async ({ method }) => {
      if (method === "near_requestAccounts" && cancel) {
        cancel = false;
        throw Object.assign(new Error("Rejected"), { code: 4001 });
      }
      return request({ method });
    };
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({ status: "cancelled" });
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({ status: "connected" });
  });

  it("does not restore state after disconnect during connection", async () => {
    const wallet = fakeWallet();
    const pending = deferred<unknown>();
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const provider = wallet.provider as WalletProvider;
    provider.request = async ({ method }) => {
      if (method === "near_requestAccounts") {
        requestStarted();
        return pending.promise;
      }
      return null;
    };
    const session = new WalletSessionController(() => provider);
    const connecting = session.connect();
    await started;
    wallet.emit("disconnect");
    pending.resolve({
      accounts: [
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
        },
      ],
    });
    await connecting;
    expect(session.getSnapshot()).toMatchObject({
      status: "disconnected",
      account: null,
      network: null,
    });
    expect(wallet.calls).not.toContain("near_accounts");
    expect(wallet.calls).not.toContain("near_verifyTestnetAccount");
  });

  it("keeps an account event conflicting with fresh provider data unverified", async () => {
    const wallet = fakeWallet();
    const pending = deferred<unknown>();
    const provider = wallet.provider as WalletProvider;
    const request = provider.request.bind(provider);
    provider.request = async ({ method }) =>
      method === "near_requestAccounts" ? pending.promise : request({ method });
    const session = new WalletSessionController(() => provider);
    const connecting = session.connect();
    await Promise.resolve();
    const changedAccount = {
      accountId: "bob.testnet",
      publicKey: "ed25519:5qT71w3baQV4FzRRnWcc2oxSTvZc4x2jHc7wEDySMnN6",
    };
    wallet.setAccount(changedAccount);
    wallet.emit("accountsChanged", { accounts: [changedAccount] });
    pending.resolve({
      accounts: [
        {
          accountId: "bob.testnet",
          publicKey: "ed25519:5qT71w3baQV4FzRRnWcc2oxSTvZc4x2jHc7wEDySMnN6",
        },
      ],
    });
    await connecting;
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "bob.testnet" },
    });
  });

  it("keeps a valid wallet connected across a network event and rechecks the Testnet pair", async () => {
    const wallet = fakeWallet();
    const pending = deferred<unknown>();
    const provider = wallet.provider as WalletProvider;
    const request = provider.request.bind(provider);
    provider.request = async ({ method }) =>
      method === "near_requestAccounts" ? pending.promise : request({ method });
    const session = new WalletSessionController(() => provider);
    const connecting = session.connect();
    await Promise.resolve();
    wallet.emit("networkChanged", { networkId: "mainnet" });
    pending.resolve({
      accounts: [
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
        },
      ],
    });
    await connecting;
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "alice.testnet" },
      network: null,
    });
  });

  it("rejects matching account IDs with conflicting event public keys", async () => {
    const wallet = fakeWallet();
    const pending = deferred<unknown>();
    const provider = wallet.provider as WalletProvider;
    const request = provider.request.bind(provider);
    provider.request = async ({ method }) =>
      method === "near_requestAccounts" ? pending.promise : request({ method });
    const session = new WalletSessionController(() => provider);
    const connecting = session.connect();
    await Promise.resolve();
    wallet.emit("accountsChanged", {
      accounts: [
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:5qT71w3baQV4FzRRnWcc2oxSTvZc4x2jHc7wEDySMnN6",
        },
      ],
    });
    pending.resolve({
      accounts: [
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
        },
      ],
    });
    await connecting;
    expect(session.getSnapshot()).toMatchObject({
      status: "disconnected",
      account: null,
      network: null,
    });
  });

  it("reconciles an account change against fresh account and network responses", async () => {
    const wallet = fakeWallet();
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    const changedAccount = {
      accountId: "bob.testnet",
      publicKey: "ed25519:5qT71w3baQV4FzRRnWcc2oxSTvZc4x2jHc7wEDySMnN6",
    };
    wallet.setAccount(changedAccount);
    wallet.emit("accountsChanged", { accounts: [changedAccount] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: changedAccount,
      network: { networkId: "testnet" },
    });
  });

  it("rejects a stale Testnet verification if the account changes while verification is pending", async () => {
    const wallet = fakeWallet();
    const pendingVerification = deferred<unknown>();
    let verificationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      verificationStarted = resolve;
    });
    let deferVerification = false;
    const request = wallet.provider.request.bind(wallet.provider);
    wallet.provider.request = async ({ method, params }) => {
      if (method === "near_verifyTestnetAccount" && deferVerification) {
        verificationStarted();
        return pendingVerification.promise;
      }
      return request({ method, params });
    };
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    deferVerification = true;
    const changedAccount = {
      accountId: "bob.testnet",
      publicKey: "ed25519:5qT71w3baQV4FzRRnWcc2oxSTvZc4x2jHc7wEDySMnN6",
    };
    wallet.setAccount(changedAccount);
    wallet.emit("accountsChanged", { accounts: [changedAccount] });
    await started;
    wallet.emit("accountsChanged", {
      accounts: [
        {
          accountId: "carol.testnet",
          publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
        },
      ],
    });
    pendingVerification.resolve({
      verified: true,
      reason: "exact-account-key-pair-found-on-testnet",
      message: "The account/public-key pair was found on NEAR Testnet.",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot()).toMatchObject({ status: "disconnected", account: null });
  });

  it("invalidates on a runtime network switch and revalidates when back on testnet", async () => {
    const wallet = fakeWallet();
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    wallet.setNetwork({ networkId: "mainnet", nodeUrls: ["https://rpc.mainnet.near.org"] });
    wallet.emit("networkChanged", { networkId: "mainnet" });
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "alice.testnet" },
      network: null,
      testnetVerificationStatus: "pending",
    });
    wallet.setNetwork({ networkId: "testnet", nodeUrls: ["https://rpc.testnet.near.org"] });
    wallet.emit("networkChanged", { networkId: "testnet" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      network: { networkId: "testnet" },
      testnetVerificationStatus: "verified",
    });
  });

  it("serializes timed-out requests until their underlying promise settles", async () => {
    const wallet = fakeWallet();
    const pending = deferred<unknown>();
    wallet.provider.request = (() => pending.promise) as WalletProvider["request"];
    const gate = new ProviderRequestGate();
    await expect(gate.request(wallet.provider, "near_accounts", 1)).rejects.toThrow(/timed out/i);
    await expect(gate.request(wallet.provider, "near_verifyTestnetAccount", 1)).rejects.toThrow(
      /still pending/i,
    );
    expect(gate.isPending).toBe(true);
    pending.resolve({ accounts: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(gate.isPending).toBe(false);
  });

  it("clears identity on sign-out", async () => {
    const wallet = fakeWallet();
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    await session.disconnect();
    expect(session.getSnapshot()).toMatchObject({
      status: "disconnected",
      account: null,
      network: null,
    });
  });
});
