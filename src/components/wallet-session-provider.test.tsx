import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletProvider } from "@/lib/wallet/session";
import { WalletIdentity } from "./wallet-identity";
import { WalletSessionProvider, useWalletSession } from "./wallet-session-provider";

const mockWallets = vi.hoisted(() => ({
  provider: null as WalletProvider | null,
}));

vi.mock("@/lib/wallet/meteor-wallet-selector-adapter", () => ({
  createMeteorWalletSelectorProvider: async () => mockWallets.provider,
}));

function provider(
  accountId: string,
  verification = true,
  failureReason = "access-key-not-found",
): WalletProvider {
  const account = {
    accountId,
    publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
  };
  return {
    name: "Meteor Wallet",
    detectWalletInstalled: async () => true,
    request: async ({ method }) => {
      if (method === "near_requestAccounts" || method === "near_accounts") {
        return { accounts: [account] };
      }
      if (method === "near_verifyTestnetAccount" && verification) {
        return {
          verified: true,
          reason: "exact-account-key-pair-found-on-testnet",
          message: "The account/public-key pair was found on NEAR Testnet.",
        };
      }
      if (method === "near_verifyTestnetAccount") {
        return {
          verified: false,
          reason: failureReason,
          message:
            failureReason === "rpc-unavailable"
              ? "Testnet verification could not reach the RPC service."
              : "The exact account/public-key pair was not found on NEAR Testnet.",
        };
      }
      return undefined;
    },
    on: () => undefined,
    off: () => undefined,
  };
}

function SessionProbe() {
  const { state, connect, walletName } = useWalletSession();
  return (
    <div>
      <output data-testid="session">
        {state.status}:{state.account?.accountId ?? "no-account"}
      </output>
      <output data-testid="provider">{walletName}</output>
      <button onClick={() => void connect()}>Connect selected</button>
    </div>
  );
}

describe("wallet session provider selection", () => {
  beforeEach(() => {
    mockWallets.provider = provider("alice.testnet");
  });

  it("connects through Meteor Wallet while keeping the existing session boundary", async () => {
    render(
      <WalletSessionProvider>
        <SessionProbe />
      </WalletSessionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect selected" }));
    expect(await screen.findByTestId("session")).toHaveTextContent("connected:alice.testnet");

    expect(screen.getByTestId("provider")).toHaveTextContent("Meteor Wallet");
  });

  it("starts the Meteor connection flow only after the explicit connect action", async () => {
    render(
      <WalletSessionProvider>
        <WalletIdentity />
      </WalletSessionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect NEAR Wallet" }));
    expect(await screen.findAllByText("Wallet connected", { selector: "strong" })).toHaveLength(2);
  });

  it("shows connection and failed Testnet verification separately", async () => {
    mockWallets.provider = provider("alice.testnet", false, "rpc-unavailable");
    render(
      <WalletSessionProvider>
        <WalletIdentity />
      </WalletSessionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect NEAR Wallet" }));
    expect(
      await screen.findByText("Wallet connected — Testnet verification unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("alice.testnet")).toBeInTheDocument();
    expect(screen.getByText(/Testnet verification could not reach/)).toBeInTheDocument();
  });
});
