import { utils } from "near-api-js";
import { logWalletDebug } from "@/lib/wallet/diagnostics";

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type BlockContext =
  | Readonly<{ finality: "final" }>
  | Readonly<{ blockHash: string }>
  | Readonly<{ blockHeight: string | number }>
  | Readonly<{ blockId: string | number }>;

export type ViewProvenance = Readonly<{
  network: "testnet";
  contractAccountId: string;
  methodName: string;
  requestArguments: Readonly<Record<string, JsonValue>>;
  blockHeight: string;
  blockHash: string;
  rpcEndpoint: string;
  retrievedAt: string;
}>;

export type ViewResponse<T> = Readonly<{
  data: T;
  provenance: ViewProvenance;
  /** Transport and JSON decoding only; this is not contract/schema authenticity. */
  validation: "rpc-envelope-and-json-decoded";
}>;

export type NearRpcErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_ACCOUNT_ID"
  | "ACCOUNT_NOT_FOUND"
  | "INVALID_REQUEST"
  | "TIMEOUT"
  | "CLIENT_ABORTED"
  | "NETWORK_FAILURE"
  | "HTTP_ERROR"
  | "RPC_ERROR"
  | "ACCESS_KEY_NOT_FOUND"
  | "ACCOUNT_MISMATCH"
  | "PUBLIC_KEY_MISMATCH"
  | "MALFORMED_RESPONSE"
  | "MISSING_PROVENANCE"
  | "BLOCK_CONTEXT_MISMATCH";

export class NearRpcError extends Error {
  constructor(
    readonly code: NearRpcErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "NearRpcError";
  }
}

export type NearRpcClientOptions = Readonly<{
  network: "testnet";
  endpoint: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}>;

export type ViewFunctionInput<T extends JsonValue = JsonValue> = Readonly<{
  contractAccountId: string;
  methodName: string;
  args?: Readonly<Record<string, JsonValue>>;
  block?: BlockContext;
  validateData?: (data: JsonValue) => data is T;
}>;

export interface NearRpcReader {
  callFunction<T extends JsonValue = JsonValue>(
    input: ViewFunctionInput<T>,
  ): Promise<ViewResponse<T>>;
}

export const TESTNET_IDENTITY_RPC_ENDPOINTS = [
  "https://rpc.testnet.near.org/",
  "https://rpc.testnet.pagoda.co/",
  "https://rpc.testnet.fastnear.com/",
] as const;

const TESTNET_RPC_HOSTS = new Set([
  "rpc.testnet.near.org",
  "rpc.testnet.pagoda.co",
  "rpc.testnet.fastnear.com",
  "archival-rpc.testnet.near.org",
  "test.rpc.fastnear.com",
  "near-testnet.drpc.org",
  "testnet-rpc.intea.rs",
]);
const ACCOUNT_ID_PATTERN =
  /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;
const BLOCK_HASH_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const MAX_RETRIES = 3;

type RpcQueryResponse = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

type CallFunctionResult = {
  result?: unknown;
  block_height?: unknown;
  block_hash?: unknown;
  error?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonValue(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null || seen.has(value)) {
    throw new Error("not a JSON value");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("not a JSON object");
    for (const item of Object.values(value)) assertJsonValue(item, seen);
  }
  seen.delete(value);
}

function cloneJson(value: unknown, label: string): JsonValue {
  let serialized: string | undefined;
  try {
    assertJsonValue(value);
    serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("not JSON serializable");
    return JSON.parse(serialized) as JsonValue;
  } catch {
    throw new NearRpcError("INVALID_REQUEST", `${label} must be JSON serializable.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function encodeArgs(args: Readonly<Record<string, JsonValue>>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeResult(bytes: unknown): JsonValue {
  if (
    !Array.isArray(bytes) ||
    bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new NearRpcError("MALFORMED_RESPONSE", "call_function result must be a byte array.");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new NearRpcError("MALFORMED_RESPONSE", "call_function result is not valid UTF-8 JSON.");
  }
}

function validateBlock(
  result: CallFunctionResult,
  requestedBlock: BlockContext,
): { blockHeight: string; blockHash: string } {
  const height = result.block_height;
  const hash = result.block_hash;
  if (
    !(typeof height === "number" && Number.isSafeInteger(height) && height >= 0) &&
    !(typeof height === "string" && /^\d+$/.test(height))
  ) {
    throw new NearRpcError("MISSING_PROVENANCE", "RPC response omitted a valid block height.", {
      rpcResult: result.result,
      observedBlockHeight: height,
      observedBlockHash: hash,
    });
  }
  if (typeof hash !== "string" || !BLOCK_HASH_PATTERN.test(hash)) {
    throw new NearRpcError("MISSING_PROVENANCE", "RPC response omitted a valid block hash.", {
      rpcResult: result.result,
      observedBlockHeight: height,
      observedBlockHash: hash,
    });
  }
  const blockHeight = String(height);
  if (
    "blockHash" in requestedBlock ||
    "blockHeight" in requestedBlock ||
    "blockId" in requestedBlock
  ) {
    const requestedValue =
      "blockHash" in requestedBlock
        ? requestedBlock.blockHash
        : "blockHeight" in requestedBlock
          ? requestedBlock.blockHeight
          : requestedBlock.blockId;
    const requested = String(requestedValue);
    const requestedIsHeight =
      "blockHeight" in requestedBlock ||
      ("blockId" in requestedBlock &&
        (typeof requestedBlock.blockId === "number" || /^\d+$/.test(requested)));
    const matchesRequested = requestedIsHeight ? requested === blockHeight : requested === hash;
    if (!matchesRequested) {
      throw new NearRpcError(
        "BLOCK_CONTEXT_MISMATCH",
        "RPC returned a block different from the explicitly requested block.",
        {
          requestedBlock,
          observedBlockHeight: blockHeight,
          observedBlockHash: hash,
          rpcResult: result.result,
        },
      );
    }
  }
  return { blockHeight, blockHash: hash };
}

function validateEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new NearRpcError("INVALID_CONFIGURATION", "RPC endpoint must be a valid HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !TESTNET_RPC_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new NearRpcError(
      "INVALID_CONFIGURATION",
      "RPC endpoint must be an approved HTTPS NEAR testnet endpoint without embedded credentials.",
    );
  }
  return url.toString();
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof NearRpcError)) return true;
  if (error.code === "NETWORK_FAILURE") return true;
  if (error.code !== "HTTP_ERROR") return false;
  const status = error.details?.status;
  return status === 408 || status === 429 || (typeof status === "number" && status >= 500);
}

type SafeTransportCause = Readonly<{
  name?: string;
  code?: string;
  syscall?: string;
  hostname?: string;
}>;

function safeTransportCauseChain(error: unknown): SafeTransportCause[] {
  const causes: SafeTransportCause[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  while (
    typeof current === "object" &&
    current !== null &&
    causes.length < 4 &&
    !seen.has(current)
  ) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    const cause: SafeTransportCause = {
      ...(typeof record.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(record.name)
        ? { name: record.name.slice(0, 40) }
        : {}),
      ...(typeof record.code === "string" && /^[A-Z0-9_-]{1,48}$/i.test(record.code)
        ? { code: record.code.slice(0, 48) }
        : {}),
      ...(typeof record.syscall === "string" && /^[a-z0-9_-]{1,40}$/i.test(record.syscall)
        ? { syscall: record.syscall.slice(0, 40) }
        : {}),
      ...(typeof record.hostname === "string" && /^[a-z0-9.-]{1,253}$/i.test(record.hostname)
        ? { hostname: record.hostname.slice(0, 253) }
        : {}),
    };
    if (Object.keys(cause).length) causes.push(cause);
    current = record.cause;
  }
  return causes;
}

function transportFailure(error: unknown): NearRpcError {
  const causes = safeTransportCauseChain(error);
  const signatures = causes.map((cause) => `${cause.name ?? ""} ${cause.code ?? ""}`).join(" ");
  const transportFailureKind = classifyTransportFailure(
    signatures,
    error instanceof Error ? error.message : "",
  );
  return new NearRpcError("NETWORK_FAILURE", "NEAR testnet RPC transport failed.", {
    cause: causes[0]?.name ?? "unknown",
    transportFailureKind,
    transportCauses: causes,
  });
}

export class NearRpcClient implements NearRpcReader {
  readonly network = "testnet" as const;
  readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private requestSequence = 0;

  constructor(options: NearRpcClientOptions) {
    if (options.network !== "testnet") {
      throw new NearRpcError("INVALID_CONFIGURATION", "Only NEAR testnet is supported.");
    }
    this.endpoint = validateEndpoint(options.endpoint);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 150;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      !Number.isSafeInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      this.maxRetries > MAX_RETRIES ||
      !Number.isSafeInteger(this.retryDelayMs) ||
      this.retryDelayMs < 0
    ) {
      throw new NearRpcError("INVALID_CONFIGURATION", "Invalid timeout or retry configuration.");
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  async callFunction<T extends JsonValue = JsonValue>(
    input: ViewFunctionInput<T>,
  ): Promise<ViewResponse<T>> {
    if (!ACCOUNT_ID_PATTERN.test(input.contractAccountId)) {
      throw new NearRpcError("INVALID_ACCOUNT_ID", "Contract account ID is invalid.");
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(input.methodName)) {
      throw new NearRpcError("INVALID_REQUEST", "View method name is invalid.");
    }
    const clonedArgs = cloneJson(input.args ?? {}, "View arguments");
    if (!isRecord(clonedArgs)) {
      throw new NearRpcError("INVALID_REQUEST", "View arguments must be a JSON object.");
    }
    const frozenArgs = deepFreeze(clonedArgs as Record<string, JsonValue>);
    const block = input.block ?? { finality: "final" as const };
    const blockParams =
      "blockHash" in block
        ? { block_id: block.blockHash }
        : "blockHeight" in block
          ? { block_id: block.blockHeight }
          : "blockId" in block
            ? { block_id: block.blockId }
            : { finality: block.finality };
    const response = await this.query({
      request_type: "call_function",
      ...blockParams,
      account_id: input.contractAccountId,
      method_name: input.methodName,
      args_base64: encodeArgs(frozenArgs),
    });
    if (!isRecord(response.result)) {
      throw new NearRpcError("MALFORMED_RESPONSE", "RPC query result is not an object.");
    }
    const result = response.result as CallFunctionResult;
    if (result.error !== undefined) {
      throw new NearRpcError("RPC_ERROR", "Contract view returned an execution error.", {
        rpcError: result.error,
      });
    }
    const blockContext = validateBlock(result, block);
    const data = decodeResult(result.result);
    if (input.validateData && !input.validateData(data)) {
      throw new NearRpcError("MALFORMED_RESPONSE", "Decoded contract data failed validation.");
    }
    return Object.freeze({
      data: data as T,
      provenance: Object.freeze({
        network: this.network,
        contractAccountId: input.contractAccountId,
        methodName: input.methodName,
        requestArguments: frozenArgs,
        ...blockContext,
        rpcEndpoint: this.endpoint,
        retrievedAt: this.now().toISOString(),
      }),
      validation: "rpc-envelope-and-json-decoded" as const,
    });
  }

  /** Confirms an exact account/public-key pair exists on this client's Testnet. */
  async verifyAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    if (!isNearAccountId(accountId)) {
      logWalletDebug("identity.input.rejected", {
        reason: "invalid-account-id-format",
        accountIdReturned: typeof accountId === "string" && accountId.length > 0,
        accountIdFormatValid: false,
        publicKeyReturned: typeof publicKey === "string" && publicKey.length > 0,
        publicKeyFormatValid: isNearPublicKey(publicKey),
      });
      throw new NearRpcError("INVALID_ACCOUNT_ID", "Wallet account ID is invalid.");
    }
    if (!isNearPublicKey(publicKey)) {
      logWalletDebug("identity.input.rejected", {
        reason: "invalid-public-key-format",
        accountIdReturned: true,
        accountIdFormatValid: true,
        publicKeyReturned: typeof publicKey === "string" && publicKey.length > 0,
        publicKeyFormatValid: false,
      });
      throw new NearRpcError("INVALID_REQUEST", "Wallet public key is malformed or unsupported.");
    }
    const startedAt = Date.now();
    logWalletDebug("identity.rpc.request.started", {
      endpoint: this.endpoint,
      requestType: "view_access_key",
      accountIdFormatValid: true,
      publicKeyFormatValid: true,
    });
    try {
      const response = await this.query({
        request_type: "view_access_key",
        finality: "final",
        account_id: accountId,
        public_key: publicKey,
      });
      if (!isRecord(response.result)) {
        throw new NearRpcError("MALFORMED_RESPONSE", "Access-key response is invalid.");
      }
      const result = response.result;
      if (result.account_id !== undefined && result.account_id !== accountId) {
        throw new NearRpcError(
          "ACCOUNT_MISMATCH",
          "Testnet RPC returned a different account than the requested account.",
        );
      }
      // NEAR's standard view_access_key result does not echo public_key. If a
      // provider does echo it, reject any disagreement with the exact query key.
      if (result.public_key !== undefined && result.public_key !== publicKey) {
        throw new NearRpcError(
          "PUBLIC_KEY_MISMATCH",
          "Testnet RPC returned a different public key than the requested key.",
        );
      }
      const validNonce =
        (typeof result.nonce === "number" &&
          Number.isSafeInteger(result.nonce) &&
          result.nonce >= 0) ||
        (typeof result.nonce === "string" && /^\d+$/.test(result.nonce));
      const permission = result.permission;
      const validPermission =
        permission === "FullAccess" ||
        (isRecord(permission) &&
          ["FunctionCall", "GasKeyFullAccess", "GasKeyFunctionCall"].some((name) =>
            isRecord(permission[name]),
          ));
      const validBlockHeight =
        result.block_height === undefined ||
        (typeof result.block_height === "number" &&
          Number.isSafeInteger(result.block_height) &&
          result.block_height >= 0) ||
        (typeof result.block_height === "string" && /^\d+$/.test(result.block_height));
      const validBlockHash =
        result.block_hash === undefined ||
        (typeof result.block_hash === "string" && BLOCK_HASH_PATTERN.test(result.block_hash));
      if (!validNonce || !validPermission || !validBlockHeight || !validBlockHash) {
        throw new NearRpcError("MALFORMED_RESPONSE", "Access-key response is incomplete.");
      }
      logWalletDebug("identity.rpc.request.completed", {
        endpoint: this.endpoint,
        outcome: "resolved",
        elapsedMs: Math.max(0, Date.now() - startedAt),
        accessKeyFound: true,
        reason: "exact-account-key-pair-found-on-testnet",
      });
      return true;
    } catch (error) {
      const rpcError = error instanceof NearRpcError ? error : null;
      const rpcPayload = isRecord(rpcError?.details?.rpcError) ? rpcError.details?.rpcError : null;
      const rpcErrorNames = rpcPayload ? rpcPayloadNames(rpcPayload) : [];
      const payloadCode = rpcPayload?.code;
      const rpcErrorCode =
        typeof payloadCode === "number" ||
        (typeof payloadCode === "string" && /^[A-Z0-9_-]{1,40}$/.test(payloadCode))
          ? payloadCode
          : (rpcError?.code ?? "UNKNOWN");
      const rawMessage = rpcPayload
        ? rpcPayloadMessage(rpcPayload)
        : error instanceof Error
          ? error.message
          : "Unknown RPC error.";
      const rpcErrorMessage = sanitizeRpcMessage(rawMessage, accountId, publicKey);
      const accessKeyNotFound =
        rpcErrorNames.includes("UNKNOWN_ACCESS_KEY") ||
        /access key.*(not found|does not exist)|key.*not found/i.test(rawMessage);
      const accountNotFound =
        rpcErrorNames.includes("UNKNOWN_ACCOUNT") ||
        /account.*(not found|does not exist|unknown account)/i.test(rawMessage);
      const upstreamTimeout = rpcErrorNames.some((name) =>
        ["TIMEOUT_ERROR", "REQUEST_TIMEOUT", "UPSTREAM_TIMEOUT"].includes(name),
      );
      const failureCode = accessKeyNotFound
        ? "ACCESS_KEY_NOT_FOUND"
        : accountNotFound
          ? "ACCOUNT_NOT_FOUND"
          : (rpcError?.code ?? "RPC_ERROR");
      const failureMessage = accessKeyNotFound
        ? "The exact account/public-key pair was not found on NEAR Testnet."
        : accountNotFound
          ? "The account was not found on NEAR Testnet."
          : rpcErrorMessage;
      if ((accessKeyNotFound || accountNotFound) && rpcError?.code === "RPC_ERROR") {
        logWalletDebug("identity.rpc.request.completed", {
          endpoint: this.endpoint,
          outcome: "error",
          elapsedMs: Math.max(0, Date.now() - startedAt),
          accessKeyFound: false,
          reason: accessKeyNotFound ? "ACCESS_KEY_NOT_FOUND" : "ACCOUNT_NOT_FOUND",
          rpcErrorCode,
          rpcErrorMessage,
        });
        throw new NearRpcError(
          accessKeyNotFound ? "ACCESS_KEY_NOT_FOUND" : "ACCOUNT_NOT_FOUND",
          failureMessage,
          {
            rpcErrorCode,
            rpcErrorMessage,
          },
        );
      }
      if (upstreamTimeout && rpcError?.code === "RPC_ERROR") {
        throw new NearRpcError("TIMEOUT", "NEAR Testnet RPC reported an upstream timeout.", {
          rpcErrorCode,
        });
      }
      logWalletDebug("identity.rpc.request.completed", {
        endpoint: this.endpoint,
        outcome: rpcError?.code === "TIMEOUT" ? "timeout" : "error",
        elapsedMs: Math.max(0, Date.now() - startedAt),
        accessKeyFound: false,
        reason: failureCode,
        rpcErrorCode,
        rpcErrorMessage,
        ...(typeof error === "object" &&
        error !== null &&
        "details" in error &&
        isRecord((error as { details?: unknown }).details) &&
        typeof (error as { details: Record<string, unknown> }).details.transportFailureKind ===
          "string"
          ? {
              transportFailureKind: (error as { details: Record<string, string> }).details
                .transportFailureKind,
            }
          : {}),
      });
      if (error instanceof NearRpcError) {
        throw new NearRpcError(error.code, error.message, {
          ...error.details,
          rpcErrorCode,
          rpcErrorMessage: failureMessage,
        });
      }
      throw error;
    }
  }

  private async query(params: Readonly<Record<string, unknown>>): Promise<RpcQueryResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.queryOnce(params);
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries || !isRetryable(error)) throw error;
        if (this.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  private async queryOnce(params: Readonly<Record<string, unknown>>): Promise<RpcQueryResponse> {
    const id = `rescora-read-${++this.requestSequence}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await Reflect.apply(this.fetchImpl, globalThis, [
          this.endpoint,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method: "query", params }),
            signal: controller.signal,
          },
        ]);
      } catch (error) {
        if (controller.signal.aborted) {
          throw new NearRpcError(
            "TIMEOUT",
            `NEAR testnet RPC request timed out after ${this.timeoutMs}ms.`,
          );
        }
        throw transportFailure(error);
      }
      if (!response.ok) {
        throw new NearRpcError("HTTP_ERROR", `NEAR testnet RPC returned HTTP ${response.status}.`, {
          status: response.status,
        });
      }
      let responseText: string;
      try {
        responseText = await response.text();
      } catch (error) {
        if (controller.signal.aborted) {
          throw new NearRpcError(
            "TIMEOUT",
            `NEAR testnet RPC request timed out after ${this.timeoutMs}ms.`,
          );
        }
        throw transportFailure(error);
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(responseText) as unknown;
      } catch {
        throw new NearRpcError("MALFORMED_RESPONSE", "NEAR RPC response was not valid JSON.");
      }
      if (!isRecord(envelope)) {
        throw new NearRpcError("MALFORMED_RESPONSE", "NEAR RPC response envelope is invalid.");
      }
      if (envelope.error !== undefined) {
        throw new NearRpcError("RPC_ERROR", "NEAR RPC returned a query error.", {
          rpcError: envelope.error,
        });
      }
      if (
        envelope.jsonrpc !== "2.0" ||
        envelope.id !== id ||
        !Object.prototype.hasOwnProperty.call(envelope, "result")
      ) {
        throw new NearRpcError(
          "MALFORMED_RESPONSE",
          "NEAR RPC response did not match the request.",
        );
      }
      return envelope as RpcQueryResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

function classifyTransportFailure(name: string, message: string): string {
  const normalized = `${name} ${message}`.toLowerCase();
  if (/cors|cross-origin|access-control/.test(normalized)) return "cors-or-cross-origin";
  if (/dns|name resolution|enotfound|eai_again/.test(normalized)) return "dns-resolution";
  if (/refused|err_connection_refused|econnrefused/.test(normalized)) return "connection-refused";
  if (/timeout|timed out|etimedout|connect_timeout|headers_timeout/.test(normalized))
    return "connection-timeout";
  if (/tls|certificate|cert_|ssl/.test(normalized)) return "tls-failure";
  if (/socket|econnreset|ehostunreach|enetunreach|und_err_socket/.test(normalized))
    return "connection-reset-or-unreachable";
  if (/offline|network is unreachable|failed to fetch|load failed|networkerror/.test(normalized))
    return "browser-fetch-transport";
  return "unknown-transport";
}

export function isNearAccountId(value: string): boolean {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value);
}

export function isNearPublicKey(value: string): boolean {
  if (typeof value !== "string" || !value) return false;
  try {
    const parsedKey = utils.PublicKey.fromString(value);
    return (
      parsedKey.keyType === 0 && parsedKey.data.length === 32 && parsedKey.toString() === value
    );
  } catch {
    return false;
  }
}

function sanitizeRpcMessage(message: string, accountId: string, publicKey: string): string {
  return message
    .replaceAll(accountId, "[account redacted]")
    .replaceAll(publicKey, "[public key redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,50}/g, "[public key redacted]")
    .replace(/(private key|seed phrase|mnemonic)\s*[:=]\s*[^,;]+/gi, "$1: [redacted]")
    .slice(0, 240);
}

function rpcPayloadMessage(payload: Record<string, unknown>): string {
  const values = [payload.message, payload.data];
  const messages: string[] = [];
  for (const value of values) {
    if (typeof value === "string") messages.push(value);
    else if (isRecord(value)) {
      for (const key of ["message", "cause", "name", "info"]) {
        if (typeof value[key] === "string") messages.push(value[key] as string);
      }
    }
  }
  return messages.length > 0
    ? messages.join(" ").slice(0, 1000)
    : "NEAR RPC query returned an error.";
}

function rpcPayloadNames(payload: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || !isRecord(value)) return;
    if (typeof value.name === "string" && /^[A-Z0-9_]{1,64}$/.test(value.name)) {
      names.add(value.name);
    }
    visit(value.data, depth + 1);
    visit(value.cause, depth + 1);
  };
  visit(payload, 0);
  return [...names];
}
