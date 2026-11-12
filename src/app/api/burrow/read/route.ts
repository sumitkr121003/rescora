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

function providerName(endpoint: string): string {
  switch (new URL(endpoint).hostname) {
    case "rpc.testnet.fastnear.com":
      return "FastNear";
    case "rpc.testnet.pagoda.co":
      return "Pagoda";
    case "rpc.testnet.near.org":
      return "NEAR RPC";
    default:
      return "Approved Testnet RPC";
  }
}

function failureCategory(error: unknown): string {
  if (error instanceof NearRpcError) {
    if (error.code === "TIMEOUT") return "timeout";
    if (error.code === "HTTP_ERROR") return "http";
    if (error.code === "RPC_ERROR") return "json-rpc";
    if (error.code === "NETWORK_FAILURE") {
      switch (error.details?.transportFailureKind) {
        case "dns-resolution":
          return "dns";
        case "tls-failure":
          return "tls";
        case "connection-refused":
        case "connection-reset-or-unreachable":
        case "connection-timeout":
        case "cors-or-cross-origin":
        case "browser-fetch-transport":
        case "unknown-transport":
        default:
          return "connection";
      }
    }
    return "response-validation";
  }
  if (isRecord(error) && error.code === "CLIENT_ABORTED") return "timeout";
  return "connection";
}

function safeDiagnosticMessage(value: string, apiKey: string): string {
  let message = value;
  if (apiKey) message = message.replaceAll(apiKey, "[redacted]");
  return message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/(?:authorization|api[_-]?key)(\s*[:=]\s*)[^\s,;"']+/gi, "[credential redacted]")
    .replace(
      /\b(?:private[_ -]?key|secret[_ -]?key|access[_ -]?key|wallet[_ -]?credential|token)\s*[:=]\s*[^,\s;]+/gi,
      "[credential redacted]",
    )
    .replace(/\b(?:seed[_ -]?phrase|mnemonic)\s*[:=]\s*[^,;]+/gi, "[wallet phrase redacted]")
    .replace(/\b(?:ed25519|secp256k1|secp256r1):[A-Za-z0-9+/=_-]{20,}\b/gi, "[key redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL redacted]")
    .replace(/gsk_[\w-]+/g, "[redacted]")
    .slice(0, 240);
}

function safeJsonRpcError(error: NearRpcError, apiKey: string) {
  const rpcError = error.details?.rpcError;
  if (!isRecord(rpcError)) return {};
  const code =
    typeof rpcError.code === "number"
      ? rpcError.code
      : typeof rpcError.code === "string"
        ? safeDiagnosticMessage(rpcError.code, apiKey)
        : undefined;
  const message =
    typeof rpcError.message === "string"
      ? safeDiagnosticMessage(rpcError.message, apiKey)
      : undefined;
  return {
    ...(code === undefined ? {} : { jsonRpcErrorCode: code }),
    ...(message === undefined ? {} : { jsonRpcErrorMessage: message }),
  };
}

function safeTransportCauses(
  error: NearRpcError,
  apiKey: string,
): readonly Record<string, string>[] {
  const causes = error.details?.transportCauses;
  if (!Array.isArray(causes)) return [];
  const safeFields = ["name", "code", "syscall", "hostname"] as const;
  return causes.flatMap((cause) => {
    if (!isRecord(cause)) return [];
    const safe = Object.fromEntries(
      safeFields.flatMap((field) => {
        const value = cause[field];
        return typeof value === "string" ? [[field, safeDiagnosticMessage(value, apiKey)]] : [];
      }),
    ) as Record<string, string>;
    return Object.keys(safe).length ? [safe] : [];
  });
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

type AttemptMetadata = Readonly<{
  apiKeyConfigured: boolean;
  authorizationAttached: boolean;
  httpStatus?: number;
}>;

function attempt(
  endpoint: string,
  startedAt: number,
  metadata: AttemptMetadata,
  apiKey: string,
  error?: unknown,
): EndpointAttempt {
  const host = new URL(endpoint).hostname;
  const status =
    metadata.httpStatus ??
    (error instanceof NearRpcError && typeof error.details?.status === "number"
      ? error.details.status
      : undefined);
  const base = {
    endpoint: host,
    provider: providerName(endpoint),
    apiKeyConfigured: metadata.apiKeyConfigured,
    authorizationAttached: metadata.authorizationAttached,
    requestDurationMs: Math.max(0, Date.now() - startedAt),
    ...(status === undefined ? {} : { httpStatus: status }),
  };
  if (!error)
    return {
      ...base,
      outcome: "resolved",
      failureCategory: "none",
      nearRpcErrorCode: null,
      nearRpcErrorMessage: null,
    };
  const rawTransportFailureKind =
    error instanceof NearRpcError ? error.details?.transportFailureKind : undefined;
  const transportFailureKind =
    typeof rawTransportFailureKind === "string" && /^[a-z0-9-]{1,48}$/.test(rawTransportFailureKind)
      ? rawTransportFailureKind
      : undefined;
  const transportCauses = error instanceof NearRpcError ? safeTransportCauses(error, apiKey) : [];
  const rpcFields = error instanceof NearRpcError ? safeJsonRpcError(error, apiKey) : {};
  const errorCode = error instanceof NearRpcError ? error.code : null;
  return {
    ...base,
    outcome: "failed",
    failureKind: failureKind(error),
    failureCategory: failureCategory(error),
    nearRpcErrorCode: errorCode,
    nearRpcErrorMessage:
      error instanceof NearRpcError ? safeDiagnosticMessage(error.message, apiKey) : null,
    ...(status === undefined ? {} : { httpFailureKind: httpFailureKind(status) }),
    ...rpcFields,
    ...(transportFailureKind ? { transportFailureKind } : {}),
    ...(transportCauses.length ? { transportCauses } : {}),
  };
}

function httpFailureKind(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "provider-server-error";
  return "http-error";
}

function safeStatus(error: unknown): number {
  if (isRecord(error) && error.code === "CLIENT_ABORTED") return 499;
  if (error instanceof NearRpcError && error.code === "TIMEOUT") return 504;
  if (error instanceof NearRpcError && error.code === "HTTP_ERROR") return 503;
  if (error instanceof NearRpcError && error.code === "INVALID_REQUEST") return 400;
  return 502;
}

async function handleBurrowReadInternal(
  request: Request,
  fetchImpl: typeof fetch = globalThis.fetch,
  requestId: string,
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
    let httpStatus: number | undefined;
    const authorizationAttached = endpoint === FASTNEAR_RPC_ENDPOINT;
    const metadata = {
      apiKeyConfigured: true,
      authorizationAttached,
      get httpStatus() {
        return httpStatus;
      },
    };
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
          if (authorizationAttached) {
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
          }).then((response) => {
            httpStatus = response.status;
            return response;
          });
        },
      });
      const view = await rpc.callFunction(input);
      const item = attempt(endpoint, startedAt, metadata, fastNearApiKey);
      attempts.push(item);
      console.info("[RESCORA Burrow RPC]", {
        requestId,
        method: input.methodName,
        ...item,
        failoverCount: attempts.length - 1,
        ...(input.methodName === GET_ACCOUNT_ALL_POSITIONS_METHOD
          ? { positionViewResult: view.data === null ? "no-record" : "record-returned" }
          : {}),
      });
      return json({ view, attempts });
    } catch (error) {
      lastError = error;
      if (request.signal.aborted) {
        lastError = Object.assign(new Error("Client aborted read request."), {
          code: "CLIENT_ABORTED",
        });
      }
      const item = attempt(
        endpoint,
        startedAt,
        metadata,
        fastNearApiKey,
        request.signal.aborted ? lastError : error,
      );
      attempts.push(item);
      console.info("[RESCORA Burrow RPC]", {
        requestId,
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

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleBurrowRead(
  request: Request,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const suppliedRequestId = request.headers.get("x-rescora-request-id");
  const requestId =
    suppliedRequestId && REQUEST_ID_PATTERN.test(suppliedRequestId)
      ? suppliedRequestId
      : crypto.randomUUID();
  const response = await handleBurrowReadInternal(request, fetchImpl, requestId);
  let rpcAttempted = false;
  try {
    const body: unknown = await response.clone().json();
    rpcAttempted = isRecord(body) && Array.isArray(body.attempts) && body.attempts.length > 0;
  } catch {
    // A malformed request may fail before any provider call; keep this false.
  }
  const headers = new Headers(response.headers);
  headers.set("x-rescora-request-id", requestId);
  headers.set("x-rescora-route-reached", "true");
  headers.set("x-rescora-rpc-attempted", String(rpcAttempted));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleBurrowRead(request);
}
