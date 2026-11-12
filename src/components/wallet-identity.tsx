"use client";

import type { WalletState } from "@/lib/wallet/session";
import { useWalletSession } from "@/components/wallet-session-provider";

function stateLabel(state: WalletState): string {
  switch (state.status) {
    case "checking":
      return "Wallet not checked";
    case "unavailable":
      return "Wallet unavailable";
    case "disconnected":
      return "Wallet disconnected";
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Wallet connected";
    case "unsupported-network":
      return "Unsupported network";
    case "unsupported-wallet":
      return "Unsupported wallet";
    case "unverified":
      return "Identity unverified";
    case "cancelled":
      return "Connection cancelled";
    case "error":
      return "Wallet error";
    case "timeout":
      return "Connection timed out";
    case "missing-account":
      return "No NEAR account";
    case "locked":
      return "Wallet is locked";
  }
}

function walletNetworkLabel(state: WalletState): string {
  if (state.testnetVerificationStatus === "verified" && state.network?.networkId === "testnet") {
    return "Account/key pair verified on NEAR Testnet";
  }
  if (state.status === "unsupported-network" && state.network) {
    return `Wrong network · ${state.network.networkId}`;
  }
  if (state.testnetVerificationStatus === "unavailable") return "Testnet verification unavailable";
  if (state.testnetVerificationStatus === "rejected") return "Testnet identity not verified";
  if (state.testnetVerificationStatus === "pending") return "Testnet verification pending";
  return "Unverified";
}

function shortAccount(accountId: string): string {
  return accountId.length > 27 ? `${accountId.slice(0, 12)}…${accountId.slice(-10)}` : accountId;
}

function verificationSummary(state: WalletState): string {
  if (state.testnetVerificationStatus === "unavailable") return "Testnet verification unavailable";
  if (state.testnetVerificationStatus === "rejected") return "Testnet identity rejected";
  if (state.testnetVerificationStatus === "pending") return "Testnet verification pending";
  if (state.status !== "unverified" || !state.error) return walletNetworkLabel(state);
  if (/public key/i.test(state.error)) return "Wallet did not return a usable public key";
  if (/account ID/i.test(state.error)) return "Wallet did not return a valid account ID";
  if (/not found on NEAR Testnet/i.test(state.error))
    return "Account/key pair not found on Testnet";
  if (/timed out/i.test(state.error)) return "Testnet RPC timed out";
  if (/RPC/i.test(state.error)) return "Testnet RPC could not verify this account";
  if (/changed|mismatch/i.test(state.error)) return "Wallet identity changed; reconnect to verify";
  return "Verification failed; open Wallet details";
}

export function WalletIdentity() {
  const { state, busy, connect, disconnect, walletName } = useWalletSession();
  const connected = state.status === "connected";
  const heading =
    connected && state.testnetVerificationStatus === "unavailable"
      ? "Wallet connected — Testnet verification unavailable"
      : connected
        ? "Wallet connected"
        : stateLabel(state).replace(/^Wallet /, "");

  return (
    <div className="wallet-identity" aria-label="Wallet identity and network">
      <div className="wallet-identity__summary" aria-live="polite">
        <strong>{heading}</strong>
        <span
          title={
            state.status === "unverified" ? (state.error ?? undefined) : state.account?.accountId
          }
        >
          {connected && state.account
            ? `${shortAccount(state.account.accountId)} · ${verificationSummary(state)}`
            : verificationSummary(state)}
        </span>
      </div>
      <button
        className="wallet-identity__button"
        type="button"
        onClick={() => void (connected ? disconnect() : connect())}
        disabled={busy}
        aria-label={connected ? `Disconnect ${walletName}` : "Connect NEAR Wallet"}
      >
        {busy ? "Please wait…" : connected ? "Disconnect" : "Connect NEAR Wallet"}
      </button>
      <details className="wallet-identity__panel">
        <summary>Wallet details</summary>
        <div className="wallet-identity__panel-content">
          <span>Connection provider: {walletName}</span>
          <strong>{stateLabel(state)}</strong>
          <span>{state.account?.accountId ?? "No connected account"}</span>
          {connected && <span>Provider: {walletName}</span>}
          <span>Wallet Selector configured network: NEAR Testnet</span>
          <span>Verified chain evidence: {walletNetworkLabel(state)}</span>
          {state.testnetVerificationError && (
            <span className="wallet-identity__error">{state.testnetVerificationError}</span>
          )}
          {state.error && <span className="wallet-identity__error">{state.error}</span>}
          <p className="microcopy">
            RESCORA verifies the returned account/public-key pair against NEAR Testnet RPC. This
            does not prove the wallet&apos;s own network selector is set to Testnet. RESCORA does
            not request message signatures, add limited-access keys, submit transactions, or switch
            networks.
          </p>
          {process.env.NODE_ENV !== "production" && state.diagnostics.length > 0 && (
            <details className="wallet-identity__developer">
              <summary>Developer diagnostics</summary>
              <pre>{JSON.stringify(state.diagnostics, null, 2)}</pre>
            </details>
          )}
        </div>
      </details>
    </div>
  );
}
