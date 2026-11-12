import { describe, expect, it, vi } from "vitest";
import type {
  Account,
  WalletModuleFactory,
  WalletSelector,
  WalletSelectorEvents,
} from "@near-wallet-selector/core";
import {
  createMeteorWalletSelectorProviderAdapter,
  createMeteorWalletSelectorOptions,
  METEOR_WALLET_ID,
  METEOR_WALLET_SELECTOR_NETWORK,
  verifyTestnetIdentityViaServer,
} from "./meteor-wallet-selector-adapter";

const ALICE = {
  accountId: "alice.testnet",
  publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
} satisfies Account;
const BOB = {
  accountId: "bob.testnet",
  publicKey: "ed25519:5qT71w3baQV4FzRRnWcc2oxSTvZc4x2jHc7wEDySMnN6",
} satisfies Account;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeSelector(initialAccounts: Account[] = [ALICE]) {
  const handlers = new Map<keyof WalletSelectorEvents, (event: never) => void>();
  let accounts = initialAccounts;
  const wallet = {
    signIn: vi.fn(async () => accounts),
    getAccounts: vi.fn(async () => accounts),
    signOut: vi.fn(async () => undefined),
    verifyOwner: vi.fn(),
    signMessage: vi.fn(),
    signAndSendTransaction: vi.fn(),
    signAndSendTransactions: vi.fn(),
    createSignedTransaction: vi.fn(),
  };
  const selector = {
    store: { getState: () => ({ modules: [{ id: METEOR_WALLET_ID }] }) },
    wallet: vi.fn(async () => wallet),
    on: vi.fn((event: keyof WalletSelectorEvents, listener: (event: never) => void) => {
      handlers.set(event, listener);
      return { remove: vi.fn(() => handlers.delete(event)) };
    }),
  } as unknown as WalletSelector;
  return {
    selector,
    wallet,
    setAccounts(next: Account[]) {
      accounts = next;
    },
    emit<K extends keyof WalletSelectorEvents>(event: K, payload: WalletSelectorEvents[K]) {
      handlers.get(event)?.(payload as never);
    },
  };
}

describe("Meteor Wallet Selector provider adapter", () => {
  it("invokes the browser verifier fetch with the globalThis receiver", async () => {
    const fetchImpl = function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({ verified: true }));
    } as typeof fetch;

    await expect(
      verifyTestnetIdentityViaServer(ALICE.accountId, ALICE.publicKey, fetchImpl),
    ).resolves.toBe(true);
  });

  it("uses RESCORA's same-origin verifier and fails closed on a service error", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/wallet/verify-testnet-account");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        accountId: ALICE.accountId,
        publicKey: ALICE.publicKey,
      });
      return Response.json({
        verified: true,
        verifiedEndpoint: "rpc.testnet.fastnear.com",
        attempts: [
          {
            endpoint: "rpc.testnet.near.org",
            outcome: "failed",
            code: "NETWORK_FAILURE",
            elapsedMs: 4_000,
          },
          { endpoint: "rpc.testnet.fastnear.com", outcome: "verified", elapsedMs: 20 },
        ],
      });
    }) as unknown as typeof fetch;
    await expect(
      verifyTestnetIdentityViaServer(ALICE.accountId, ALICE.publicKey, fetchImpl),
    ).resolves.toBe(true);
    const diagnostics = JSON.stringify(info.mock.calls);
    expect(diagnostics).toContain("rpc.testnet.fastnear.com");
    expect(diagnostics).toContain('"elapsedMs":4000');
    expect(diagnostics).not.toContain(ALICE.accountId);
    expect(diagnostics).not.toContain(ALICE.publicKey);

    const failingFetch = vi.fn(async () =>
      Response.json({ verified: false, code: "TIMEOUT" }, { status: 504 }),
    ) as unknown as typeof fetch;
    await expect(
      verifyTestnetIdentityViaServer(ALICE.accountId, ALICE.publicKey, failingFetch),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    info.mockRestore();
  });

  it("configures the integration for Testnet and retrieves the signer key without signing", async () => {
    const { selector, wallet } = fakeSelector();
    const verify = vi.fn(async () => true);
    const provider = createMeteorWalletSelectorProviderAdapter(selector, verify);

    expect(METEOR_WALLET_SELECTOR_NETWORK).toBe("testnet");
    expect(await provider.detectWalletInstalled()).toBe(true);
    expect(selector.wallet).not.toHaveBeenCalled();
    await expect(provider.request({ method: "near_requestAccounts" })).resolves.toEqual({
      accounts: [ALICE],
    });
    expect(selector.wallet).toHaveBeenCalledWith(METEOR_WALLET_ID);
    expect(wallet.signIn).toHaveBeenCalledWith({});
    expect(wallet.getAccounts).toHaveBeenCalledOnce();

    await expect(
      provider.request({
        method: "near_verifyTestnetAccount",
        params: { account: ALICE },
      }),
    ).resolves.toMatchObject({ verified: true });
    expect(verify).toHaveBeenCalledWith(ALICE.accountId, ALICE.publicKey);
    expect(wallet.verifyOwner).not.toHaveBeenCalled();
    expect(wallet.signMessage).not.toHaveBeenCalled();
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
    expect(wallet.signAndSendTransactions).not.toHaveBeenCalled();
    expect(wallet.createSignedTransaction).not.toHaveBeenCalled();
    expect(wallet.signIn).toHaveBeenCalledWith({});
  });

  it("configures only the Meteor module and never requests function-call key creation", () => {
    const meteorModule = {} as WalletModuleFactory;
    const setupMeteorWallet = vi.fn(() => meteorModule);
    const options = createMeteorWalletSelectorOptions(setupMeteorWallet);

    expect(options).toMatchObject({
      network: "testnet",
      modules: [meteorModule],
      debug: false,
      optimizeWalletOrder: false,
      randomizeWalletOrder: false,
    });
    expect(options).not.toHaveProperty("createAccessKeyFor");
    expect(setupMeteorWallet).toHaveBeenCalledOnce();
  });

  it("strips secret-bearing SDK fields from returned account records and diagnostics", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const secretBearingAccount = Object.assign({}, ALICE, {
      keyPair: {
        secretKey: "do-not-log-or-return-this",
        extendedSecretKey: "also-do-not-log-or-return-this",
      },
      signer: { account: { secretKey: "nested-secret" } },
    });
    const { selector } = fakeSelector([secretBearingAccount]);
    const provider = createMeteorWalletSelectorProviderAdapter(
      selector,
      vi.fn(async () => true),
    );

    const accounts = await provider.request({ method: "near_requestAccounts" });
    const serialized = JSON.stringify(accounts);
    expect(accounts).toEqual({ accounts: [ALICE] });
    expect(serialized).not.toContain("do-not-log-or-return-this");
    expect(serialized).not.toContain("nested-secret");
    expect(JSON.stringify(info.mock.calls)).not.toContain("do-not-log-or-return-this");
    expect(JSON.stringify(info.mock.calls)).not.toContain("nested-secret");
    info.mockRestore();
  });

  it("fails closed when the signer has no public key", async () => {
    const { selector } = fakeSelector([{ accountId: ALICE.accountId }]);
    const verify = vi.fn(async () => true);
    const provider = createMeteorWalletSelectorProviderAdapter(selector, verify);
    await provider.request({ method: "near_requestAccounts" });
    await provider.request({ method: "near_accounts" });

    await expect(
      provider.request({
        method: "near_verifyTestnetAccount",
        params: { account: { accountId: ALICE.accountId } },
      }),
    ).resolves.toMatchObject({ verified: false, reason: "missing-public-key" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("fails closed for a malformed public key before RPC verification", async () => {
    const malformed = { accountId: ALICE.accountId, publicKey: "not-a-near-key" };
    const { selector } = fakeSelector([malformed]);
    const verify = vi.fn(async () => true);
    const provider = createMeteorWalletSelectorProviderAdapter(selector, verify);
    await provider.request({ method: "near_requestAccounts" });
    await provider.request({ method: "near_accounts" });

    await expect(
      provider.request({ method: "near_verifyTestnetAccount", params: { account: malformed } }),
    ).resolves.toMatchObject({ verified: false, reason: "invalid-public-key-format" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("invalidates the previous pair when Meteor switches accounts", async () => {
    const { selector, setAccounts, emit } = fakeSelector();
    const provider = createMeteorWalletSelectorProviderAdapter(
      selector,
      vi.fn(async () => true),
    );
    const changed = vi.fn();
    provider.on("accountsChanged", changed);
    await provider.request({ method: "near_requestAccounts" });
    await provider.request({ method: "near_accounts" });

    setAccounts([BOB]);
    emit("accountsChanged", { walletId: METEOR_WALLET_ID, accounts: [BOB] });
    expect(changed).toHaveBeenCalledWith({ accounts: [BOB] });
    await provider.request({ method: "near_accounts" });

    await expect(
      provider.request({ method: "near_verifyTestnetAccount", params: { account: ALICE } }),
    ).resolves.toMatchObject({ verified: false, reason: "account-key-mismatch" });
    await expect(
      provider.request({ method: "near_verifyTestnetAccount", params: { account: BOB } }),
    ).resolves.toMatchObject({ verified: true });
  });

  it("maps Meteor sign-out to immediate identity invalidation", async () => {
    const { selector, emit, wallet } = fakeSelector();
    const provider = createMeteorWalletSelectorProviderAdapter(
      selector,
      vi.fn(async () => true),
    );
    const disconnected = vi.fn();
    provider.on("disconnect", disconnected);
    await provider.request({ method: "near_requestAccounts" });

    emit("signedOut", { walletId: METEOR_WALLET_ID });

    expect(disconnected).toHaveBeenCalledOnce();
    await expect(provider.request({ method: "near_accounts" })).resolves.toEqual({ accounts: [] });
    await expect(
      provider.request({ method: "near_verifyTestnetAccount", params: { account: ALICE } }),
    ).resolves.toMatchObject({ verified: false, reason: "account-key-mismatch" });
    expect(wallet.signOut).not.toHaveBeenCalled();
  });

  it("ignores empty and duplicate account events without invalidating the selected identity", async () => {
    const { selector, emit } = fakeSelector();
    const provider = createMeteorWalletSelectorProviderAdapter(
      selector,
      vi.fn(async () => true),
    );
    const changed = vi.fn();
    const disconnected = vi.fn();
    provider.on("accountsChanged", changed);
    provider.on("disconnect", disconnected);
    await provider.request({ method: "near_requestAccounts" });
    await provider.request({ method: "near_accounts" });

    emit("accountsChanged", { walletId: METEOR_WALLET_ID, accounts: [] });
    emit("accountsChanged", { walletId: METEOR_WALLET_ID, accounts: [ALICE] });
    expect(changed).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
    await expect(
      provider.request({ method: "near_verifyTestnetAccount", params: { account: ALICE } }),
    ).resolves.toMatchObject({ verified: true });
  });

  it("maps network changes and refuses a verification that completes after one", async () => {
    const { selector, emit } = fakeSelector();
    const pending = deferred<boolean>();
    const verify = vi.fn(() => pending.promise);
    const provider = createMeteorWalletSelectorProviderAdapter(selector, verify);
    const networkChanged = vi.fn();
    provider.on("networkChanged", networkChanged);
    await provider.request({ method: "near_requestAccounts" });
    await provider.request({ method: "near_accounts" });
    const verification = provider.request({
      method: "near_verifyTestnetAccount",
      params: { account: ALICE },
    });

    emit("networkChanged", { walletId: METEOR_WALLET_ID, networkId: "mainnet" });
    pending.resolve(true);

    expect(networkChanged).toHaveBeenCalledWith({ networkId: "mainnet" });
    await expect(verification).resolves.toMatchObject({
      verified: false,
      reason: "network-changed-during-verification",
    });
  });

  it("rejects a pair the Testnet RPC does not find", async () => {
    const { selector } = fakeSelector();
    const verify = vi.fn(async () => false);
    const provider = createMeteorWalletSelectorProviderAdapter(selector, verify);
    await provider.request({ method: "near_requestAccounts" });
    await provider.request({ method: "near_accounts" });

    await expect(
      provider.request({ method: "near_verifyTestnetAccount", params: { account: ALICE } }),
    ).resolves.toMatchObject({ verified: false, reason: "access-key-not-found" });
    expect(verify).toHaveBeenCalledWith(ALICE.accountId, ALICE.publicKey);
  });

  it("does not restore a stale sign-in result after Meteor signs out", async () => {
    const { selector, emit, wallet } = fakeSelector();
    const signIn = deferred<Account[]>();
    wallet.signIn.mockReturnValue(signIn.promise);
    const provider = createMeteorWalletSelectorProviderAdapter(
      selector,
      vi.fn(async () => true),
    );

    const request = provider.request({ method: "near_requestAccounts" });
    emit("signedOut", { walletId: METEOR_WALLET_ID });
    signIn.resolve([ALICE]);

    await expect(request).resolves.toEqual({ accounts: [] });
    expect(wallet.getAccounts).not.toHaveBeenCalled();
  });

  it("rejects an RPC failure instead of accepting the provider key", async () => {
    const { selector } = fakeSelector();
    const provider = createMeteorWalletSelectorProviderAdapter(selector, async () => {
      throw Object.assign(new Error("Testnet RPC unavailable"), { code: "NETWORK_FAILURE" });
    });
    await provider.request({ method: "near_requestAccounts" });
    await provider.request({ method: "near_accounts" });

    await expect(
      provider.request({ method: "near_verifyTestnetAccount", params: { account: ALICE } }),
    ).resolves.toMatchObject({ verified: false, reason: "rpc-unavailable" });
  });
});
