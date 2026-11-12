import { describe, expect, it, vi } from "vitest";
import { NearRpcClient, NearRpcError, type NearRpcClientOptions } from "./client";

const SYNTHETIC_BLOCK_HASH = "1111111111111111111111111111111111111111111";
const SYNTHETIC_CONTRACT = "burrow.services.ref-labs.testnet";
const TESTNET_ENDPOINT = "https://rpc.testnet.near.org";
const TESTNET_PUBLIC_KEY = "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa";

function rpcResponse(id: string, result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status });
}

function callResult(data: unknown, overrides: Record<string, unknown> = {}) {
  const bytes = [...new TextEncoder().encode(JSON.stringify(data))];
  return {
    result: bytes,
    block_height: 42,
    block_hash: SYNTHETIC_BLOCK_HASH,
    ...overrides,
  };
}

function makeClient(
  fetchImpl: typeof fetch,
  options: Partial<NearRpcClientOptions> = {},
): NearRpcClient {
  return new NearRpcClient({
    network: "testnet",
    endpoint: TESTNET_ENDPOINT,
    fetchImpl,
    retryDelayMs: 0,
    ...options,
  });
}

describe("NearRpcClient (synthetic RPC fixtures)", () => {
  it("invokes a Window-bound fetch with the globalThis receiver", async () => {
    const fetchImpl = function (this: unknown, _url: RequestInfo | URL, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      const request = JSON.parse(String(init?.body)) as { id: string };
      return Promise.resolve(rpcResponse(request.id, { nonce: 0, permission: "FullAccess" }));
    } as typeof fetch;
    const client = makeClient(fetchImpl, { maxRetries: 0 });

    await expect(client.verifyAccessKey("alice.testnet", TESTNET_PUBLIC_KEY)).resolves.toBe(true);
  });

  it("verifies the exact wallet account and public key using a Testnet access-key query", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        id: string;
        params: Record<string, unknown>;
      };
      expect(request.params).toEqual({
        request_type: "view_access_key",
        finality: "final",
        account_id: "alice.testnet",
        public_key: TESTNET_PUBLIC_KEY,
      });
      return rpcResponse(request.id, { nonce: 0, permission: "FullAccess", block_height: 42 });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(client.verifyAccessKey("alice.testnet", TESTNET_PUBLIC_KEY)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "[RESCORA Wallet Debug]",
      expect.objectContaining({
        event: "identity.rpc.request.completed",
        endpoint: "https://rpc.testnet.near.org/",
        outcome: "resolved",
        accessKeyFound: true,
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("alice.testnet");
    expect(JSON.stringify(info.mock.calls)).not.toContain(TESTNET_PUBLIC_KEY);
    info.mockRestore();
  });

  it("rejects malformed account IDs and public keys before sending an RPC request", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const client = makeClient(fetchMock);
    await expect(client.verifyAccessKey("Alice.testnet", TESTNET_PUBLIC_KEY)).rejects.toMatchObject(
      {
        code: "INVALID_ACCOUNT_ID",
      },
    );
    await expect(
      client.verifyAccessKey("alice.testnet", "ed25519:not-a-key"),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the exact Testnet access key is absent or the RPC response is invalid", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const rpcError = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: `Access key for alice.testnet (${TESTNET_PUBLIC_KEY}) does not exist`,
          },
        }),
      );
    }) as unknown as typeof fetch;
    await expect(
      makeClient(rpcError).verifyAccessKey("alice.testnet", TESTNET_PUBLIC_KEY),
    ).rejects.toMatchObject({ code: "ACCESS_KEY_NOT_FOUND" });
    expect(info).toHaveBeenCalledWith(
      "[RESCORA Wallet Debug]",
      expect.objectContaining({
        event: "identity.rpc.request.completed",
        endpoint: "https://rpc.testnet.near.org/",
        outcome: "error",
        accessKeyFound: false,
        reason: "ACCESS_KEY_NOT_FOUND",
        rpcErrorCode: -32000,
        rpcErrorMessage: expect.stringContaining("[account redacted]"),
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("alice.testnet");
    expect(JSON.stringify(info.mock.calls)).not.toContain(TESTNET_PUBLIC_KEY);
    info.mockRestore();

    const malformed = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return rpcResponse(request.id, { nonce: "bad", permission: null });
    }) as unknown as typeof fetch;
    await expect(
      makeClient(malformed).verifyAccessKey("alice.testnet", TESTNET_PUBLIC_KEY),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("reports Testnet RPC timeouts and keeps the session verification fail closed", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl, { timeoutMs: 5, maxRetries: 0 });
    await expect(client.verifyAccessKey("alice.testnet", TESTNET_PUBLIC_KEY)).rejects.toMatchObject(
      {
        code: "TIMEOUT",
      },
    );
    expect(info).toHaveBeenCalledWith(
      "[RESCORA Wallet Debug]",
      expect.objectContaining({
        event: "identity.rpc.request.completed",
        outcome: "timeout",
        accessKeyFound: false,
        reason: "TIMEOUT",
      }),
    );
    info.mockRestore();
  });

  it("classifies a browser transport failure without logging wallet identity material", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch (possible CORS or browser network failure)");
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl, { maxRetries: 0 });

    await expect(client.verifyAccessKey("alice.testnet", TESTNET_PUBLIC_KEY)).rejects.toMatchObject(
      {
        code: "NETWORK_FAILURE",
      },
    );
    const serialized = JSON.stringify(info.mock.calls);
    expect(serialized).toContain('"transportFailureKind":"cors-or-cross-origin"');
    expect(serialized).not.toContain("alice.testnet");
    expect(serialized).not.toContain(TESTNET_PUBLIC_KEY);
    info.mockRestore();
  });

  it("returns decoded view data with immutable source and block provenance", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: string;
        params: Record<string, unknown>;
      };
      expect(request.params.request_type).toBe("call_function");
      expect(request.params.account_id).toBe(SYNTHETIC_CONTRACT);
      expect(request.params.method_name).toBe("get_config");
      return rpcResponse(request.id, callResult({ enabled: true }));
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl, { now: () => new Date("2026-11-04T00:00:00.000Z") });

    const result = await client.callFunction({
      contractAccountId: SYNTHETIC_CONTRACT,
      methodName: "get_config",
      args: { mode: "synthetic" },
    });

    expect(result.data).toEqual({ enabled: true });
    expect(result.provenance).toEqual({
      network: "testnet",
      contractAccountId: SYNTHETIC_CONTRACT,
      methodName: "get_config",
      requestArguments: { mode: "synthetic" },
      blockHeight: "42",
      blockHash: SYNTHETIC_BLOCK_HASH,
      rpcEndpoint: TESTNET_ENDPOINT + "/",
      retrievedAt: "2026-11-04T00:00:00.000Z",
    });
    expect(result.validation).toBe("rpc-envelope-and-json-decoded");
    expect(Object.isFrozen(result.provenance.requestArguments)).toBe(true);
  });

  it.each([
    ["non-JSON body", async () => new Response("not json")],
    [
      "mismatched request id",
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { id: string };
        return rpcResponse(`${request.id}-wrong`, callResult(null));
      },
    ],
    [
      "invalid UTF-8 JSON bytes",
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { id: string };
        return rpcResponse(request.id, { ...callResult(null), result: [255] });
      },
    ],
  ])("rejects malformed responses (%s)", async (_label, response) => {
    const client = makeClient(response as typeof fetch);
    await expect(
      client.callFunction({ contractAccountId: SYNTHETIC_CONTRACT, methodName: "get_x" }),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("surfaces JSON-RPC and contract execution errors as structured errors", async () => {
    const rpcErrorFetch = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000 } }),
      );
    }) as unknown as typeof fetch;
    await expect(
      makeClient(rpcErrorFetch).callFunction({
        contractAccountId: SYNTHETIC_CONTRACT,
        methodName: "get_x",
      }),
    ).rejects.toMatchObject({ code: "RPC_ERROR" });

    const contractErrorFetch = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return rpcResponse(request.id, { ...callResult(null), error: "synthetic panic" });
    }) as unknown as typeof fetch;
    await expect(
      makeClient(contractErrorFetch).callFunction({
        contractAccountId: SYNTHETIC_CONTRACT,
        methodName: "get_x",
      }),
    ).rejects.toMatchObject({ code: "RPC_ERROR" });
  });

  it("aborts timed out requests and reports a typed timeout", async () => {
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl, { timeoutMs: 10, maxRetries: 0 });
    await expect(
      client.callFunction({ contractAccountId: SYNTHETIC_CONTRACT, methodName: "get_x" }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("retries a transient HTTP failure a bounded number of times", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      if (fetchMock.mock.calls.length === 1) return new Response("busy", { status: 503 });
      return rpcResponse(request.id, callResult("ok"));
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const result = await makeClient(fetchImpl, { maxRetries: 1 }).callFunction({
      contractAccountId: SYNTHETIC_CONTRACT,
      methodName: "get_x",
    });
    expect(result.data).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects mainnet, unknown, and credential-bearing endpoints", () => {
    for (const endpoint of [
      "https://rpc.mainnet.near.org",
      "https://example.com",
      "https://user:password@rpc.testnet.near.org",
    ]) {
      expect(() => new NearRpcClient({ network: "testnet", endpoint })).toThrow(NearRpcError);
    }
  });

  it("rejects missing block provenance and a response from another requested block", async () => {
    const missingFetch = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return rpcResponse(request.id, callResult(null, { block_hash: undefined }));
    }) as unknown as typeof fetch;
    await expect(
      makeClient(missingFetch).callFunction({
        contractAccountId: SYNTHETIC_CONTRACT,
        methodName: "get_x",
      }),
    ).rejects.toMatchObject({ code: "MISSING_PROVENANCE" });

    const mismatchFetch = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return rpcResponse(request.id, callResult(null));
    }) as unknown as typeof fetch;
    await expect(
      makeClient(mismatchFetch).callFunction({
        contractAccountId: SYNTHETIC_CONTRACT,
        methodName: "get_x",
        block: { blockId: 41 },
      }),
    ).rejects.toMatchObject({ code: "BLOCK_CONTEXT_MISMATCH" });

    const hashMismatchFetch = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return rpcResponse(request.id, callResult(null, { block_hash: "2".repeat(43) }));
    }) as unknown as typeof fetch;
    await expect(
      makeClient(hashMismatchFetch).callFunction({
        contractAccountId: SYNTHETIC_CONTRACT,
        methodName: "get_x",
        block: { blockHash: SYNTHETIC_BLOCK_HASH },
      }),
    ).rejects.toMatchObject({ code: "BLOCK_CONTEXT_MISMATCH" });
  });

  it("rejects malformed contract account IDs before making a request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.callFunction({ contractAccountId: "Burrow.testnet", methodName: "get_x" }),
    ).rejects.toMatchObject({ code: "INVALID_ACCOUNT_ID" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
