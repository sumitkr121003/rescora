import {
  NearRpcError,
  type BlockContext,
  type JsonValue,
  type NearRpcReader,
  type ViewFunctionInput,
  type ViewProvenance,
  type ViewResponse,
  isNearAccountId,
} from "./client";

const BURROW_READ_ROUTE = "/api/burrow/read";
const RPC_HOSTS = new Set([
  "rpc.testnet.near.org",
  "rpc.testnet.pagoda.co",
  "rpc.testnet.fastnear.com",
]);
const BLOCK_HASH_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export type BurrowRequestDiagnostic = Readonly<{
  httpMethod: "POST";
  route: string;
  httpStatus: number | null;
  requestDurationMs: number;
  routeReached: boolean;
  externalRpcRequestAttempted: boolean;
  requestId: string;
  failureStage?: string;
  errorCode?: string;
  failureKind?: string;
  browserException?: Readonly<{ name: string; message: string }>;
  attempts: readonly unknown[];
}>;

export function sanitizeBrowserException(
  error: unknown,
): Readonly<{ name: string; message: string }> {
  const name = error instanceof Error ? error.name : "UnknownError";
  const rawMessage = error instanceof Error ? error.message : "Browser request failed.";
  const message = rawMessage
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[_-]?key|token|secret)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]")
    .replace(/\b(?:ed25519|secp256k1):\S+/gi, "[credential]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 200);
  return Object.freeze({
    name: /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : "BrowserError",
    message: message || "Browser request failed.",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonClone(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    throw new NearRpcError("INVALID_REQUEST", "View arguments must be JSON serializable.");
  }
}

function remoteError(
  body: unknown,
  status: number,
  requestDiagnostic: BurrowRequestDiagnostic,
): NearRpcError {
  const record = isRecord(body) ? body : {};
  const code = typeof record.errorCode === "string" ? record.errorCode : "NETWORK_FAILURE";
  const failureKind = typeof record.failureKind === "string" ? record.failureKind : "transport";
  const allowedCodes = new Set([
    "INVALID_ACCOUNT_ID",
    "INVALID_REQUEST",
    "TIMEOUT",
    "NETWORK_FAILURE",
    "HTTP_ERROR",
    "RPC_ERROR",
    "MALFORMED_RESPONSE",
    "MISSING_PROVENANCE",
    "BLOCK_CONTEXT_MISMATCH",
    "CLIENT_ABORTED",
  ]);
  const safeCode = allowedCodes.has(code) ? code : "NETWORK_FAILURE";
  const messages: Record<string, string> = {
    transport: "Burrow Testnet RPC transport failed on all available endpoints.",
    timeout: "Burrow Testnet RPC timed out on all available endpoints.",
    "http-status": "Burrow Testnet RPC returned an unavailable HTTP status.",
    "json-parse": "Burrow Testnet RPC returned invalid JSON.",
    "json-rpc": "Burrow Testnet RPC returned a JSON-RPC error.",
    "invalid-view": "Burrow returned an invalid view response.",
    "snapshot-mismatch": "Burrow Testnet RPC returned a different snapshot block.",
    request: "Burrow read request was rejected by RESCORA.",
  };
  const attempts = Array.isArray(record.attempts) ? record.attempts : [];
  return new NearRpcError(
    safeCode as ConstructorParameters<typeof NearRpcError>[0],
    messages[failureKind] ?? "Burrow Testnet read failed.",
    {
      failureKind,
      ...(status ? { status } : {}),
      attempts,
      requestDiagnostic,
    },
  );
}

function validateProvenance(
  value: unknown,
  input: ViewFunctionInput,
  args: JsonValue,
  requestedBlock: BlockContext,
): ViewProvenance {
  if (!isRecord(value))
    throw new NearRpcError("MISSING_PROVENANCE", "Read route omitted provenance.");
  const provenance = value;
  let endpoint: URL | null = null;
  try {
    if (typeof provenance.rpcEndpoint === "string") endpoint = new URL(provenance.rpcEndpoint);
  } catch {
    endpoint = null;
  }
  if (
    provenance.network !== "testnet" ||
    provenance.contractAccountId !== input.contractAccountId ||
    provenance.methodName !== input.methodName ||
    JSON.stringify(provenance.requestArguments) !== JSON.stringify(args) ||
    typeof provenance.blockHeight !== "string" ||
    !/^\d+$/.test(provenance.blockHeight) ||
    typeof provenance.blockHash !== "string" ||
    !BLOCK_HASH_PATTERN.test(provenance.blockHash) ||
    !endpoint ||
    endpoint.protocol !== "https:" ||
    !RPC_HOSTS.has(endpoint.hostname) ||
    endpoint.pathname !== "/" ||
    typeof provenance.retrievedAt !== "string" ||
    !Number.isFinite(Date.parse(provenance.retrievedAt))
  ) {
    throw new NearRpcError("MALFORMED_RESPONSE", "Read route returned invalid view provenance.");
  }
  if ("blockHash" in requestedBlock && requestedBlock.blockHash !== provenance.blockHash) {
    throw new NearRpcError(
      "BLOCK_CONTEXT_MISMATCH",
      "Read route returned a different snapshot block.",
    );
  }
  return Object.freeze({
    network: "testnet",
    contractAccountId: input.contractAccountId,
    methodName: input.methodName,
    requestArguments: args as Readonly<Record<string, JsonValue>>,
    blockHeight: provenance.blockHeight,
    blockHash: provenance.blockHash,
    rpcEndpoint: endpoint.toString(),
    retrievedAt: provenance.retrievedAt,
  });
}

/** Same-origin browser transport. RPC endpoint selection is server-owned. */
export class NearRpcProxyClient implements NearRpcReader {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 18_000,
    private readonly onDiagnostic?: (diagnostic: BurrowRequestDiagnostic) => void,
  ) {}

  async callFunction<T extends JsonValue = JsonValue>(
    input: ViewFunctionInput<T>,
  ): Promise<ViewResponse<T>> {
    if (!isNearAccountId(input.contractAccountId)) {
      throw new NearRpcError("INVALID_ACCOUNT_ID", "Contract account ID is invalid.");
    }
    const args = jsonClone(input.args ?? {});
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new NearRpcError("INVALID_REQUEST", "View arguments must be a JSON object.");
    }
    const block = input.block ?? { finality: "final" as const };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const requestId = globalThis.crypto.randomUUID();
    const startedAt = performance.now();
    let diagnostic: BurrowRequestDiagnostic = {
      httpMethod: "POST",
      route: BURROW_READ_ROUTE,
      httpStatus: null,
      requestDurationMs: 0,
      routeReached: false,
      externalRpcRequestAttempted: false,
      requestId,
      attempts: [],
    };
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(BURROW_READ_ROUTE, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-rescora-request-id": requestId,
          },
          credentials: "same-origin",
          body: JSON.stringify({
            contractAccountId: input.contractAccountId,
            methodName: input.methodName,
            args,
            block,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        const browserException = sanitizeBrowserException(error);
        diagnostic = {
          ...diagnostic,
          requestDurationMs: Math.round(performance.now() - startedAt),
          failureStage: controller.signal.aborted
            ? "browser-to-api-timeout"
            : "browser-to-api-route",
          errorCode: controller.signal.aborted ? "TIMEOUT" : "NETWORK_FAILURE",
          failureKind: controller.signal.aborted ? "timeout" : "transport",
          browserException,
        };
        throw new NearRpcError(
          controller.signal.aborted ? "TIMEOUT" : "NETWORK_FAILURE",
          controller.signal.aborted
            ? "Burrow read route timed out."
            : "Burrow read route transport failed.",
          {
            failureKind: controller.signal.aborted ? "timeout" : "transport",
            failureStage: controller.signal.aborted
              ? "browser-to-api-timeout"
              : "browser-to-api-route",
            attempts: [],
            requestDiagnostic: diagnostic,
            browserException,
          },
        );
      }
      diagnostic = {
        ...diagnostic,
        httpStatus: response.status,
        requestDurationMs: Math.round(performance.now() - startedAt),
        routeReached: response.headers.get("x-rescora-route-reached") === "true",
        externalRpcRequestAttempted: response.headers.get("x-rescora-rpc-attempted") === "true",
        requestId: response.headers.get("x-rescora-request-id") ?? requestId,
      };
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new NearRpcError("MALFORMED_RESPONSE", "Burrow read route returned invalid JSON.", {
          failureKind: "json-parse",
          requestDiagnostic: diagnostic,
        });
      }
      const bodyRecord = isRecord(body) ? body : {};
      const attempts = Array.isArray(bodyRecord.attempts) ? bodyRecord.attempts : [];
      diagnostic = {
        ...diagnostic,
        httpStatus: response.status,
        requestDurationMs: Math.round(performance.now() - startedAt),
        routeReached: response.headers.get("x-rescora-route-reached") === "true",
        externalRpcRequestAttempted: response.headers.get("x-rescora-rpc-attempted") === "true",
        requestId: response.headers.get("x-rescora-request-id") ?? requestId,
        ...(typeof bodyRecord.errorCode === "string" ? { errorCode: bodyRecord.errorCode } : {}),
        ...(typeof bodyRecord.failureKind === "string"
          ? { failureKind: bodyRecord.failureKind }
          : {}),
        ...(typeof bodyRecord.errorCode === "string"
          ? {
              failureStage: attempts.length > 0 ? "provider-rpc" : "route-request-or-validation",
            }
          : {}),
        attempts,
      };
      if (!response.ok) {
        throw remoteError(body, response.status, diagnostic);
      }
      if (!isRecord(body) || !Object.prototype.hasOwnProperty.call(body, "view")) {
        throw new NearRpcError("MALFORMED_RESPONSE", "Burrow read route response is invalid.", {
          failureKind: "invalid-view",
        });
      }
      const view = body.view;
      if (!isRecord(view) || !Object.prototype.hasOwnProperty.call(view, "data")) {
        throw new NearRpcError(
          "MALFORMED_RESPONSE",
          "Burrow read route omitted decoded view data.",
          {
            failureKind: "invalid-view",
          },
        );
      }
      const data = jsonClone(view.data);
      if (input.validateData && !input.validateData(data)) {
        throw new NearRpcError("MALFORMED_RESPONSE", "Decoded contract data failed validation.", {
          failureKind: "invalid-view",
        });
      }
      const provenance = validateProvenance(view.provenance, input, args, block);
      return Object.freeze({
        data: data as T,
        provenance,
        validation: "rpc-envelope-and-json-decoded" as const,
      });
    } catch (error) {
      if (!diagnostic.failureStage) {
        diagnostic = {
          ...diagnostic,
          failureStage: diagnostic.routeReached ? "response-validation" : "browser-to-api-route",
          ...(error instanceof NearRpcError ? { errorCode: error.code } : {}),
        };
      }
      throw error;
    } finally {
      if (diagnostic.requestDurationMs === 0) {
        diagnostic = {
          ...diagnostic,
          requestDurationMs: Math.round(performance.now() - startedAt),
        };
      }
      this.onDiagnostic?.(diagnostic);
      clearTimeout(timer);
    }
  }
}
