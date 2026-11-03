import { describe, expect, it } from "vitest";
import { parseRuntimeEnvironment } from "./environment.mjs";

describe("parseRuntimeEnvironment", () => {
  it("accepts the single supported product network scope", () => {
    expect(parseRuntimeEnvironment({ RESCORA_NETWORK: "near-testnet" })).toEqual({
      network: "near-testnet",
    });
  });

  it.each([undefined, "mainnet", "testnet", "NEAR_TESTNET", ""])(
    "rejects unsupported or missing network scope: %s",
    (network) => {
      expect(() => parseRuntimeEnvironment({ RESCORA_NETWORK: network })).toThrow(
        "RESCORA_NETWORK must be set to near-testnet.",
      );
    },
  );
});
