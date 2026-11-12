import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function DiagnosticsProbe() {
  const { state } = useWalletSession();
  return <output data-testid="diagnostic-event-count">{state.diagnostics.length}</output>;
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

  it("does not render internal developer diagnostics in Wallet details", async () => {
    mockWallets.provider = provider("alice.testnet", false, "rpc-unavailable");
    render(
      <WalletSessionProvider>
        <>
          <WalletIdentity />
          <DiagnosticsProbe />
        </>
      </WalletSessionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect NEAR Wallet" }));
    expect(
      await screen.findByText("Wallet connected — Testnet verification unavailable"),
    ).toBeInTheDocument();
    expect(Number(screen.getByTestId("diagnostic-event-count").textContent)).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Wallet details"));

    expect(screen.queryByText("Developer diagnostics")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/connect\.started|provider\.request\.started/),
    ).not.toBeInTheDocument();
  });

  it("offers a user-facing retry after temporary verification failure", async () => {
    const transientWallet = provider("alice.testnet", false, "rpc-unavailable");
    const originalRequest = transientWallet.request.bind(transientWallet);
    let verificationCalls = 0;
    transientWallet.request = async ({ method, params }) => {
      if (method === "near_verifyTestnetAccount") {
        verificationCalls += 1;
        if (verificationCalls > 1) {
          return {
            verified: true,
            reason: "exact-account-key-pair-found-on-testnet",
            message: "The account/public-key pair was found on NEAR Testnet.",
          };
        }
      }
      return originalRequest({ method, params });
    };
    mockWallets.provider = transientWallet;
    render(
      <WalletSessionProvider>
        <WalletIdentity />
      </WalletSessionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect NEAR Wallet" }));
    expect(
      await screen.findByText("Wallet connected — Testnet verification unavailable"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Wallet details"));
    const retryButton = await screen.findByRole("button", { name: "Retry Testnet verification" });
    await waitFor(() => expect(retryButton).toBeEnabled());
    fireEvent.click(retryButton);

    await waitFor(() => expect(verificationCalls).toBe(2));
    expect(
      await screen.findByText(
        /Verified chain evidence: Account\/key pair verified on NEAR Testnet/,
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Wallet connected").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Testnet verification could not reach/)).not.toBeInTheDocument();
    expect(verificationCalls).toBe(2);
  });

  it("shows an actionable wallet error without exposing provider exception details", async () => {
    const failingWallet = provider("alice.testnet");
    failingWallet.request = async ({ method }) => {
      if (method === "near_requestAccounts") {
        throw new Error("Internal RPC stack: https://rpc.invalid token=private-value");
      }
      return undefined;
    };
    mockWallets.provider = failingWallet;
    render(
      <WalletSessionProvider>
        <WalletIdentity />
      </WalletSessionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect NEAR Wallet" }));

    expect(
      await screen.findByText("Check that Meteor Wallet is unlocked, then try again"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Connection failed")).toHaveLength(2);
    fireEvent.click(screen.getByText("Wallet details"));
    expect(
      screen.queryByText(/Internal RPC stack|rpc\.invalid|private-value/),
    ).not.toBeInTheDocument();
  });

  it("reports an invalid wallet identity instead of saying Testnet verification is pending", async () => {
    const invalidWallet = provider("alice.testnet");
    invalidWallet.request = async ({ method }) => {
      if (method === "near_requestAccounts") {
        return { accounts: [{ accountId: "alice.testnet", publicKey: "not-a-public-key" }] };
      }
      return undefined;
    };
    mockWallets.provider = invalidWallet;
    render(
      <WalletSessionProvider>
        <WalletIdentity />
      </WalletSessionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect NEAR Wallet" }));

    expect(
      await screen.findByText("Wallet did not return a usable public key"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Testnet verification pending")).not.toBeInTheDocument();
  });
});
