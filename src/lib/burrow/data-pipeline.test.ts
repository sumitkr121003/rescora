import { describe, expect, it, vi } from "vitest";
import { NearRpcClient } from "../near-rpc/client";
import { BurrowDataPipeline } from "./data-pipeline";
import { BURROW_TESTNET_ACCOUNT } from "./positions";

const ACCOUNT = "alice.testnet";
const BLOCK_HASH = "1111111111111111111111111111111111111111111";
const ORACLE = "pyth.testnet";
const NOW_SECONDS = 1_800_000_010;
const SDK_SHAPED_POSITIONS = {
  account_id: ACCOUNT,
  supplied: [],
  positions: {
    "synthetic-position": {
      collateral: [
        { token_id: "usdc.testnet", apr: "0.01", balance: "1000000", shares: "1000000" },
      ],
      borrowed: [{ token_id: "usdt.testnet", apr: "0.03", balance: "500000", shares: "500000" }],
    },
  },
};
const CONFIG = {
  enable_pyth_oracle: true,
  enable_price_oracle: false,
  pyth_oracle_account_id: ORACLE,
  oracle_account_id: "oracle.testnet",
  maximum_recency_duration_sec: 60,
};
const ASSETS = ["usdc.testnet", "usdt.testnet"].map((token_id) => ({
  token_id,
  config: {
    extra_decimals: 0,
    volatility_ratio: 10_000,
    can_use_as_collateral: true,
    can_borrow: true,
  },
}));
const MAPPINGS = Object.fromEntries(
  ["usdc.testnet", "usdt.testnet"].map((tokenId, index) => [
    tokenId,
    {
      decimals: 6,
      fraction_digits: 4,
      price_identifier: `synthetic-price-id-${index}`,
      extra_call: "",
      default_price: null,
    },
  ]),
);

function buildRpcFixture(
  options: { stale?: boolean; missingMetadata?: boolean; assetBlockMismatch?: boolean } = {},
) {
  const calls: Array<{
    contractId: string;
    methodName: string;
    args: unknown;
    params: Record<string, unknown>;
  }> = [];
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {
      id: string;
      params: Record<string, unknown>;
    };
    const encoded = request.params.args_base64;
    const args = typeof encoded === "string" ? JSON.parse(atob(encoded)) : {};
    const contractId = String(request.params.account_id);
    const methodName = String(request.params.method_name);
    calls.push({ contractId, methodName, args, params: request.params });

    let data: unknown;
    if (methodName === "get_account_all_positions") data = SDK_SHAPED_POSITIONS;
    else if (methodName === "get_config") data = CONFIG;
    else if (methodName === "get_assets_paged_detailed") data = ASSETS;
    else if (methodName === "get_all_token_pyth_infos") data = MAPPINGS;
    else if (methodName === "ft_metadata") {
      if (options.missingMetadata && contractId === "usdt.testnet") data = { decimals: "6" };
      else data = { spec: "ft-1.0.0", name: contractId, symbol: "SYN", decimals: 6 };
    } else if (methodName === "list_prices_no_older_than") {
      data = Object.fromEntries(
        ["synthetic-price-id-0", "synthetic-price-id-1"].map((priceId) => [
          priceId,
          {
            price: "100000000",
            conf: "1000",
            expo: -8,
            publish_time: options.stale ? NOW_SECONDS - 61 : NOW_SECONDS - 10,
          },
        ]),
      );
    } else throw new Error(`Unexpected synthetic view method: ${methodName}`);

    const blockHash =
      options.assetBlockMismatch && methodName === "get_assets_paged_detailed"
        ? "2".repeat(43)
        : BLOCK_HASH;
    const bytes = [...new TextEncoder().encode(JSON.stringify(data))];
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { result: bytes, block_height: 100, block_hash: blockHash },
      }),
    );
  });
  return { fetchMock: fetchMock as unknown as typeof fetch, calls };
}

function pipelineFor(fetchImpl: typeof fetch, options: { now?: () => Date } = {}) {
  return new BurrowDataPipeline(
    new NearRpcClient({
      network: "testnet",
      endpoint: "https://rpc.testnet.near.org",
      fetchImpl,
      retryDelayMs: 0,
    }),
    options,
  );
}

describe("BurrowDataPipeline (synthetic, pinned-SDK-shaped responses)", () => {
  it("reads positions, config, assets, metadata, mappings, and Pyth at one exact block", async () => {
    const fixture = buildRpcFixture();
    const result = await pipelineFor(fixture.fetchMock, {
      now: () => new Date(NOW_SECONDS * 1000),
    }).readAccountData(ACCOUNT);

    expect(result.status).toBe("complete-unverified");
    expect(result.block).toEqual({ height: "100", hash: BLOCK_HASH });
    expect(result.config.status).toBe("unverified");
    expect(result.assets.status).toBe("unverified");
    expect(result.tokenMetadata["usdc.testnet"]?.status).toBe("unverified");
    expect(result.pythMappings.status).toBe("unverified");
    expect(result.pythPrices.status).toBe("unverified");
    expect(result.pythFreshness["usdc.testnet"]).toEqual({
      status: "within-requested-age-unverified-source",
      ageSeconds: 10,
    });
    expect(result.assessmentEvidence.status).toBe("unavailable");
    expect(result.assetCoverage).toBe("unverified");
    expect(result.positionCompleteness).toBe("unverified");
    expect(result.positions.rawResponse).toEqual(SDK_SHAPED_POSITIONS);
    expect(result.assets.status === "unverified" && result.assets.rawResponse).toEqual(ASSETS);
    expect(fixture.calls.every((call) => call.params.request_type === "call_function")).toBe(true);
    expect(fixture.calls.every((call) => call.contractId !== "")).toBe(true);
    expect(fixture.calls[0]?.params.finality).toBe("final");
    expect(fixture.calls.slice(1).every((call) => call.params.block_id === BLOCK_HASH)).toBe(true);
    expect(
      fixture.calls.find((call) => call.methodName === "get_assets_paged_detailed")?.args,
    ).toEqual({});
    expect(fixture.calls.find((call) => call.methodName === "get_config")?.contractId).toBe(
      BURROW_TESTNET_ACCOUNT,
    );
    expect(fixture.calls.find((call) => call.methodName === "ft_metadata")?.args).toEqual({});
    expect(
      fixture.calls.find((call) => call.methodName === "list_prices_no_older_than")?.args,
    ).toEqual({
      price_ids: ["synthetic-price-id-0", "synthetic-price-id-1"],
      age: 60,
    });
  });

  it("rejects a same-height but different block hash and retains earlier raw views", async () => {
    const fixture = buildRpcFixture({ assetBlockMismatch: true });
    const result = await pipelineFor(fixture.fetchMock, {
      now: () => new Date(NOW_SECONDS * 1000),
    }).readAccountData(ACCOUNT);

    expect(result.status).toBe("incomplete");
    expect(result.config.status).toBe("unverified");
    expect(result.assets).toMatchObject({ status: "unavailable" });
    expect(result.assets.status === "unavailable" ? result.assets.diagnostic : null).toMatchObject({
      errorCode: "BLOCK_CONTEXT_MISMATCH",
      details: {
        observedBlockHeight: "100",
        observedBlockHash: "2".repeat(43),
        rpcResult: expect.any(Array),
      },
    });
    expect(result.pythMappings.status).toBe("unverified");
    expect(result.assessmentEvidence.status).toBe("unavailable");
  });

  it("rejects stale Pyth values while retaining the raw stale response", async () => {
    const fixture = buildRpcFixture({ stale: true });
    const result = await pipelineFor(fixture.fetchMock, {
      now: () => new Date(NOW_SECONDS * 1000),
    }).readAccountData(ACCOUNT);

    expect(result.status).toBe("incomplete");
    expect(result.pythPrices).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("stale or future-dated"),
      rawResponse: expect.any(Object),
    });
    expect(result.pythFreshness["usdc.testnet"]?.status).toBe("stale-or-future");
  });

  it("does not treat malformed token decimals as metadata evidence", async () => {
    const fixture = buildRpcFixture({ missingMetadata: true });
    const result = await pipelineFor(fixture.fetchMock, {
      now: () => new Date(NOW_SECONDS * 1000),
    }).readAccountData(ACCOUNT);

    expect(result.status).toBe("incomplete");
    expect(result.tokenMetadata["usdt.testnet"]).toMatchObject({
      status: "unavailable",
      rawResponse: { decimals: "6" },
    });
    expect(result.pythPrices.status).toBe("unavailable");
    expect(result.assessmentEvidence.status).toBe("unavailable");
  });
});
