import { describe, expect, it, vi } from "vitest";
import { NearRpcClient, NearRpcError } from "../near-rpc/client";
import {
  BURROW_TESTNET_ACCOUNT,
  BurrowPositionReadError,
  BurrowPositionReader,
  GET_ACCOUNT_ALL_POSITIONS_METHOD,
  toAssessmentPositionEvidence,
  toPositionSnapshot,
} from "./positions";

const SYNTHETIC_ACCOUNT = "alice.testnet";
const SYNTHETIC_HASH = "1111111111111111111111111111111111111111111";
const SYNTHETIC_ROWS = {
  account_id: SYNTHETIC_ACCOUNT,
  supplied: [{ token_id: "usdc.testnet", apr: "0.01", balance: "1200", shares: "1200" }],
  positions: {
    "synthetic-position-1": {
      collateral: [{ token_id: "usdc.testnet", apr: "0.01", balance: "1000", shares: "1000" }],
      borrowed: [{ token_id: "usdt.testnet", apr: "0.04", balance: "500", shares: "500" }],
    },
  },
};

function mockRpcFor(data: unknown) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id: string };
    const bytes = [...new TextEncoder().encode(JSON.stringify(data))];
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { result: bytes, block_height: 275_783_334, block_hash: SYNTHETIC_HASH },
      }),
    );
  }) as unknown as typeof fetch;
}

function reader(fetchImpl: typeof fetch) {
  return new BurrowPositionReader(
    new NearRpcClient({
      network: "testnet",
      endpoint: "https://rpc.testnet.near.org",
      fetchImpl,
      retryDelayMs: 0,
    }),
  );
}

describe("BurrowPositionReader (synthetic RHEA SDK-shaped fixtures)", () => {
  it("reads and structurally validates a position view with its block provenance", async () => {
    const fetchImpl = mockRpcFor(SYNTHETIC_ROWS);
    const result = await reader(fetchImpl).readAccountPositions(SYNTHETIC_ACCOUNT);

    expect(result.accountId).toBe(SYNTHETIC_ACCOUNT);
    expect(result.positionStatus).toBe("returned");
    expect(result.positions["synthetic-position-1"]?.collateral[0]).toEqual({
      tokenId: "usdc.testnet",
      aprRaw: "0.01",
      balanceRaw: "1000",
      sharesRaw: "1000",
    });
    expect(result.positions["synthetic-position-1"]?.borrowed[0]?.tokenId).toBe("usdt.testnet");
    expect(result.rawResponse).toEqual(SYNTHETIC_ROWS);
    expect(result.provenance).toMatchObject({
      network: "testnet",
      contractAccountId: BURROW_TESTNET_ACCOUNT,
      methodName: GET_ACCOUNT_ALL_POSITIONS_METHOD,
      requestArguments: { account_id: SYNTHETIC_ACCOUNT },
      blockHeight: "275783334",
      blockHash: SYNTHETIC_HASH,
    });
    expect(result.completeness.status).toBe("unverified");

    const call = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body)) as {
      method: string;
      params: {
        request_type: string;
        account_id: string;
        method_name: string;
        args_base64: string;
      };
    };
    expect(call.method).toBe("query");
    expect(call.params).toMatchObject({
      request_type: "call_function",
      account_id: BURROW_TESTNET_ACCOUNT,
      method_name: GET_ACCOUNT_ALL_POSITIONS_METHOD,
    });
    expect(JSON.parse(atob(call.params.args_base64))).toEqual({ account_id: SYNTHETIC_ACCOUNT });
  });

  it("never upgrades source-declared data into verified assessment evidence", async () => {
    const result = await reader(mockRpcFor(SYNTHETIC_ROWS)).readAccountPositions(SYNTHETIC_ACCOUNT);
    const snapshot = toPositionSnapshot(result);
    expect(snapshot.source).toMatchObject({
      contractId: BURROW_TESTNET_ACCOUNT,
      method: GET_ACCOUNT_ALL_POSITIONS_METHOD,
      args: { account_id: SYNTHETIC_ACCOUNT },
      blockHeight: "275783334",
      blockHash: SYNTHETIC_HASH,
    });
    expect(toAssessmentPositionEvidence(result)).toMatchObject({
      status: "unavailable",
    });
  });

  it("rejects a response associated with a different account", async () => {
    await expect(
      reader(mockRpcFor({ ...SYNTHETIC_ROWS, account_id: "bob.testnet" })).readAccountPositions(
        SYNTHETIC_ACCOUNT,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects malformed position structures instead of returning a partial snapshot", async () => {
    const malformed = {
      ...SYNTHETIC_ROWS,
      positions: {
        "synthetic-position-1": {
          collateral: [{ token_id: "usdc.testnet", apr: "0.1", balance: 1000, shares: "1000" }],
          borrowed: [],
        },
      },
    };
    await expect(
      reader(mockRpcFor(malformed)).readAccountPositions(SYNTHETIC_ACCOUNT),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("preserves an empty view result but does not claim the account has no positions", async () => {
    const result = await reader(
      mockRpcFor({
        account_id: SYNTHETIC_ACCOUNT,
        supplied: [],
        positions: {},
      }),
    ).readAccountPositions(SYNTHETIC_ACCOUNT);
    expect(Object.keys(result.positions)).toHaveLength(0);
    expect(result.completeness.status).toBe("unverified");
  });

  it("preserves a null view as no returned account-position record without inventing rows", async () => {
    const result = await reader(mockRpcFor(null)).readAccountPositions(SYNTHETIC_ACCOUNT);
    expect(result.positionStatus).toBe("no-record");
    expect(result.rawResponse).toBeNull();
    expect(Object.keys(result.positions)).toHaveLength(0);
    expect(result.completeness.reason).toContain("does not prove the account has no position");
    expect(() => toPositionSnapshot(result)).toThrowError(/no position snapshot was created/i);
    expect(toAssessmentPositionEvidence(result)).toMatchObject({ status: "unavailable" });
  });

  it("returns distinct account and RPC failures", async () => {
    await expect(
      reader(mockRpcFor(SYNTHETIC_ROWS)).readAccountPositions("ALICE.testnet"),
    ).rejects.toMatchObject({ code: "INVALID_ACCOUNT" });
    const failedFetch = vi.fn(
      async () => new Response("unavailable", { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(
      reader(failedFetch).readAccountPositions(SYNTHETIC_ACCOUNT),
    ).rejects.toBeInstanceOf(BurrowPositionReadError);
    await expect(reader(failedFetch).readAccountPositions(SYNTHETIC_ACCOUNT)).rejects.toMatchObject(
      { code: "RPC_FAILURE" },
    );
  });

  it("identifies a browser-to-API transport failure without claiming providers failed", async () => {
    const rpc = {
      callFunction: vi.fn(async () => {
        throw new NearRpcError("NETWORK_FAILURE", "API route was unreachable", {
          failureKind: "transport",
          failureStage: "browser-to-api-route",
          attempts: [],
        });
      }),
    };
    const positionReader = new BurrowPositionReader(rpc);

    await expect(positionReader.readAccountPositions(SYNTHETIC_ACCOUNT)).rejects.toMatchObject({
      code: "RPC_FAILURE",
      message:
        "The browser did not receive a response from the Burrow read API route; provider diagnostics are unavailable.",
      cause: {
        details: {
          failureStage: "browser-to-api-route",
          attempts: [],
        },
      },
    });
  });
});
