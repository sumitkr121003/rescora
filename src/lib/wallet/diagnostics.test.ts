import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { logWalletDebug } from "./diagnostics";

describe("wallet diagnostic sanitization", () => {
  it("never serializes secret-bearing objects or key material", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const keyPair = {
      secretKey: "secret-value-should-not-appear",
      extendedSecretKey: "extended-secret-should-not-appear",
      publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
    };
    const signer = { keyPair, getPublicKey: () => keyPair.publicKey };
    logWalletDebug("test.sanitization", {
      signer,
      wallet: { signer },
      accountChecks: [
        {
          accountIdReturned: true,
          accountIdFormatValid: true,
          publicKeyReturned: true,
          publicKeyFormatValid: true,
          keyPair,
        },
      ],
      secretKey: keyPair.secretKey,
      publicKey: keyPair.publicKey,
      accountIdFormatValid: true,
    });

    const serialized = JSON.stringify(info.mock.calls);
    expect(serialized).not.toContain("secret-value-should-not-appear");
    expect(serialized).not.toContain("extended-secret-should-not-appear");
    expect(serialized).not.toContain(keyPair.publicKey);
    expect(serialized).not.toContain("getPublicKey");
    expect(serialized).toContain('"accountIdFormatValid":true');
    expect(serialized).toContain('"publicKeyFormatValid":true');
    info.mockRestore();
  });

  it("keeps the installed Meteor SDK KeyPair console leak patched in its runtime entry", () => {
    const meteorSelectorEntry = fileURLToPath(
      import.meta.resolve("@near-wallet-selector/meteor-wallet"),
    );
    const meteorRequire = createRequire(meteorSelectorEntry);
    const commonJsEntry = meteorRequire.resolve("@meteorwallet/sdk");
    const runtimes = [
      readFileSync(commonJsEntry, "utf8"),
      readFileSync(join(dirname(commonJsEntry), "index.js"), "utf8"),
    ];
    for (const runtime of runtimes) {
      expect(runtime).not.toContain("console.log(accessKey)");
      expect(runtime).not.toContain("Transformed transactions");
      expect(runtime).not.toContain("Comparing access key and actions");
      expect(runtime).not.toContain("console.log(firstAction)");
      expect(runtime).not.toContain('console.log("accessKeys"');
    }
  });
});
