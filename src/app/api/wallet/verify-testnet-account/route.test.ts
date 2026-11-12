import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTNET_IDENTITY_RPC_ENDPOINTS } from "@/lib/near-rpc/client";
import { POST } from "./route";

const ACCOUNT_ID = "alice.testnet";
const PUBLIC_KEY = "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa";
const OTHER_PUBLIC_KEY = "ed25519:5qT71w3baQV4FzRRnWcc2oxSTvZc4x2jHc7wEDySMnN6";

function request(body: unknown, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/wallet/verify-testnet-account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function rpcResponse(result: unknown, id = "rescora-read-1"): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(name: string, id = "rescora-read-1"): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: "Server error",
      data: { name: "HANDLER_ERROR", cause: { name } },
    },
  });
}

function validAccessKey(): Response {
  return rpcResponse({ nonce: 0, permission: "FullAccess", block_height: 42 });
}

function installFetch(implementation: typeof fetch): ReturnType<typeof vi.fn> {
  const mock = vi.fn(implementation);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Testnet wallet identity verification route", () => {
  it("verifies on primary using the exact read-only access-key query", async () => {
    const fetchMock = installFetch(async (url, init) => {
      expect(String(url)).toBe(TESTNET_IDENTITY_RPC_ENDPOINTS[0]);
      expect(init?.method).toBe("POST");
      const payload = JSON.parse(String(init?.body));
      expect(payload.method).toBe("query");
      expect(payload.params).toEqual({
        request_type: "view_access_key",
        finality: "final",
        account_id: ACCOUNT_ID,
        public_key: PUBLIC_KEY,
      });
      return validAccessKey();
    }) as typeof fetch;
    const response = await POST(request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }));
    await expect(response.json()).resolves.toMatchObject({
      verified: true,
      verifiedEndpoint: "rpc.testnet.near.org",
      attempts: [{ outcome: "verified" }],
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails over from primary transport failure to secondary success", async () => {
    const endpoints: string[] = [];
    const requestParams: unknown[] = [];
    installFetch(async (url, init) => {
      endpoints.push(String(url));
      requestParams.push(JSON.parse(String(init?.body)).params);
      if (endpoints.length === 1) throw new TypeError("Failed to fetch");
      return validAccessKey();
    });
    const response = await POST(request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }));
    await expect(response.json()).resolves.toMatchObject({
      verified: true,
      verifiedEndpoint: "rpc.testnet.pagoda.co",
      attempts: [
        { endpoint: "rpc.testnet.near.org", code: "NETWORK_FAILURE" },
        { endpoint: "rpc.testnet.pagoda.co", outcome: "verified" },
      ],
    });
    expect(endpoints).toEqual(TESTNET_IDENTITY_RPC_ENDPOINTS.slice(0, 2));
    expect(requestParams).toEqual([
      {
        request_type: "view_access_key",
        finality: "final",
        account_id: ACCOUNT_ID,
        public_key: PUBLIC_KEY,
      },
      {
        request_type: "view_access_key",
        finality: "final",
        account_id: ACCOUNT_ID,
        public_key: PUBLIC_KEY,
      },
    ]);
  });

  it("fails over on an explicit upstream JSON-RPC availability error", async () => {
    let callCount = 0;
    const fetchMock = installFetch(async () => {
      callCount += 1;
      if (callCount === 1) return rpcError("NODE_IS_SYNCING");
      return validAccessKey();
    });
    const response = await POST(request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }));
    await expect(response.json()).resolves.toMatchObject({
      verified: true,
      verifiedEndpoint: "rpc.testnet.pagoda.co",
      attempts: [{ code: "RPC_ERROR" }, { outcome: "verified" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the final Testnet fallback when primary and secondary fail", async () => {
    const endpoints: string[] = [];
    installFetch(async (url) => {
      endpoints.push(String(url));
      if (endpoints.length === 1) throw new TypeError("Failed to fetch");
      if (endpoints.length === 2) return new Response("busy", { status: 503 });
      return validAccessKey();
    });
    const response = await POST(request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }));
    await expect(response.json()).resolves.toMatchObject({
      verified: true,
      verifiedEndpoint: "rpc.testnet.fastnear.com",
      attempts: [
        { code: "NETWORK_FAILURE" },
        { code: "HTTP_ERROR", httpStatus: 503 },
        { outcome: "verified" },
      ],
    });
    expect(endpoints).toEqual(TESTNET_IDENTITY_RPC_ENDPOINTS);
  });

  it("continues after an endpoint-specific HTTP 403 from the Testnet provider", async () => {
    let callCount = 0;
    installFetch(async () => {
      callCount += 1;
      if (callCount === 1) throw new TypeError("Failed to fetch");
      if (callCount === 2) return new Response("forbidden", { status: 403 });
      return validAccessKey();
    });
    const response = await POST(request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }));
    await expect(response.json()).resolves.toMatchObject({
      verified: true,
      verifiedEndpoint: "rpc.testnet.fastnear.com",
      attempts: [
        { code: "NETWORK_FAILURE" },
        { code: "HTTP_ERROR", httpStatus: 403 },
        { outcome: "verified" },
      ],
    });
  });

  it("fails closed and reports all attempts when all endpoints are unavailable", async () => {
    const endpoints: string[] = [];
    installFetch(async (url) => {
      endpoints.push(String(url));
      if (endpoints.length === 1) throw new TypeError("Failed to fetch");
      if (endpoints.length === 2) return new Response("busy", { status: 503 });
      throw new TypeError("Network error");
    });
    const response = await POST(request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      verified: false,
      code: "NETWORK_FAILURE",
      attempts: [
        { endpoint: "rpc.testnet.near.org", code: "NETWORK_FAILURE" },
        { endpoint: "rpc.testnet.pagoda.co", code: "HTTP_ERROR", httpStatus: 503 },
        { endpoint: "rpc.testnet.fastnear.com", code: "NETWORK_FAILURE" },
      ],
    });
    expect(endpoints).toEqual(TESTNET_IDENTITY_RPC_ENDPOINTS);
  });

  it.each([
    ["UNKNOWN_ACCOUNT", "ACCOUNT_NOT_FOUND"],
    ["UNKNOWN_ACCESS_KEY", "ACCESS_KEY_NOT_FOUND"],
  ])("does not fail over for identity absence (%s)", async (cause, code) => {
    const fetchMock = installFetch(async () => rpcError(cause));
    const response = await POST(request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ verified: false, code });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an echoed public-key mismatch and does not fail over", async () => {
    const fetchMock = installFetch(async () =>
      rpcResponse({ nonce: 0, permission: "FullAccess", public_key: OTHER_PUBLIC_KEY }),
    );
    const response = await POST(request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      verified: false,
      code: "PUBLIC_KEY_MISMATCH",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an echoed account mismatch and does not fail over", async () => {
    const fetchMock = installFetch(async () =>
      rpcResponse({
        nonce: 0,
        permission: "FullAccess",
        account_id: "bob.testnet",
      }),
    );
    const response = await POST(request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }));
    await expect(response.json()).resolves.toMatchObject({
      verified: false,
      code: "ACCOUNT_MISMATCH",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not fail over on malformed JSON-RPC responses", async () => {
    const fetchMock = installFetch(async () =>
      rpcResponse({ nonce: 0, permission: "FullAccess" }, "wrong-id"),
    );
    const response = await POST(request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      verified: false,
      code: "MALFORMED_RESPONSE",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not treat upstream request errors as availability failures", async () => {
    const fetchMock = installFetch(async () => new Response("bad request", { status: 400 }));
    const response = await POST(request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }));
    await expect(response.json()).resolves.toMatchObject({
      verified: false,
      code: "HTTP_ERROR",
      attempts: [{ endpoint: "rpc.testnet.near.org", httpStatus: 400 }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("times out each endpoint, tries the Testnet sequence, and fails closed", async () => {
    vi.useFakeTimers();
    const endpoints: string[] = [];
    installFetch(
      vi.fn((url, init) => {
        endpoints.push(String(url));
        return new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }) as typeof fetch,
    );
    const pending = POST(request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }));
    for (let tick = 0; tick < 20 && endpoints.length === 0; tick += 1) await Promise.resolve();
    expect(endpoints).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_001);
    const response = await pending;
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      verified: false,
      code: "TIMEOUT",
      attempts: expect.arrayContaining([
        expect.objectContaining({ endpoint: "rpc.testnet.near.org", code: "TIMEOUT" }),
        expect.objectContaining({ endpoint: "rpc.testnet.pagoda.co", code: "TIMEOUT" }),
        expect.objectContaining({ endpoint: "rpc.testnet.fastnear.com", code: "TIMEOUT" }),
      ]),
    });
    expect(endpoints).toEqual(TESTNET_IDENTITY_RPC_ENDPOINTS);
  });

  it("honors client abort and does not continue to other endpoints", async () => {
    const controller = new AbortController();
    const fetchMock = installFetch(
      vi.fn(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            (init?.signal as AbortSignal).addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ) as typeof fetch,
    );
    const pending = POST(
      request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }, controller.signal),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    await expect(response.json()).resolves.toMatchObject({
      verified: false,
      code: "CLIENT_ABORTED",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects arbitrary endpoints, malformed identity input, large bodies, and cross-origin requests", async () => {
    const fetchMock = installFetch(async () => validAccessKey());
    const malformed = await POST(
      request({
        accountId: ACCOUNT_ID,
        publicKey: "not-a-public-key",
        endpoint: "https://rpc.mainnet.near.org",
      }),
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ code: "INVALID_IDENTITY_INPUT" });

    const oversized = await POST(
      request({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY, extra: "x".repeat(3_000) }),
    );
    expect(oversized.status).toBe(413);

    const crossOrigin = new Request("http://localhost/api/wallet/verify-testnet-account", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://untrusted.example",
      },
      body: JSON.stringify({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY }),
    });
    expect((await POST(crossOrigin)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never includes Mainnet in endpoint configuration", () => {
    expect(TESTNET_IDENTITY_RPC_ENDPOINTS).toEqual([
      "https://rpc.testnet.near.org/",
      "https://rpc.testnet.pagoda.co/",
      "https://rpc.testnet.fastnear.com/",
    ]);
    expect(TESTNET_IDENTITY_RPC_ENDPOINTS.every((endpoint) => endpoint.includes("testnet"))).toBe(
      true,
    );
  });
});
