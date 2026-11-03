/**
 * @typedef {{ RESCORA_NETWORK?: string }} RuntimeEnvironmentInput
 * @typedef {{ network: "near-testnet" }} RuntimeEnvironment
 */

/** @param {RuntimeEnvironmentInput} input */
export function parseRuntimeEnvironment(input) {
  if (input.RESCORA_NETWORK !== "near-testnet") {
    throw new Error("RESCORA_NETWORK must be set to near-testnet.");
  }

  return Object.freeze({ network: "near-testnet" });
}

/** @returns {RuntimeEnvironment} */
export function getRuntimeEnvironment() {
  return parseRuntimeEnvironment(process.env);
}
