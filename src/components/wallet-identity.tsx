"use client";

import { useEffect, useRef, useState } from "react";
import {
  EMPTY_WALLET_STATE,
  WalletSessionController,
  type WalletState,
} from "@/lib/wallet/session";
import { createOneKeyProvider } from "@/lib/wallet/onekey-adapter";

function stateLabel(state: WalletState): string {
  switch (state.status) {
    case "checking":
      return "Wallet not checked";
    case "unavailable":
      return "OneKey unavailable";
    case "disconnected":
      return "Wallet disconnected";
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected";
    case "unsupported-network":
      return "Unsupported network";
    case "unverified":
      return "Identity unverified";
    case "cancelled":
      return "Connection cancelled";
    case "error":
      return "Wallet error";
  }
}

export function WalletIdentity() {
  const controllerRef = useRef<WalletSessionController | null>(null);
  const [state, setState] = useState<WalletState>(EMPTY_WALLET_STATE);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new WalletSessionController(createOneKeyProvider);
    controllerRef.current = controller;
    return controller.subscribe((next) => {
      setState(next);
      setBusy(controller.isBusy);
    });
  }, []);

  async function connect() {
    const controller = controllerRef.current;
    if (!controller || controller.isBusy) return;
    setBusy(true);
    await controller.connect();
    setBusy(controller.isBusy);
  }

  async function disconnect() {
    const controller = controllerRef.current;
    if (!controller || controller.isBusy) return;
    setBusy(true);
    await controller.disconnect();
    setBusy(controller.isBusy);
  }

  const connected = state.status === "connected";
  return (
    <div className="wallet-identity" aria-label="Wallet identity and network">
      <div className="wallet-identity__details" aria-live="polite">
        <strong>{stateLabel(state)}</strong>
        <span>{state.account?.accountId ?? "No verified account"}</span>
        <span>Active network: {state.network?.networkId ?? "unverified"}</span>
        {state.error && <span className="wallet-identity__error">{state.error}</span>}
      </div>
      <button
        className="wallet-identity__button"
        type="button"
        onClick={connected ? disconnect : connect}
        disabled={busy}
        aria-label={connected ? "Disconnect OneKey wallet" : "Connect OneKey wallet"}
      >
        {busy ? "Please wait…" : connected ? "Disconnect" : "Connect OneKey"}
      </button>
    </div>
  );
}
