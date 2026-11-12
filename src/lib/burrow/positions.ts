import type { Evidence, JsonValue, PositionSnapshot, ReadSource } from "../agent/assessment";
import {
  NearRpcError,
  type NearRpcReader,
  type BlockContext,
  type ViewProvenance,
  type ViewResponse,
} from "../near-rpc/client";
import { isNearAccountId } from "../near-rpc/client";

export const BURROW_TESTNET_ACCOUNT = "burrow.services.ref-labs.testnet";
export const GET_ACCOUNT_ALL_POSITIONS_METHOD = "get_account_all_positions";

export type BurrowPositionAssetRow = Readonly<{
  tokenId: string;
  aprRaw: string;
  balanceRaw: string;
  sharesRaw: string;
}>;

export type BurrowPosition = Readonly<{
  collateral: readonly BurrowPositionAssetRow[];
  borrowed: readonly BurrowPositionAssetRow[];
}>;

export type BurrowPositionRead = Readonly<{
  accountId: string;
  positionStatus: "returned" | "no-record";
  positions: Readonly<Record<string, BurrowPosition>>;
  supplied: readonly BurrowPositionAssetRow[];
  rawResponse: JsonValue;
  provenance: ViewProvenance;
  interpretation: "sdk-0.1.22-source-shape-unverified-against-deployment";
  completeness: Readonly<{
    status: "unverified";
    reason: string;
  }>;
}>;

export type BurrowPositionReadFailureCode =
  "INVALID_ACCOUNT" | "INVALID_RESPONSE" | "NO_POSITION_RECORD" | "RPC_FAILURE";

export class BurrowPositionReadError extends Error {
  constructor(
    readonly code: BurrowPositionReadFailureCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BurrowPositionReadError";
  }
}

function rpcFailureMessage(error: NearRpcError): string {
  if (
    error.details?.failureStage === "browser-to-api-route" ||
    error.details?.failureStage === "browser-to-api-timeout"
  ) {
    return "The browser did not receive a response from the Burrow read API route; provider diagnostics are unavailable.";
  }
  const kind = error.details?.failureKind;
  if (kind === "transport" || error.code === "NETWORK_FAILURE") {
    return "Burrow Testnet RPC transport failed on all approved endpoints.";
  }
  if (kind === "timeout" || error.code === "TIMEOUT") {
    return "Burrow Testnet RPC timed out on all approved endpoints.";
  }
  if (kind === "http-status" || error.code === "HTTP_ERROR") {
    const status = error.details?.status;
    return typeof status === "number"
      ? `Burrow Testnet RPC returned HTTP ${status} on available endpoints.`
      : "Burrow Testnet RPC returned an unavailable HTTP status.";
  }
  if (kind === "json-parse") return "Burrow Testnet RPC returned invalid JSON.";
  if (kind === "json-rpc" || error.code === "RPC_ERROR") {
    return "Burrow Testnet RPC returned a JSON-RPC error.";
  }
  if (kind === "snapshot-mismatch" || error.code === "BLOCK_CONTEXT_MISMATCH") {
    return "Burrow Testnet RPC returned a different snapshot block.";
  }
  if (kind === "invalid-view" || error.code === "MALFORMED_RESPONSE") {
    return "Burrow returned an invalid view response.";
  }
  return `Burrow Testnet read failed (${error.code}).`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function parseAssetRow(value: unknown): BurrowPositionAssetRow | null {
  if (
    !isRecord(value) ||
    typeof value.token_id !== "string" ||
    !isNearAccountId(value.token_id) ||
    typeof value.apr !== "string" ||
    value.apr.length === 0 ||
    value.apr.length > 200 ||
    typeof value.balance !== "string" ||
    value.balance.length === 0 ||
    value.balance.length > 200 ||
    typeof value.shares !== "string" ||
    value.shares.length === 0 ||
    value.shares.length > 200
  ) {
    return null;
  }
  return Object.freeze({
    tokenId: value.token_id,
    aprRaw: value.apr,
    balanceRaw: value.balance,
    sharesRaw: value.shares,
  });
}

function parseAssetRows(value: unknown): readonly BurrowPositionAssetRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.map(parseAssetRow);
  return rows.every((row) => row !== null) ? Object.freeze(rows as BurrowPositionAssetRow[]) : null;
}

function parsePositions(value: unknown): Readonly<Record<string, BurrowPosition>> | null {
  if (!isRecord(value)) return null;
  const parsed = Object.create(null) as Record<string, BurrowPosition>;
  for (const [positionId, position] of Object.entries(value)) {
    if (
      !positionId ||
      positionId.length > 128 ||
      !isRecord(position) ||
      !Object.prototype.hasOwnProperty.call(position, "collateral") ||
      !Object.prototype.hasOwnProperty.call(position, "borrowed")
    ) {
      return null;
    }
    const collateral = parseAssetRows(position.collateral);
    const borrowed = parseAssetRows(position.borrowed);
    if (!collateral || !borrowed) return null;
    parsed[positionId] = Object.freeze({ collateral, borrowed });
  }
  return Object.freeze(parsed);
}

function parsePositionView(
  response: ViewResponse<JsonValue>,
  requestedAccountId: string,
): BurrowPositionRead {
  const raw = response.data;
  if (raw === null) {
    return Object.freeze({
      accountId: requestedAccountId,
      positionStatus: "no-record",
      positions: Object.freeze(Object.create(null) as Record<string, BurrowPosition>),
      supplied: Object.freeze([]),
      rawResponse: raw,
      provenance: response.provenance,
      interpretation: "sdk-0.1.22-source-shape-unverified-against-deployment",
      completeness: Object.freeze({
        status: "unverified",
        reason:
          "The view returned null, so no account-position record or position rows were returned. This does not prove the account has no position.",
      }),
    });
  }
  if (
    !isRecord(raw) ||
    raw.account_id !== requestedAccountId ||
    !Object.prototype.hasOwnProperty.call(raw, "positions")
  ) {
    throw new BurrowPositionReadError(
      "INVALID_RESPONSE",
      "Burrow position response is malformed or belongs to a different account.",
    );
  }
  const positions = parsePositions(raw.positions);
  const supplied = parseAssetRows(raw.supplied);
  if (!positions || !supplied) {
    throw new BurrowPositionReadError(
      "INVALID_RESPONSE",
      "Burrow position response does not match the source-declared account view shape.",
    );
  }
  return Object.freeze({
    accountId: requestedAccountId,
    positionStatus: "returned",
    positions,
    supplied,
    rawResponse: deepFreeze(raw),
    provenance: response.provenance,
    interpretation: "sdk-0.1.22-source-shape-unverified-against-deployment",
    completeness: Object.freeze({
      status: "unverified",
      reason:
        "The SDK names this an all-positions view, but deployed-code equivalence and account-position completeness semantics have not been verified.",
    }),
  });
}

export class BurrowPositionReader {
  constructor(private readonly rpc: NearRpcReader) {}

  async readAccountPositions(accountId: string, block?: BlockContext): Promise<BurrowPositionRead> {
    if (!isNearAccountId(accountId)) {
      throw new BurrowPositionReadError("INVALID_ACCOUNT", "NEAR account ID is invalid.");
    }
    try {
      const response = await this.rpc.callFunction({
        contractAccountId: BURROW_TESTNET_ACCOUNT,
        methodName: GET_ACCOUNT_ALL_POSITIONS_METHOD,
        args: { account_id: accountId },
        ...(block ? { block } : {}),
      });
      return parsePositionView(response, accountId);
    } catch (error) {
      if (error instanceof BurrowPositionReadError) throw error;
      throw new BurrowPositionReadError(
        "RPC_FAILURE",
        error instanceof NearRpcError
          ? rpcFailureMessage(error)
          : "NEAR testnet position read failed.",
        error,
      );
    }
  }
}

/** Map the source-declared position rows into the assessment snapshot shape. */
export function toPositionSnapshot(read: BurrowPositionRead): PositionSnapshot {
  if (read.positionStatus === "no-record") {
    throw new BurrowPositionReadError(
      "NO_POSITION_RECORD",
      "Burrow returned no account-position record; no position snapshot was created.",
    );
  }
  const positions = Object.fromEntries(
    Object.entries(read.positions).map(([positionId, position]) => [
      positionId,
      {
        collateral: position.collateral.map(({ tokenId, balanceRaw }) => ({ tokenId, balanceRaw })),
        borrowed: position.borrowed.map(({ tokenId, balanceRaw }) => ({ tokenId, balanceRaw })),
      },
    ]),
  );
  const source: ReadSource = {
    contractId: read.provenance.contractAccountId,
    method: read.provenance.methodName,
    args: read.provenance.requestArguments,
    blockHeight: read.provenance.blockHeight,
    blockHash: read.provenance.blockHash,
  };
  return Object.freeze({ positions: Object.freeze(positions), source: Object.freeze(source) });
}

/**
 * This reader cannot authenticate the deployment or prove completeness. Keep
 * its output unavailable to the verified-assessment boundary until those
 * independent gates have passed.
 */
export function toAssessmentPositionEvidence(read: BurrowPositionRead): Evidence<PositionSnapshot> {
  void read;
  return Object.freeze({
    status: "unavailable",
    reason:
      "Burrow deployment/source equivalence and complete account-position semantics are unverified.",
  });
}
