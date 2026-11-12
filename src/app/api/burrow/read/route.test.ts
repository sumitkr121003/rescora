import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, handleBurrowRead } from "./route";
import {
  BURROW_TESTNET_ACCOUNT,
  BurrowPositionReadError,
  BurrowPositionReader,
} from "@/lib/burrow/positions";
import { TESTNET_IDENTITY_RPC_ENDPOINTS } from "@/lib/near-rpc/client";
import { NearRpcProxyClient } from "@/lib/near-rpc/proxy-client";

const ACCOUNT = "sumitkr03.testnet";
const BLOCK_HASH = "1".repeat(43);
const FASTNEAR_ENDPOINT = "https://rpc.testnet.fastnear.com/";
const FASTNEAR_API_KEY = "test-fastnear-secret";
const CONFIGURED_ENDPOINTS = [
  FASTNEAR_ENDPOINT,
  ...TESTNET_IDENTITY_RPC_ENDPOINTS.filter(
    (endpoint) => new URL(endpoint).hostname !== "rpc.testnet.fastnear.com",
  ),
];

beforeEach(() => vi.stubEnv("FASTNEAR_API_KEY", FASTNEAR_API_KEY));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function request(
  overrides: Record<string, unknown> = {},
  options: { block?: Record<string, unknown>; origin?: string } = {},
) {
  const body = {
    contractAccountId: BURROW_TESTNET_ACCOUNT,
    methodName: "get_account_all_positions",
    args: { account_id: ACCOUNT },
    block: options.block ?? { finality: "final" },
    ...overrides,
  };
  return new Request("http://localhost/api/burrow/read", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.origin ? { origin: options.origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

function rpcSuccess(positions: unknown = {}) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body)) as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    expect(input.method).toBe("query");
    expect(input.params).toMatchObject({
      request_type: "call_function",
      account_id: BURROW_TESTNET_ACCOUNT,
      method_name: "get_account_all_positions",
    });
    const data = {
      account_id: ACCOUNT,
      supplied: [],
      positions,
    };
    const bytes = [...new TextEncoder().encode(JSON.stringify(data))];
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: input.id,
        result: {
          result: bytes,
          block_height: 123,
          block_hash: BLOCK_HASH,
        },
      }),
    );
  });
}

async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("same-origin Burrow read route", () => {
  it("executes an empty positions result on the primary endpoint without inventing rows", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchImpl = rpcSuccess();
    const response = await handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
    const body = await responseBody(response);
    expect(response.status).toBe(200);
    expect(body.view).toMatchObject({
      data: { account_id: ACCOUNT, positions: {} },
      provenance: {
        network: "testnet",
        contractAccountId: BURROW_TESTNET_ACCOUNT,
        methodName: "get_account_all_positions",
        blockHash: BLOCK_HASH,
      },
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(FASTNEAR_ENDPOINT);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${FASTNEAR_API_KEY}`,
    );
    expect(JSON.stringify(body)).not.toContain(FASTNEAR_API_KEY);
    expect(JSON.stringify(info.mock.calls)).not.toContain(ACCOUNT);
    expect(JSON.stringify(info.mock.calls)).not.toContain(FASTNEAR_API_KEY);
    expect(JSON.stringify(info.mock.calls)).toContain("record-returned");
    info.mockRestore();
  });

  it("reports missing FastNear configuration without making any RPC request", async () => {
    vi.stubEnv("FASTNEAR_API_KEY", "");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const response = await handleBurrowRead(request(), fetchImpl);
    expect(response.status).toBe(503);
    expect(await responseBody(response)).toEqual({
      errorCode: "FASTNEAR_NOT_CONFIGURED",
      failureKind: "provider-not-configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await responseBody(await GET())).toEqual({ fastNearConfigured: false });
  });

  it("reports only a configuration boolean to the browser status request", async () => {
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await responseBody(response);
    expect(body).toEqual({ fastNearConfigured: true });
    expect(JSON.stringify(body)).not.toContain(FASTNEAR_API_KEY);
  });

  it("fails over after an authenticated FastNear provider failure without forwarding its key", async () => {
    const success = rpcSuccess();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === FASTNEAR_ENDPOINT) {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${FASTNEAR_API_KEY}`);
        return new Response("temporarily unavailable", { status: 503 });
      }
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return success(url, init);
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      CONFIGURED_ENDPOINTS.slice(0, 2),
    );
    expect(JSON.stringify(await responseBody(response))).not.toContain(FASTNEAR_API_KEY);
    expect(JSON.stringify(info.mock.calls)).not.toContain(FASTNEAR_API_KEY);
  });

  it("fails over after the authenticated FastNear provider times out", async () => {
    vi.useFakeTimers();
    const success = rpcSuccess();
    const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) !== FASTNEAR_ENDPOINT) return success(url, init);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const pending = handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(5_001);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      CONFIGURED_ENDPOINTS.slice(0, 2),
    );
    expect(await responseBody(response)).toMatchObject({
      attempts: [
        {
          endpoint: "rpc.testnet.fastnear.com",
          provider: "FastNear",
          apiKeyConfigured: true,
          authorizationAttached: true,
          requestDurationMs: expect.any(Number),
          failureKind: "timeout",
          failureCategory: "timeout",
          nearRpcErrorCode: "TIMEOUT",
        },
        { endpoint: "rpc.testnet.near.org", outcome: "resolved" },
      ],
    });
  });

  it.each([
    [401, "unauthorized", false],
    [403, "forbidden", true],
    [429, "rate-limited", true],
    [503, "provider-server-error", true],
  ] as const)(
    "records FastNear HTTP %s without exposing credentials",
    async (httpStatus, httpFailureKind, shouldFailOver) => {
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
        if (String(url) === FASTNEAR_ENDPOINT)
          return new Response("provider error", { status: httpStatus });
        throw new TypeError("Failed to fetch");
      });
      const response = await handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
      const body = await responseBody(response);
      const attempts = body.attempts as Array<Record<string, unknown>>;

      expect(response.status).not.toBe(200);
      expect(attempts[0]).toMatchObject({
        provider: "FastNear",
        apiKeyConfigured: true,
        authorizationAttached: true,
        requestDurationMs: expect.any(Number),
        httpStatus,
        httpFailureKind,
        failureCategory: "http",
        nearRpcErrorCode: "HTTP_ERROR",
        nearRpcErrorMessage: `NEAR testnet RPC returned HTTP ${httpStatus}.`,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(shouldFailOver ? 3 : 1);
      expect(JSON.stringify(body)).not.toContain(FASTNEAR_API_KEY);
      expect(JSON.stringify(info.mock.calls)).not.toContain(FASTNEAR_API_KEY);
    },
  );

  it.each([
    ["ENOTFOUND", "dns"],
    ["ECONNREFUSED", "connection"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
  ] as const)("categorizes FastNear transport failure %s", async (causeCode, category) => {
    const cause = Object.assign(new Error("provider transport failure"), {
      code: causeCode,
      hostname: "rpc.testnet.fastnear.com",
    });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === FASTNEAR_ENDPOINT) {
        throw Object.assign(new Error("fetch failed"), { cause });
      }
      return rpcSuccess()(url, init);
    });
    const response = await handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
    const body = await responseBody(response);
    expect(response.status).toBe(200);
    expect((body.attempts as Array<Record<string, unknown>>)[0]).toMatchObject({
      provider: "FastNear",
      apiKeyConfigured: true,
      authorizationAttached: true,
      requestDurationMs: expect.any(Number),
      failureCategory: category,
      nearRpcErrorCode: "NETWORK_FAILURE",
    });
  });

  it("preserves populated positions and provenance", async () => {
    const positions = { p1: { collateral: [], borrowed: [] } };
    const fetchImpl = rpcSuccess(positions);
    const response = await handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
    const body = await responseBody(response);
    expect(body.view).toMatchObject({
      data: { account_id: ACCOUNT, positions },
      provenance: { blockHeight: "123", blockHash: BLOCK_HASH },
    });
  });

  it("fails over from primary to secondary on transport failure", async () => {
    const success = rpcSuccess();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === FASTNEAR_ENDPOINT) throw new TypeError("Failed to fetch");
      return success(url, init);
    });
    const response = await handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
    const body = await responseBody(response);
    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      CONFIGURED_ENDPOINTS.slice(0, 2),
    );
    expect(body.attempts).toMatchObject([
      { endpoint: "rpc.testnet.fastnear.com", failureKind: "transport" },
      { endpoint: "rpc.testnet.near.org", outcome: "resolved" },
    ]);
  });

  it("fails over on retryable upstream HTTP 403 from a public provider", async () => {
    const success = rpcSuccess();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === FASTNEAR_ENDPOINT) {
        return new Response("provider access denied", { status: 403 });
      }
      return success(url, init);
    });
    const response = await handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      CONFIGURED_ENDPOINTS.slice(0, 2),
    );
  });

  it("reaches the final Testnet endpoint after the first two fail", async () => {
    const success = rpcSuccess();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) !== CONFIGURED_ENDPOINTS[2]) throw new TypeError("Failed to fetch");
      return success(url, init);
    });
    const response = await handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(CONFIGURED_ENDPOINTS);
  });

  it("fails over after a timed-out primary endpoint", async () => {
    const success = rpcSuccess();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === FASTNEAR_ENDPOINT) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      return success(url, init);
    });
    const response = await handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      CONFIGURED_ENDPOINTS.slice(0, 2),
    );
  }, 10_000);

  it("allows a slow primary response inside the per-endpoint budget", async () => {
    vi.useFakeTimers();
    try {
      const success = rpcSuccess();
      const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
        const resolved = success(url, init);
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => void resolved.then(resolve, reject), 3_100);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      });
      const pending = handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(3_100);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await responseBody(response)).toMatchObject({
        attempts: [{ endpoint: "rpc.testnet.fastnear.com", outcome: "resolved" }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails over when the RPC connection fails while reading the response body", async () => {
    const success = rpcSuccess();
    const bodyFailure = Object.assign(new Error("socket reset; privateKey=must-not-log"), {
      code: "ECONNRESET",
      cause: Object.assign(new Error("connection reset"), {
        code: "UND_ERR_SOCKET",
        syscall: "read",
        hostname: "rpc.testnet.near.org",
      }),
    });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === FASTNEAR_ENDPOINT) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(bodyFailure);
            },
          }),
        );
      }
      return success(url, init);
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const response = await handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
      const body = await responseBody(response);
      expect(response.status).toBe(200);
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
        CONFIGURED_ENDPOINTS.slice(0, 2),
      );
      expect((body.attempts as unknown[])[0]).toMatchObject({
        endpoint: "rpc.testnet.fastnear.com",
        failureKind: "transport",
        transportFailureKind: "connection-reset-or-unreachable",
        transportCauses: [
          { name: "Error", code: "ECONNRESET" },
          {
            name: "Error",
            code: "UND_ERR_SOCKET",
            syscall: "read",
            hostname: "rpc.testnet.near.org",
          },
        ],
      });
      expect(JSON.stringify(body)).not.toContain("must-not-log");
      expect(JSON.stringify(info.mock.calls)).not.toContain("must-not-log");
    } finally {
      info.mockRestore();
    }
  });

  it("reports all endpoints unavailable and never contacts Mainnet", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL) => {
      void _url;
      throw new TypeError("Failed to fetch");
    });
    const response = await handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
    const body = await responseBody(response);
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ errorCode: "NETWORK_FAILURE", failureKind: "transport" });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(CONFIGURED_ENDPOINTS);
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).join(" ")).not.toContain("mainnet");
  });

  it("returns sanitized diagnostics for every failed provider through the client error chain", async () => {
    const providerFetch = vi.fn(async (url: RequestInfo | URL) => {
      const host = new URL(String(url)).hostname;
      const code =
        host === "rpc.testnet.fastnear.com"
          ? "ENOTFOUND"
          : host === "rpc.testnet.near.org"
            ? "ECONNREFUSED"
            : "ERR_TLS_CERT_ALTNAME_INVALID";
      throw Object.assign(
        new Error(`transport failed ${FASTNEAR_API_KEY} privateKey=do-not-return`),
        {
          cause: Object.assign(new Error("upstream transport failure"), {
            code,
            hostname: host,
          }),
        },
      );
    });
    const proxyFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const routeRequest = new Request(new URL(String(input), "http://localhost"), init);
      return handleBurrowRead(routeRequest, providerFetch as unknown as typeof fetch);
    });
    const reader = new BurrowPositionReader(new NearRpcProxyClient(proxyFetch as typeof fetch));

    let readError: unknown;
    try {
      await reader.readAccountPositions(ACCOUNT);
    } catch (error) {
      readError = error;
    }

    expect(readError).toBeInstanceOf(BurrowPositionReadError);
    expect(readError).toMatchObject({ code: "RPC_FAILURE" });
    const wrappedCause = (readError as BurrowPositionReadError).cause;
    expect(wrappedCause).toMatchObject({
      code: "NETWORK_FAILURE",
      details: {
        failureKind: "transport",
        attempts: [
          {
            provider: "FastNear",
            apiKeyConfigured: true,
            authorizationAttached: true,
            requestDurationMs: expect.any(Number),
            failureCategory: "dns",
          },
          {
            provider: "NEAR RPC",
            apiKeyConfigured: true,
            authorizationAttached: false,
            failureCategory: "connection",
          },
          {
            provider: "Pagoda",
            apiKeyConfigured: true,
            authorizationAttached: false,
            failureCategory: "tls",
          },
        ],
      },
    });
    const serializedCause = JSON.stringify(wrappedCause);
    expect(serializedCause).not.toContain(FASTNEAR_API_KEY);
    expect(serializedCause).not.toContain("do-not-return");
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it("does not fail over on JSON-RPC errors", async () => {
    const privateKey = "ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const providerMessage = `bad request ${FASTNEAR_API_KEY} Bearer leaked-token ${privateKey} privateKey=wallet-super-secret seed phrase=alpha beta gamma https://rpc.testnet.fastnear.com/?apiKey=secret`;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)) as { id: string };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: input.id,
          error: { code: -32000, message: providerMessage },
        }),
      );
    });
    const response = await handleBurrowRead(request(), fetchImpl as unknown as typeof fetch);
    const body = await responseBody(response);
    expect(body).toMatchObject({
      failureKind: "json-rpc",
      attempts: [
        {
          provider: "FastNear",
          apiKeyConfigured: true,
          authorizationAttached: true,
          requestDurationMs: expect.any(Number),
          httpStatus: 200,
          failureCategory: "json-rpc",
          nearRpcErrorCode: "RPC_ERROR",
          nearRpcErrorMessage: "NEAR RPC returned a query error.",
          jsonRpcErrorCode: -32000,
          jsonRpcErrorMessage: expect.stringContaining("[redacted]"),
        },
      ],
    });
    for (const secret of [
      FASTNEAR_API_KEY,
      "leaked-token",
      privateKey,
      "wallet-super-secret",
      "alpha beta gamma",
      "apiKey=secret",
    ]) {
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("distinguishes invalid JSON and invalid view responses", async () => {
    const invalidJson = vi.fn(async () => new Response("not-json"));
    const jsonResponse = await handleBurrowRead(request(), invalidJson as unknown as typeof fetch);
    expect(await responseBody(jsonResponse)).toMatchObject({
      failureKind: "json-parse",
      attempts: [
        {
          provider: "FastNear",
          apiKeyConfigured: true,
          authorizationAttached: true,
          requestDurationMs: expect.any(Number),
          httpStatus: 200,
          failureCategory: "response-validation",
          nearRpcErrorCode: "MALFORMED_RESPONSE",
          nearRpcErrorMessage: "NEAR RPC response was not valid JSON.",
        },
      ],
    });
    expect(invalidJson).toHaveBeenCalledTimes(1);

    const malformedView = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)) as { id: string };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: input.id,
          result: { result: [255], block_height: 1, block_hash: BLOCK_HASH },
        }),
      );
    });
    const viewResponse = await handleBurrowRead(
      request(),
      malformedView as unknown as typeof fetch,
    );
    expect(await responseBody(viewResponse)).toMatchObject({
      failureKind: "invalid-view",
      attempts: [
        {
          provider: "FastNear",
          failureCategory: "response-validation",
          nearRpcErrorCode: "MALFORMED_RESPONSE",
          nearRpcErrorMessage: "call_function result is not valid UTF-8 JSON.",
          httpStatus: 200,
        },
      ],
    });
    expect(malformedView).toHaveBeenCalledTimes(1);
  });

  it("does not combine data when a pinned snapshot hash differs", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)) as { id: string };
      const bytes = [
        ...new TextEncoder().encode(
          JSON.stringify({ account_id: ACCOUNT, supplied: [], positions: {} }),
        ),
      ];
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: input.id,
          result: { result: bytes, block_height: 123, block_hash: "2".repeat(43) },
        }),
      );
    });
    const response = await handleBurrowRead(
      request({}, { block: { blockHash: BLOCK_HASH } }),
      fetchImpl as unknown as typeof fetch,
    );
    expect(await responseBody(response)).toMatchObject({ failureKind: "snapshot-mismatch" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects arbitrary endpoints, methods, contracts, and cross-origin requests", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(
      (await handleBurrowRead(request({ endpoint: "https://rpc.mainnet.near.org" }), fetchImpl))
        .status,
    ).toBe(400);
    expect((await handleBurrowRead(request({ methodName: "query" }), fetchImpl)).status).toBe(400);
    expect(
      (await handleBurrowRead(request({ contractAccountId: "evil.testnet" }), fetchImpl)).status,
    ).toBe(400);
    expect(
      (await handleBurrowRead(request({}, { origin: "https://attacker.example" }), fetchImpl))
        .status,
    ).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends only Testnet read requests and honors a client abort", async () => {
    const controller = new AbortController();
    const aborted = new Request("http://localhost/api/burrow/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractAccountId: BURROW_TESTNET_ACCOUNT,
        methodName: "get_account_all_positions",
        args: { account_id: ACCOUNT },
        block: { finality: "final" },
      }),
      signal: controller.signal,
    });
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    const pending = handleBurrowRead(aborted, fetchImpl);
    setTimeout(() => controller.abort(), 30);
    const response = await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(499);
  });
});
