import {
  NearRpcClient,
  NearRpcError,
  TESTNET_IDENTITY_RPC_ENDPOINTS,
  isNearAccountId,
  type BlockContext,
  type JsonValue,
} from "@/lib/near-rpc/client";
import { BURROW_TESTNET_ACCOUNT, GET_ACCOUNT_ALL_POSITIONS_METHOD } from "@/lib/burrow/positions";
import {
  FT_METADATA_METHOD,
  GET_ASSETS_DETAILED_METHOD,
  GET_CONFIG_METHOD,
  GET_PYTH_MAPPINGS_METHOD,
  LIST_PYTH_PRICES_METHOD,
  PINNED_PYTH_MAX_AGE_SECONDS,
} from "@/lib/burrow/data-pipeline";

const MAX_REQUEST_BYTES = 16_384;
const PER_ENDPOINT_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 13_000;
const MAX_PRICE_IDS = 64;
const FASTNEAR_RPC_ENDPOINT = "https://rpc.testnet.fastnear.com/";
const PUBLIC_TESTNET_FALLBACKS = TESTNET_IDENTITY_RPC_ENDPOINTS.filter(
  (endpoint) => new URL(endpoint).hostname !== "rpc.testnet.fastnear.com",
);
const TESTNET_BLOCK_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const BURROW_METHODS = new Set([
  GET_ACCOUNT_ALL_POSITIONS_METHOD,
  GET_CONFIG_METHOD,
  GET_ASSETS_DETAILED_METHOD,
  GET_PYTH_MAPPINGS_METHOD,
]);

export const maxDuration = 15;

type ReadRequest = Readonly<{
  contractAccountId: string;
  methodName: string;
  args: Readonly<Record<string, JsonValue>>;
  block: BlockContext;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function boundedRequestText(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseReadRequest(value: unknown): ReadRequest | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["contractAccountId", "methodName", "args", "block"].includes(key),
    ) ||
    typeof value.contractAccountId !== "string" ||
    typeof value.methodName !== "string" ||
    !isRecord(value.args) ||
    !isRecord(value.block)
  )
    return null;

  const { contractAccountId, methodName, args, block } = value;
  const isBurrowMethod = BURROW_METHODS.has(methodName);
  if (isBurrowMethod && contractAccountId !== BURROW_TESTNET_ACCOUNT) return null;
  if (!isBurrowMethod && ![FT_METADATA_METHOD, LIST_PYTH_PRICES_METHOD].includes(methodName))
    return null;
  if (!isNearAccountId(contractAccountId)) return null;

  if (methodName === GET_ACCOUNT_ALL_POSITIONS_METHOD) {
    if (
      Object.keys(args).length !== 1 ||
      typeof args.account_id !== "string" ||
      !isNearAccountId(args.account_id)
    )
      return null;
  } else if (
    methodName === FT_METADATA_METHOD ||
    methodName === GET_CONFIG_METHOD ||
    methodName === GET_ASSETS_DETAILED_METHOD ||
    methodName === GET_PYTH_MAPPINGS_METHOD
  ) {
    if (Object.keys(args).length !== 0) return null;
  } else if (methodName === LIST_PYTH_PRICES_METHOD) {
    if (
      Object.keys(args).some((key) => !["price_ids", "age"].includes(key)) ||
      !Array.isArray(args.price_ids) ||
      args.price_ids.length === 0 ||
      args.price_ids.length > MAX_PRICE_IDS ||
      !args.price_ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128) ||
      args.age !== PINNED_PYTH_MAX_AGE_SECONDS
    )
      return null;
  }

  let parsedBlock: BlockContext;
  if (Object.keys(block).length === 1 && block.finality === "final") {
    parsedBlock = { finality: "final" };
  } else if (
    Object.keys(block).length === 1 &&
    typeof block.blockHash === "string" &&
    TESTNET_BLOCK_HASH.test(block.blockHash)
  ) {
    parsedBlock = { blockHash: block.blockHash };
  } else return null;

  return {
    contractAccountId,
    methodName,
    args: args as Record<string, JsonValue>,
    block: parsedBlock,
  };
}

function failureKind(error: unknown): string {
  if (isRecord(error) && error.code === "CLIENT_ABORTED") return "client-aborted";
  if (!(error instanceof NearRpcError)) return "transport";
  switch (error.code) {
    case "TIMEOUT":
      return "timeout";
    case "NETWORK_FAILURE":
      return "transport";
    case "HTTP_ERROR":
      return "http-status";
    case "RPC_ERROR":
      return "json-rpc";
    case "BLOCK_CONTEXT_MISMATCH":
      return "snapshot-mismatch";
    case "MALFORMED_RESPONSE":
      return error.message.includes("not valid JSON") ? "json-parse" : "invalid-view";
    default:
      return "invalid-view";
  }
}

function retryable(error: unknown): boolean {
  if (!(error instanceof NearRpcError)) return false;
  if (error.code === "NETWORK_FAILURE" || error.code === "TIMEOUT") return true;
  if (error.code !== "HTTP_ERROR") return false;
  const status = error.details?.status;
  return (
    status === 403 ||
    status === 408 ||
    status === 429 ||
    (typeof status === "number" && status >= 500)
  );
}

type EndpointAttempt = Record<string, unknown>;

function attempt(endpoint: string, startedAt: number, error?: unknown): EndpointAttempt {
  const host = new URL(endpoint).hostname;
  if (!error) return { endpoint: host, outcome: "resolved", elapsedMs: Date.now() - startedAt };
  const status =
    error instanceof NearRpcError && typeof error.details?.status === "number"
      ? error.details.status
      : undefined;
  const transportFailureKind =
    error instanceof NearRpcError && typeof error.details?.transportFailureKind === "string"
      ? error.details.transportFailureKind
      : undefined;
  const transportCauses =
    error instanceof NearRpcError && Array.isArray(error.details?.transportCauses)
      ? error.details.transportCauses
      : undefined;
  return {
    endpoint: host,
    outcome: "failed",
    failureKind: failureKind(error),
    code: error instanceof NearRpcError ? error.code : "NETWORK_FAILURE",
    elapsedMs: Date.now() - startedAt,
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(transportFailureKind ? { transportFailureKind } : {}),
    ...(transportCauses ? { transportCauses } : {}),
  };
}

function safeStatus(error: unknown): number {
  if (isRecord(error) && error.code === "CLIENT_ABORTED") return 499;
  if (error instanceof NearRpcError && error.code === "TIMEOUT") return 504;
  if (error instanceof NearRpcError && error.code === "HTTP_ERROR") return 503;
  if (error instanceof NearRpcError && error.code === "INVALID_REQUEST") return 400;
  return 502;
}

export async function handleBurrowRead(
  request: Request,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(request.url).origin) {
        return json({ errorCode: "CROSS_ORIGIN_REQUEST", failureKind: "request" }, 403);
      }
    } catch {
      return json({ errorCode: "CROSS_ORIGIN_REQUEST", failureKind: "request" }, 403);
    }
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ errorCode: "INVALID_REQUEST", failureKind: "request" }, 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return json({ errorCode: "INVALID_REQUEST", failureKind: "request" }, 413);
  }
  const text = await boundedRequestText(request);
  if (text === null) return json({ errorCode: "INVALID_REQUEST", failureKind: "request" }, 400);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ errorCode: "INVALID_REQUEST", failureKind: "request" }, 400);
  }
  const input = parseReadRequest(body);
  if (!input) return json({ errorCode: "INVALID_REQUEST", failureKind: "request" }, 400);

  const fastNearApiKey = process.env.FASTNEAR_API_KEY?.trim();
  if (!fastNearApiKey) {
    return json(
      { errorCode: "FASTNEAR_NOT_CONFIGURED", failureKind: "provider-not-configured" },
      503,
    );
  }

  const attempts: EndpointAttempt[] = [];
  let lastError: unknown;
  const totalStartedAt = Date.now();
  const endpoints = [FASTNEAR_RPC_ENDPOINT, ...PUBLIC_TESTNET_FALLBACKS];
  for (const endpoint of endpoints) {
    if (request.signal.aborted) {
      lastError = Object.assign(new Error("Client aborted read request."), {
        code: "CLIENT_ABORTED",
      });
      break;
    }
    const startedAt = Date.now();
    const remainingMs = TOTAL_TIMEOUT_MS - (startedAt - totalStartedAt);
    if (remainingMs <= 0) {
      lastError = new NearRpcError("TIMEOUT", "Burrow Testnet RPC failover deadline elapsed.");
      break;
    }
    try {
      const rpc = new NearRpcClient({
        network: "testnet",
        endpoint,
        timeoutMs: Math.min(PER_ENDPOINT_TIMEOUT_MS, remainingMs),
        maxRetries: 0,
        fetchImpl: (url, init) => {
          const signals = [init?.signal, request.signal].filter(
            (signal): signal is AbortSignal => signal !== undefined && signal !== null,
          );
          const headers = new Headers(init?.headers);
          if (endpoint === FASTNEAR_RPC_ENDPOINT) {
            headers.set("Authorization", `Bearer ${fastNearApiKey}`);
          } else {
            headers.delete("Authorization");
          }
          return fetchImpl(url, {
            ...init,
            headers,
            ...(signals.length
              ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) }
              : {}),
          });
        },
      });
      const view = await rpc.callFunction(input);
      attempts.push(attempt(endpoint, startedAt));
      console.info("[RESCORA Burrow RPC]", {
        method: input.methodName,
        endpoint: new URL(endpoint).hostname,
        outcome: "resolved",
        elapsedMs: Date.now() - startedAt,
        failoverCount: attempts.length - 1,
        ...(input.methodName === GET_ACCOUNT_ALL_POSITIONS_METHOD
          ? { positionViewResult: view.data === null ? "no-record" : "record-returned" }
          : {}),
      });
      return json({ view, attempts });
    } catch (error) {
      lastError = error;
      let item = attempt(endpoint, startedAt, error);
      if (request.signal.aborted) {
        lastError = Object.assign(new Error("Client aborted read request."), {
          code: "CLIENT_ABORTED",
        });
        item = {
          endpoint: new URL(endpoint).hostname,
          outcome: "failed",
          failureKind: "client-aborted",
          code: "CLIENT_ABORTED",
          elapsedMs: Date.now() - startedAt,
        };
      }
      attempts.push(item);
      console.info("[RESCORA Burrow RPC]", {
        method: input.methodName,
        ...item,
      });
      if (request.signal.aborted || !retryable(error)) break;
    }
  }
  const kind = failureKind(lastError);
  const code =
    lastError instanceof NearRpcError
      ? lastError.code
      : isRecord(lastError) && typeof lastError.code === "string"
        ? lastError.code
        : "NETWORK_FAILURE";
  const status = safeStatus(lastError);
  return json({ errorCode: code, failureKind: kind, attempts }, status);
}

export async function POST(request: Request): Promise<Response> {
  return handleBurrowRead(request);
}

export async function GET(): Promise<Response> {
  return json({ fastNearConfigured: Boolean(process.env.FASTNEAR_API_KEY?.trim()) });
}
