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
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/burrow/read");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        contractAccountId: "burrow.services.ref-labs.testnet",
        methodName: "get_config",
        args: {},
        block: { blockHash: HASH },
      });
      expect(body).not.toHaveProperty("endpoint");
      return Response.json(viewResponse());
    });
    const client = new NearRpcProxyClient(fetchImpl as unknown as typeof fetch);
    const result = await client.callFunction({
      contractAccountId: "burrow.services.ref-labs.testnet",
      methodName: "get_config",
      block: { blockHash: HASH },
    });
    expect(result.data).toEqual({ enable_pyth_oracle: true });
    expect(result.provenance.blockHash).toBe(HASH);
    expect(result.provenance.rpcEndpoint).toBe("https://rpc.testnet.pagoda.co/");
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
              { endpoint: "rpc.testnet.near.org", outcome: "failed", failureKind: "transport" },
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
        details: { failureKind: "transport", attempts: [{ endpoint: "rpc.testnet.near.org" }] },
      });
    }
  });
});
