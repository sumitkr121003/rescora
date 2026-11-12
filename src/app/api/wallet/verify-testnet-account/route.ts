import {
  NearRpcClient,
  NearRpcError,
  TESTNET_IDENTITY_RPC_ENDPOINTS,
  isNearAccountId,
  isNearPublicKey,
} from "@/lib/near-rpc/client";

const REQUEST_LIMIT_BYTES = 2_048;
const RESPONSE_LIMIT_BYTES = 32_768;
export const RPC_ENDPOINT_TIMEOUT_MS = 2_500;
export const RPC_TOTAL_TIMEOUT_MS = 8_000;
// This endpoint is public and fixed; a provider-specific 403 means that node
// cannot serve this deployment, so another fixed Testnet node may be tried.
const RPC_RETRYABLE_HTTP_STATUSES = new Set([403, 408, 429]);

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function boundedRpcFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  requestSignal: AbortSignal,
): Promise<Response> {
  const signals = [init?.signal, requestSignal].filter(
    (signal): signal is AbortSignal => signal !== null && signal !== undefined,
  );
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const response = await fetch(input, { ...init, ...(signal ? { signal } : {}) });
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel();
    return new Response("", { status: response.status, statusText: response.statusText });
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        return new Response("", { status: response.status, statusText: response.statusText });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function safeFailureCode(error: unknown): string {
  if (!(error instanceof NearRpcError)) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "CLIENT_ABORTED"
    ) {
      return "CLIENT_ABORTED";
    }
    return "RPC_ERROR";
  }
  switch (error.code) {
    case "TIMEOUT":
    case "NETWORK_FAILURE":
    case "HTTP_ERROR":
    case "RPC_ERROR":
    case "MALFORMED_RESPONSE":
    case "ACCESS_KEY_NOT_FOUND":
    case "ACCOUNT_NOT_FOUND":
    case "ACCOUNT_MISMATCH":
    case "PUBLIC_KEY_MISMATCH":
      return error.code;
    default:
      return "RPC_ERROR";
  }
}

function endpointHost(endpoint: string): string {
  return new URL(endpoint).hostname;
}

function retryableAvailabilityError(error: unknown): boolean {
  if (!(error instanceof NearRpcError)) return false;
  if (error.code === "NETWORK_FAILURE" || error.code === "TIMEOUT") return true;
  if (error.code === "HTTP_ERROR") {
    const status = error.details?.status;
    return (
      RPC_RETRYABLE_HTTP_STATUSES.has(Number(status)) ||
      (typeof status === "number" && status >= 500)
    );
  }
  if (error.code !== "RPC_ERROR") return false;
  const details = error.details;
  const rpcError =
    typeof details?.rpcError === "object" && details.rpcError !== null
      ? (details.rpcError as Record<string, unknown>)
      : null;
  const names: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || typeof value !== "object" || value === null || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") names.push(record.name.toUpperCase());
    visit(record.data, depth + 1);
    visit(record.cause, depth + 1);
  };
  if (rpcError) visit(rpcError, 0);
  if (
    names.some((name) =>
      [
        "TIMEOUT_ERROR",
        "REQUEST_TIMEOUT",
        "UPSTREAM_TIMEOUT",
        "NODE_UNAVAILABLE",
        "SERVICE_UNAVAILABLE",
        "NODE_IS_SYNCING",
        "OVERLOADED",
      ].includes(name),
    )
  ) {
    return true;
  }
  const message = typeof details?.rpcErrorMessage === "string" ? details.rpcErrorMessage : "";
  return /temporarily unavailable|node is syncing|node is not synced|overloaded|server is busy|try again/i.test(
    message,
  );
}

function attemptDiagnostic(
  endpoint: string,
  startedAt: number,
  error?: unknown,
): Record<string, string | number> {
  if (!error) {
    return {
      endpoint: endpointHost(endpoint),
      outcome: "verified",
      elapsedMs: Math.max(0, Date.now() - startedAt),
    };
  }
  const code = safeFailureCode(error);
  const details = error instanceof NearRpcError ? error.details : undefined;
  const status = typeof details?.status === "number" ? details.status : undefined;
  const rpcCode =
    typeof details?.rpcErrorCode === "number" || typeof details?.rpcErrorCode === "string"
      ? details.rpcErrorCode
      : undefined;
  const transportFailureKind =
    typeof details?.transportFailureKind === "string" ? details.transportFailureKind : undefined;
  return {
    endpoint: endpointHost(endpoint),
    outcome: "failed",
    code,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(rpcCode === undefined ? {} : { rpcCode }),
    ...(transportFailureKind === undefined ? {} : { transportFailureKind }),
  };
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return json({ verified: false, code: "CROSS_ORIGIN_REQUEST" }, 403);
    }
    if (originUrl.origin !== new URL(request.url).origin) {
      return json({ verified: false, code: "CROSS_ORIGIN_REQUEST" }, 403);
    }
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > REQUEST_LIMIT_BYTES) {
    return json({ verified: false, code: "REQUEST_TOO_LARGE" }, 413);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ verified: false, code: "INVALID_CONTENT_TYPE" }, 415);
  }

  let text: string;
  try {
    if (!request.body) return json({ verified: false, code: "INVALID_REQUEST" }, 400);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > REQUEST_LIMIT_BYTES) {
        await reader.cancel();
        return json({ verified: false, code: "REQUEST_TOO_LARGE" }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return json({ verified: false, code: "INVALID_REQUEST" }, 400);
  }
  if (new TextEncoder().encode(text).byteLength > REQUEST_LIMIT_BYTES) {
    return json({ verified: false, code: "REQUEST_TOO_LARGE" }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ verified: false, code: "INVALID_JSON" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ verified: false, code: "INVALID_REQUEST" }, 400);
  }
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "accountId" && key !== "publicKey") ||
    typeof record.accountId !== "string" ||
    typeof record.publicKey !== "string" ||
    !isNearAccountId(record.accountId) ||
    !isNearPublicKey(record.publicKey)
  ) {
    return json({ verified: false, code: "INVALID_IDENTITY_INPUT" }, 400);
  }

  const attempts: Record<string, string | number>[] = [];
  const totalStartedAt = Date.now();
  let lastError: unknown;
  for (const endpoint of TESTNET_IDENTITY_RPC_ENDPOINTS) {
    if (request.signal.aborted) {
      lastError = Object.assign(new Error("Identity verification request was aborted."), {
        code: "CLIENT_ABORTED",
      });
      break;
    }
    const remainingMs = RPC_TOTAL_TIMEOUT_MS - (Date.now() - totalStartedAt);
    if (remainingMs <= 0) {
      lastError = new NearRpcError("TIMEOUT", "NEAR Testnet RPC failover deadline elapsed.");
      break;
    }
    const attemptStartedAt = Date.now();
    try {
      const rpc = new NearRpcClient({
        network: "testnet",
        endpoint,
        timeoutMs: Math.min(RPC_ENDPOINT_TIMEOUT_MS, remainingMs),
        maxRetries: 0,
        fetchImpl: (input, init) => boundedRpcFetch(input, init, request.signal),
      });
      const verified = await rpc.verifyAccessKey(record.accountId, record.publicKey);
      if (!verified) {
        lastError = new NearRpcError("ACCESS_KEY_NOT_FOUND", "Access key was not found.");
        attempts.push(attemptDiagnostic(endpoint, attemptStartedAt, lastError));
        break;
      }
      attempts.push(attemptDiagnostic(endpoint, attemptStartedAt));
      return json({
        verified: true,
        verifiedEndpoint: endpointHost(endpoint),
        attempts,
      });
    } catch (error) {
      lastError = error;
      attempts.push(attemptDiagnostic(endpoint, attemptStartedAt, error));
      if (request.signal.aborted) {
        lastError = Object.assign(new Error("Identity verification request was aborted."), {
          code: "CLIENT_ABORTED",
        });
        attempts[attempts.length - 1] = {
          endpoint: endpointHost(endpoint),
          outcome: "failed",
          code: "CLIENT_ABORTED",
          elapsedMs: Math.max(0, Date.now() - attemptStartedAt),
        };
        break;
      }
      if (!retryableAvailabilityError(error)) break;
    }
  }

  const code = safeFailureCode(lastError);
  const identityFailure =
    code === "ACCESS_KEY_NOT_FOUND" ||
    code === "ACCOUNT_NOT_FOUND" ||
    code === "ACCOUNT_MISMATCH" ||
    code === "PUBLIC_KEY_MISMATCH";
  const status = identityFailure
    ? 200
    : code === "TIMEOUT"
      ? 504
      : code === "CLIENT_ABORTED"
        ? 499
        : 502;
  return json({ verified: false, code, attempts }, status);
}
