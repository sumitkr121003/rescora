export type WalletDebugDetails = Readonly<Record<string, unknown>>;

const SENSITIVE_FIELD =
  /(secret|private|seed|mnemonic|signature|transaction|payload|signer|wallet|credential|authorization|token)/i;

function sanitizeText(value: string): string {
  return value
    .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,50}/g, "[public key redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(private key|secret key|seed phrase|mnemonic)\s*[:=]\s*[^,;]+/gi, "$1: [redacted]")
    .slice(0, 300);
}

function sanitizeDetails(details: WalletDebugDetails): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_FIELD.test(key) || value === undefined) continue;
    if (typeof value === "string") safe[key] = sanitizeText(value);
    else if (typeof value === "number" || typeof value === "boolean" || value === null)
      safe[key] = value;
    else if (
      key === "accountChecks" &&
      Array.isArray(value) &&
      value.every((item) => typeof item === "object" && item !== null)
    ) {
      safe[key] = value.map((item) => {
        const record = item as Record<string, unknown>;
        return {
          accountIdReturned: record.accountIdReturned === true,
          accountIdFormatValid: record.accountIdFormatValid === true,
          publicKeyReturned: record.publicKeyReturned === true,
          publicKeyFormatValid: record.publicKeyFormatValid === true,
        };
      });
    }
    // Deliberately omit objects and arrays: wallet SDK responses can contain key material.
  }
  return safe;
}

export function logWalletDebug(event: string, details: WalletDebugDetails = {}): void {
  if (typeof window === "undefined") return;
  console.info("[RESCORA Wallet Debug]", {
    at: new Date().toISOString(),
    event,
    ...sanitizeDetails(details),
  });
}
