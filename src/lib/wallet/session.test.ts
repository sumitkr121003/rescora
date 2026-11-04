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
  let account = { accountId: "alice.testnet", publicKey: "ed25519:abc" };
  let network = { networkId: "testnet", nodeUrls: ["https://rpc.testnet.near.org"] };
  const calls: string[] = [];
  const provider = {
    detectWalletInstalled: async () => true,
    request: async ({ method }: { method: string }): Promise<unknown> => {
      calls.push(method);
      if (method === "near_requestAccounts") return { accounts: [account] };
      if (method === "near_accounts") return { accounts: [account] };
      if (method === "near_networkInfo") return network;
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
  it("accepts only fresh testnet account and network data", async () => {
    const wallet = fakeWallet();
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "alice.testnet", publicKey: "ed25519:abc" },
      network: { networkId: "testnet" },
    });
    expect(wallet.calls).toEqual(["near_requestAccounts", "near_accounts", "near_networkInfo"]);
  });

  it("rejects the provider-reported mainnet even when target config is testnet", async () => {
    const wallet = fakeWallet();
    wallet.setNetwork({ networkId: "mainnet", nodeUrls: ["https://rpc.mainnet.near.org"] });
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({
      status: "unsupported-network",
      account: null,
      network: null,
    });
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
    pending.resolve({ accounts: [{ accountId: "alice.testnet", publicKey: "ed25519:abc" }] });
    await connecting;
    expect(session.getSnapshot()).toMatchObject({
      status: "disconnected",
      account: null,
      network: null,
    });
    expect(wallet.calls).not.toContain("near_accounts");
    expect(wallet.calls).not.toContain("near_networkInfo");
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
    const changedAccount = { accountId: "bob.testnet", publicKey: "ed25519:def" };
    wallet.setAccount(changedAccount);
    wallet.emit("accountsChanged", { accounts: [changedAccount] });
    pending.resolve({ accounts: [{ accountId: "bob.testnet", publicKey: "ed25519:def" }] });
    await connecting;
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: { accountId: "bob.testnet" },
    });
  });

  it("rejects a mainnet network event even when the next provider read says testnet", async () => {
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
    pending.resolve({ accounts: [{ accountId: "alice.testnet", publicKey: "ed25519:abc" }] });
    await connecting;
    expect(session.getSnapshot()).toMatchObject({
      status: "unverified",
      account: null,
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
      accounts: [{ accountId: "alice.testnet", publicKey: "ed25519:wrong" }],
    });
    pending.resolve({ accounts: [{ accountId: "alice.testnet", publicKey: "ed25519:abc" }] });
    await connecting;
    expect(session.getSnapshot()).toMatchObject({
      status: "unverified",
      account: null,
      network: null,
    });
  });

  it("reconciles an account change against fresh account and network responses", async () => {
    const wallet = fakeWallet();
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    const changedAccount = { accountId: "bob.testnet", publicKey: "ed25519:def" };
    wallet.setAccount(changedAccount);
    wallet.emit("accountsChanged", { accounts: [changedAccount] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      account: changedAccount,
      network: { networkId: "testnet" },
    });
  });

  it("invalidates on a runtime network switch and revalidates when back on testnet", async () => {
    const wallet = fakeWallet();
    const session = new WalletSessionController(() => wallet.provider);
    await session.connect();
    wallet.setNetwork({ networkId: "mainnet", nodeUrls: ["https://rpc.mainnet.near.org"] });
    wallet.emit("networkChanged", { networkId: "mainnet" });
    expect(session.getSnapshot()).toMatchObject({
      status: "unsupported-network",
      account: null,
      network: null,
    });
    wallet.setNetwork({ networkId: "testnet", nodeUrls: ["https://rpc.testnet.near.org"] });
    wallet.emit("networkChanged", { networkId: "testnet" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot()).toMatchObject({
      status: "connected",
      network: { networkId: "testnet" },
    });
  });

  it("serializes timed-out requests until their underlying promise settles", async () => {
    const wallet = fakeWallet();
    const pending = deferred<unknown>();
    wallet.provider.request = (() => pending.promise) as WalletProvider["request"];
    const gate = new ProviderRequestGate();
    await expect(gate.request(wallet.provider, "near_accounts", 1)).rejects.toThrow(/timed out/i);
    await expect(gate.request(wallet.provider, "near_networkInfo", 1)).rejects.toThrow(
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
