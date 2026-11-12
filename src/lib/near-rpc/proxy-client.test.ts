import { describe, expect, it, vi } from "vitest";
import { NearRpcError } from "./client";
import { NearRpcProxyClient } from "./proxy-client";

const HASH = "1".repeat(43);

function viewResponse(blockHash = HASH) {
  return {
    view: {
      data: { enable_pyth_oracle: true },
      provenance: {
        network: "testnet",
        contractAccountId: "burrow.services.ref-labs.testnet",
        methodName: "get_config",
        requestArguments: {},
        blockHeight: "100",
        blockHash,
        rpcEndpoint: "https://rpc.testnet.pagoda.co/",
        retrievedAt: "2026-11-08T00:00:00.000Z",
      },
    },
    attempts: [
      { endpoint: "rpc.testnet.near.org", outcome: "failed", failureKind: "transport" },
      { endpoint: "rpc.testnet.pagoda.co", outcome: "resolved" },
    ],
  };
}

describe("NearRpcProxyClient", () => {
  it("uses the same-origin route and preserves pinned block provenance", async () => {
    const onDiagnostic = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/burrow/read");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-rescora-request-id")).toMatch(/^[0-9a-f-]{36}$/i);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        contractAccountId: "burrow.services.ref-labs.testnet",
        methodName: "get_config",
        args: {},
        block: { blockHash: HASH },
      });
      expect(body).not.toHaveProperty("endpoint");
      return Response.json(viewResponse(), {
        headers: {
          "x-rescora-route-reached": "true",
          "x-rescora-rpc-attempted": "true",
          "x-rescora-request-id": "5354d2ec-0f83-4b91-8d89-1a6fc0f78c6b",
        },
      });
    });
    const client = new NearRpcProxyClient(
      fetchImpl as unknown as typeof fetch,
      18_000,
      onDiagnostic,
    );
    const result = await client.callFunction({
      contractAccountId: "burrow.services.ref-labs.testnet",
      methodName: "get_config",
      block: { blockHash: HASH },
    });
    expect(result.data).toEqual({ enable_pyth_oracle: true });
    expect(result.provenance.blockHash).toBe(HASH);
    expect(result.provenance.rpcEndpoint).toBe("https://rpc.testnet.pagoda.co/");
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        httpMethod: "POST",
        route: "/api/burrow/read",
        httpStatus: 200,
        routeReached: true,
        externalRpcRequestAttempted: true,
        requestId: "5354d2ec-0f83-4b91-8d89-1a6fc0f78c6b",
        attempts: viewResponse().attempts,
      }),
    );
  });

  it("rejects response provenance from a different block", async () => {
    const client = new NearRpcProxyClient(
      vi.fn(async () => Response.json(viewResponse("2".repeat(43)))) as unknown as typeof fetch,
    );
    await expect(
      client.callFunction({
        contractAccountId: "burrow.services.ref-labs.testnet",
        methodName: "get_config",
        block: { blockHash: HASH },
      }),
    ).rejects.toMatchObject({ code: "BLOCK_CONTEXT_MISMATCH" });
  });

  it("retains endpoint-level failure categories without exposing request values", async () => {
    const client = new NearRpcProxyClient(
      vi.fn(async () =>
        Response.json(
          {
            errorCode: "NETWORK_FAILURE",
            failureKind: "transport",
            attempts: [
              {
                endpoint: "rpc.testnet.fastnear.com",
                provider: "FastNear",
                apiKeyConfigured: true,
                authorizationAttached: true,
                requestDurationMs: 5000,
                failureCategory: "dns",
                outcome: "failed",
                failureKind: "transport",
              },
              {
                endpoint: "rpc.testnet.near.org",
                provider: "NEAR RPC",
                apiKeyConfigured: true,
                authorizationAttached: false,
                requestDurationMs: 10,
                failureCategory: "connection",
                outcome: "failed",
                failureKind: "transport",
              },
            ],
          },
          { status: 502 },
        ),
      ) as unknown as typeof fetch,
    );
    try {
      await client.callFunction({
        contractAccountId: "burrow.services.ref-labs.testnet",
        methodName: "get_config",
      });
      throw new Error("expected route failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NearRpcError);
      expect(error).toMatchObject({
        code: "NETWORK_FAILURE",
        details: {
          failureKind: "transport",
          attempts: [
            { provider: "FastNear", failureCategory: "dns", authorizationAttached: true },
            { provider: "NEAR RPC", failureCategory: "connection" },
          ],
        },
      });
    }
  });

  it("distinguishes a browser-to-route transport error from provider attempts", async () => {
    const onDiagnostic = vi.fn();
    const client = new NearRpcProxyClient(
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
      18_000,
      onDiagnostic,
    );
    await expect(
      client.callFunction({
        contractAccountId: "burrow.services.ref-labs.testnet",
        methodName: "get_config",
      }),
    ).rejects.toMatchObject({
      code: "NETWORK_FAILURE",
      details: {
        failureKind: "transport",
        failureStage: "browser-to-api-route",
        attempts: [],
        requestDiagnostic: expect.objectContaining({
          httpMethod: "POST",
          route: "/api/burrow/read",
          httpStatus: null,
          routeReached: false,
          externalRpcRequestAttempted: false,
          failureStage: "browser-to-api-route",
        }),
      },
    });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ routeReached: false, externalRpcRequestAttempted: false }),
    );
  });
});
