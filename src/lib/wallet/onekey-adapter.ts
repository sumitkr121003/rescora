import type { WalletProvider } from "./session";

/** OneKey-specific construction stays behind the replaceable wallet-provider boundary. */
export async function createOneKeyProvider(): Promise<WalletProvider> {
  if (typeof window === "undefined") {
    throw new Error("The OneKey wallet provider can only be initialized in a browser.");
  }
  const { OneKeyNearProvider } = await import("@onekeyfe/onekey-near-provider");
  return new OneKeyNearProvider({
    networkId: "testnet",
    connectEagerly: false,
    enablePageReload: false,
  }) as unknown as WalletProvider;
}
