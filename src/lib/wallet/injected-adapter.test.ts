import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverInjectedWallets } from "./injected-adapter";

function injected(
  network: unknown = { networkId: "testnet", nodeUrl: "https://rpc.testnet.near.org" },
) {
  const listeners = new Map<string, (payload: unknown) => void>();
  const wallet = {
    id: "sample-near-wallet",
    network,
    accounts: [{ accountId: "alice.testnet", publicKey: "ed25519:abc" }],
    connect: vi.fn(async (params: unknown) => {
      expect(params).toEqual({ networkId: "testnet" });
      return wallet.accounts;
    }),
    disconnect: vi.fn(async () => undefined),
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener);
    }),
    off: vi.fn(),
  };
  return { wallet, listeners };
}

describe("NEAR injected wallet discovery", () => {
  beforeEach(() => {
    (window as Window & { near?: Record<string, unknown> }).near = {};
  });

  it("discovers only a provider that reports a network and exposes account access", async () => {
    const candidate = injected();
    (window as Window & { near?: Record<string, unknown> }).near = {
      sample: candidate.wallet,
      configuredOnly: { connect: vi.fn(), disconnect: vi.fn() },
    };
    const [descriptor] = discoverInjectedWallets();
    expect(descriptor).toMatchObject({ id: "injected:sample", name: "sample-near-wallet" });
    const provider = descriptor.create();
    await expect(provider.request({ method: "near_requestAccounts" })).resolves.toEqual({
      accounts: [{ accountId: "alice.testnet", publicKey: "ed25519:abc" }],
    });
    expect(await provider.request({ method: "near_networkInfo" })).toMatchObject({
      networkId: "testnet",
    });
  });

  it("passes malformed provider network values through for the session to reject", async () => {
    const candidate = injected({ networkId: 12 });
    (window as Window & { near?: Record<string, unknown> }).near = { sample: candidate.wallet };
    const provider = discoverInjectedWallets()[0].create();
    await expect(provider.request({ method: "near_networkInfo" })).resolves.toEqual({
      networkId: 12,
    });
  });

  it("turns account-change events into the shared provider event shape", () => {
    const candidate = injected();
    (window as Window & { near?: Record<string, unknown> }).near = { sample: candidate.wallet };
    const provider = discoverInjectedWallets()[0].create();
    const listener = vi.fn();
    provider.on("accountsChanged", listener);
    candidate.listeners.get("accountsChanged")?.({
      accounts: [{ accountId: "bob.testnet", publicKey: "ed25519:def" }],
    });
    expect(listener).toHaveBeenCalledWith({
      accounts: [{ accountId: "bob.testnet", publicKey: "ed25519:def" }],
    });
  });
});
