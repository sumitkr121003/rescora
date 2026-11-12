import { describe, expect, it } from "vitest";
import { canReadBurrowPositions } from "./burrow-positions-panel";
import { EMPTY_WALLET_STATE } from "@/lib/wallet/session";

describe("read-only Burrow eligibility", () => {
  it("allows the connected account when optional Testnet verification is unavailable", () => {
    expect(
      canReadBurrowPositions({
        ...EMPTY_WALLET_STATE,
        status: "connected",
        account: {
          accountId: "alice.testnet",
          publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
        },
        testnetVerificationStatus: "unavailable",
      }),
    ).toBe(true);
  });

  it.each(["pending", "rejected"] as const)(
    "allows a public read-only query while verification is %s without upgrading identity status",
    (status) => {
      expect(
        canReadBurrowPositions({
          ...EMPTY_WALLET_STATE,
          status: "connected",
          account: {
            accountId: "alice.testnet",
            publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
          },
          testnetVerificationStatus: status,
        }),
      ).toBe(true);
    },
  );

  it("does not allow reads without a connected wallet account", () => {
    expect(canReadBurrowPositions(EMPTY_WALLET_STATE)).toBe(false);
  });
});
