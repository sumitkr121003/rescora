"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  EMPTY_WALLET_STATE,
  WalletSessionController,
  type WalletState,
  walletIdentityKey,
} from "@/lib/wallet/session";
import { createMeteorWalletSelectorProvider } from "@/lib/wallet/meteor-wallet-selector-adapter";

type WalletSessionValue = Readonly<{
  state: WalletState;
  busy: boolean;
  identityRef: MutableRefObject<string>;
  walletName: string;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  retryVerification: () => Promise<void>;
}>;

const WalletSessionContext = createContext<WalletSessionValue | null>(null);

export function WalletSessionProvider({ children }: { children: ReactNode }) {
  const controllerRef = useRef<WalletSessionController | null>(null);
  const identityRef = useRef("checking");
  const [state, setState] = useState<WalletState>(EMPTY_WALLET_STATE);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new WalletSessionController(createMeteorWalletSelectorProvider);
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe((next) => {
      identityRef.current = walletIdentityKey(next);
      setState(next);
      setBusy(controller.isBusy);
    });
    return () => {
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
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

  async function retryVerification() {
    const controller = controllerRef.current;
    if (!controller || controller.isBusy) return;
    setBusy(true);
    await controller.retryVerification();
    setBusy(controller.isBusy);
  }

  return (
    <WalletSessionContext.Provider
      value={{
        state,
        busy,
        identityRef,
        walletName: "Meteor Wallet",
        connect,
        disconnect,
        retryVerification,
      }}
    >
      {children}
    </WalletSessionContext.Provider>
  );
}

export function useWalletSession(): WalletSessionValue {
  const value = useContext(WalletSessionContext);
  if (!value) throw new Error("WalletSessionProvider is missing.");
  return value;
}
