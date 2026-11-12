import type { JsonValue, OraclePrice } from "../agent/assessment";
import type { NearRpcReader, ViewProvenance, ViewResponse } from "../near-rpc/client";
import { NearRpcError, isNearAccountId } from "../near-rpc/client";
import {
  BURROW_TESTNET_ACCOUNT,
  BurrowPositionReadError,
  BurrowPositionReader,
  type BurrowPositionRead,
} from "./positions";

export const GET_CONFIG_METHOD = "get_config";
export const GET_ASSETS_DETAILED_METHOD = "get_assets_paged_detailed";
export const GET_PYTH_MAPPINGS_METHOD = "get_all_token_pyth_infos";
export const FT_METADATA_METHOD = "ft_metadata";
export const LIST_PYTH_PRICES_METHOD = "list_prices_no_older_than";
export const PINNED_PYTH_MAX_AGE_SECONDS = 60;
const METADATA_READ_CONCURRENCY = 4;

export type ReadView<T> =
  | Readonly<{
      status: "unverified";
      value: T;
      rawResponse: JsonValue;
      provenance: ViewProvenance;
    }>
  | Readonly<{
      status: "unavailable";
      reason: string;
      rawResponse?: JsonValue;
      provenance?: ViewProvenance;
      diagnostic?: JsonValue;
    }>;

export type BurrowRuntimeConfig = Readonly<{
  enablePythOracle: boolean;
  enablePriceOracle: boolean;
  pythOracleAccountId: string | null;
  oracleAccountId: string | null;
  maximumRecencyDurationSec: number | null;
}>;

export type BurrowAssetConfig = Readonly<{
  tokenId: string;
  extraDecimals: number;
  volatilityRatio: number;
  canUseAsCollateral: boolean;
  canBorrow: boolean;
}>;

export type BurrowTokenMetadata = Readonly<{
  tokenId: string;
  decimals: number;
  name: string | null;
  symbol: string | null;
}>;

export type BurrowPythMapping = Readonly<{
  tokenId: string;
  priceId: string;
  tokenDecimals: number;
  fractionDigits: number;
  extraCall: string;
}>;

export type PythFreshness =
  | Readonly<{ status: "within-requested-age-unverified-source"; ageSeconds: number }>
  | Readonly<{ status: "stale-or-future"; ageSeconds: number }>;

export type BurrowDataPipelineResult = Readonly<{
  accountId: string;
  block: Readonly<{ height: string; hash: string }>;
  positions: BurrowPositionRead;
  config: ReadView<BurrowRuntimeConfig>;
  assets: ReadView<readonly BurrowAssetConfig[]>;
  tokenMetadata: Readonly<Record<string, ReadView<BurrowTokenMetadata>>>;
  pythMappings: ReadView<readonly BurrowPythMapping[]>;
  pythPrices: ReadView<readonly OraclePrice[]>;
  pythFreshness: Readonly<Record<string, PythFreshness>>;
  assetCoverage: "unverified";
  positionCompleteness: "unverified";
  decimalUnitRelationship: "unverified";
  status: "incomplete" | "complete-unverified";
  assessmentEvidence: Readonly<{
    status: "unavailable";
    reason: string;
  }>;
}>;

type RawRpcView = ViewResponse<JsonValue>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asJson(value: unknown): JsonValue | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : (JSON.parse(serialized) as JsonValue);
  } catch {
    return undefined;
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await map(items[index] as T);
      }
    }),
  );
  return results;
}

function unavailable<T>(reason: string, response?: RawRpcView): ReadView<T> {
  return Object.freeze({
    status: "unavailable",
    reason,
    ...(response ? { rawResponse: response.data, provenance: response.provenance } : {}),
  });
}

function rpcViewFailureReason(error: NearRpcError): string {
  const kind = error.details?.failureKind;
  if (kind === "transport" || error.code === "NETWORK_FAILURE") return "RPC transport failure.";
  if (kind === "timeout" || error.code === "TIMEOUT") return "RPC request timed out.";
  if (kind === "http-status" || error.code === "HTTP_ERROR") {
    const status = error.details?.status;
    return typeof status === "number"
      ? `RPC HTTP status failure (${status}).`
      : "RPC HTTP status failure.";
  }
  if (kind === "json-parse") return "RPC JSON parsing failure.";
  if (kind === "json-rpc" || error.code === "RPC_ERROR") return "JSON-RPC view error.";
  if (kind === "snapshot-mismatch" || error.code === "BLOCK_CONTEXT_MISMATCH") {
    return "RPC returned a different snapshot block.";
  }
  if (kind === "invalid-view" || error.code === "MALFORMED_RESPONSE")
    return "Invalid Burrow view response.";
  return `RPC view failed (${error.code}).`;
}

function unverified<T>(response: RawRpcView, value: T): ReadView<T> {
  return Object.freeze({
    status: "unverified",
    value,
    rawResponse: response.data,
    provenance: response.provenance,
  });
}

function rawView(stage: Extract<ReadView<JsonValue>, { status: "unverified" }>): RawRpcView {
  return {
    data: stage.rawResponse,
    provenance: stage.provenance,
    validation: "rpc-envelope-and-json-decoded",
  };
}

function parseConfig(response: RawRpcView): ReadView<BurrowRuntimeConfig> {
  const value = response.data;
  if (
    !isRecord(value) ||
    typeof value.enable_pyth_oracle !== "boolean" ||
    typeof value.enable_price_oracle !== "boolean" ||
    (value.pyth_oracle_account_id !== undefined &&
      (typeof value.pyth_oracle_account_id !== "string" ||
        !isNearAccountId(value.pyth_oracle_account_id))) ||
    (value.oracle_account_id !== undefined &&
      (typeof value.oracle_account_id !== "string" || !isNearAccountId(value.oracle_account_id))) ||
    (value.maximum_recency_duration_sec !== undefined &&
      !integer(value.maximum_recency_duration_sec))
  ) {
    return unavailable(
      "Burrow get_config response failed the SDK-declared field checks.",
      response,
    );
  }
  if (value.enable_pyth_oracle && !text(value.pyth_oracle_account_id)) {
    return unavailable("Pyth is enabled but its configured oracle account is missing.", response);
  }
  if (value.enable_price_oracle && !text(value.oracle_account_id)) {
    return unavailable(
      "The price oracle is enabled but its configured account is missing.",
      response,
    );
  }
  return unverified(response, {
    enablePythOracle: value.enable_pyth_oracle,
    enablePriceOracle: value.enable_price_oracle,
    pythOracleAccountId: text(value.pyth_oracle_account_id) ? value.pyth_oracle_account_id : null,
    oracleAccountId: text(value.oracle_account_id) ? value.oracle_account_id : null,
    maximumRecencyDurationSec: integer(value.maximum_recency_duration_sec)
      ? value.maximum_recency_duration_sec
      : null,
  });
}

function parseAssets(response: RawRpcView): ReadView<readonly BurrowAssetConfig[]> {
  if (!Array.isArray(response.data)) {
    return unavailable(
      "get_assets_paged_detailed did not return the SDK-declared array shape.",
      response,
    );
  }
  const result: BurrowAssetConfig[] = [];
  const tokenIds = new Set<string>();
  for (const asset of response.data) {
    if (
      !isRecord(asset) ||
      !isNearAccountId(String(asset.token_id ?? "")) ||
      !isRecord(asset.config) ||
      !integer(asset.config.extra_decimals) ||
      typeof asset.config.volatility_ratio !== "number" ||
      !Number.isFinite(asset.config.volatility_ratio) ||
      asset.config.volatility_ratio < 0 ||
      typeof asset.config.can_use_as_collateral !== "boolean" ||
      typeof asset.config.can_borrow !== "boolean" ||
      tokenIds.has(String(asset.token_id))
    ) {
      return unavailable(
        "Asset view contains a malformed or duplicate asset configuration.",
        response,
      );
    }
    tokenIds.add(asset.token_id as string);
    result.push({
      tokenId: asset.token_id as string,
      extraDecimals: asset.config.extra_decimals,
      volatilityRatio: asset.config.volatility_ratio,
      canUseAsCollateral: asset.config.can_use_as_collateral,
      canBorrow: asset.config.can_borrow,
    });
  }
  return unverified(response, Object.freeze(result));
}

function parseMetadata(tokenId: string, response: RawRpcView): ReadView<BurrowTokenMetadata> {
  const value = response.data;
  if (!isRecord(value) || !integer(value.decimals) || value.decimals > 255) {
    return unavailable(
      `NEP-141 metadata for ${tokenId} is missing a valid decimals field.`,
      response,
    );
  }
  if (
    (value.name !== undefined && typeof value.name !== "string") ||
    (value.symbol !== undefined && typeof value.symbol !== "string")
  ) {
    return unavailable(
      `NEP-141 metadata for ${tokenId} has malformed name or symbol fields.`,
      response,
    );
  }
  return unverified(response, {
    tokenId,
    decimals: value.decimals,
    name: typeof value.name === "string" ? value.name : null,
    symbol: typeof value.symbol === "string" ? value.symbol : null,
  });
}

function parseMappings(response: RawRpcView): ReadView<readonly BurrowPythMapping[]> {
  if (!isRecord(response.data)) {
    return unavailable("get_all_token_pyth_infos did not return an object map.", response);
  }
  const result: BurrowPythMapping[] = [];
  const priceIds = new Set<string>();
  for (const [tokenId, entry] of Object.entries(response.data)) {
    if (
      !isNearAccountId(tokenId) ||
      !isRecord(entry) ||
      !integer(entry.decimals) ||
      !integer(entry.fraction_digits) ||
      !text(entry.price_identifier) ||
      typeof entry.extra_call !== "string" ||
      !(entry.default_price === null || isRecord(entry.default_price)) ||
      priceIds.has(entry.price_identifier)
    ) {
      return unavailable("Pyth token mapping contains malformed or duplicate entries.", response);
    }
    priceIds.add(entry.price_identifier);
    result.push({
      tokenId,
      priceId: entry.price_identifier,
      tokenDecimals: entry.decimals,
      fractionDigits: entry.fraction_digits,
      extraCall: entry.extra_call,
    });
  }
  return unverified(response, Object.freeze(result));
}

function parsePythPrices(
  response: RawRpcView,
  mappings: readonly BurrowPythMapping[],
  metadata: Readonly<Record<string, ReadView<BurrowTokenMetadata>>>,
  nowSeconds: number,
): { stage: ReadView<readonly OraclePrice[]>; freshness: Readonly<Record<string, PythFreshness>> } {
  const unavailableResult = (reason: string) => ({
    stage: unavailable<readonly OraclePrice[]>(reason, response),
    freshness: Object.freeze({}),
  });
  if (!isRecord(response.data))
    return unavailableResult("Pyth oracle response is not an object map.");
  const prices: OraclePrice[] = [];
  const freshness: Record<string, PythFreshness> = {};
  for (const mapping of mappings) {
    if (mapping.extraCall !== "") {
      return unavailableResult(
        `Pyth mapping for ${mapping.tokenId} declares an extra_call that this reader does not implement.`,
      );
    }
    const metadataView = metadata[mapping.tokenId];
    if (metadataView?.status !== "unverified") {
      return unavailableResult(`Token metadata for ${mapping.tokenId} is unavailable.`);
    }
    const price = response.data[mapping.priceId];
    if (
      !isRecord(price) ||
      typeof price.price !== "string" ||
      !/^[1-9][0-9]*$/.test(price.price) ||
      typeof price.conf !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(price.conf) ||
      !Number.isSafeInteger(price.expo) ||
      !Number.isSafeInteger(price.publish_time) ||
      Number(price.publish_time) <= 0
    ) {
      return unavailableResult(`Pyth did not return a valid raw price for ${mapping.tokenId}.`);
    }
    const ageSeconds = nowSeconds - Number(price.publish_time);
    const fresh = ageSeconds >= 0 && ageSeconds <= PINNED_PYTH_MAX_AGE_SECONDS;
    freshness[mapping.tokenId] = Object.freeze({
      status: fresh ? "within-requested-age-unverified-source" : "stale-or-future",
      ageSeconds,
    });
    if (!fresh)
      return {
        stage: unavailable(`Pyth price for ${mapping.tokenId} is stale or future-dated.`, response),
        freshness,
      };
    prices.push({
      tokenId: mapping.tokenId,
      priceId: mapping.priceId,
      tokenDecimals: mapping.tokenDecimals,
      fractionDigits: mapping.fractionDigits,
      price: price.price,
      exponent: price.expo as number,
      confidence: price.conf,
      publishedAt: price.publish_time as number,
    });
  }
  return {
    stage: unverified(response, Object.freeze(prices)),
    freshness: Object.freeze(freshness),
  };
}

async function optionalView(
  rpc: NearRpcReader,
  contractAccountId: string,
  methodName: string,
  blockHash: string,
  args: Readonly<Record<string, JsonValue>> = {},
): Promise<ReadView<JsonValue>> {
  try {
    const response = await rpc.callFunction({
      contractAccountId,
      methodName,
      args,
      block: { blockHash },
    });
    return unverified(response, response.data);
  } catch (error) {
    const diagnostic = asJson({
      request: { contractAccountId, methodName, args, blockHash },
      ...(error instanceof NearRpcError ? { errorCode: error.code, details: error.details } : {}),
    });
    return Object.freeze({
      status: "unavailable",
      reason: error instanceof NearRpcError ? rpcViewFailureReason(error) : "RPC view failed.",
      ...(diagnostic ? { diagnostic } : {}),
    });
  }
}

export class BurrowDataPipeline {
  private readonly positionsReader: BurrowPositionReader;
  private readonly now: () => Date;

  constructor(
    private readonly rpc: NearRpcReader,
    options: Readonly<{ now?: () => Date }> = {},
  ) {
    this.positionsReader = new BurrowPositionReader(rpc);
    this.now = options.now ?? (() => new Date());
  }

  async readAccountData(accountId: string): Promise<BurrowDataPipelineResult> {
    if (!isNearAccountId(accountId)) {
      throw new BurrowPositionReadError("INVALID_ACCOUNT", "NEAR account ID is invalid.");
    }
    const positions = await this.positionsReader.readAccountPositions(accountId);
    const { blockHeight, blockHash } = positions.provenance;
    const [configRaw, assetsRaw, mappingsRaw] = await Promise.all([
      optionalView(this.rpc, BURROW_TESTNET_ACCOUNT, GET_CONFIG_METHOD, blockHash),
      optionalView(this.rpc, BURROW_TESTNET_ACCOUNT, GET_ASSETS_DETAILED_METHOD, blockHash),
      optionalView(this.rpc, BURROW_TESTNET_ACCOUNT, GET_PYTH_MAPPINGS_METHOD, blockHash),
    ]);
    const config = configRaw.status === "unverified" ? parseConfig(rawView(configRaw)) : configRaw;
    const assets = assetsRaw.status === "unverified" ? parseAssets(rawView(assetsRaw)) : assetsRaw;
    const pythMappings =
      mappingsRaw.status === "unverified" ? parseMappings(rawView(mappingsRaw)) : mappingsRaw;

    const tokenIds = [
      ...new Set(
        Object.values(positions.positions).flatMap((position) =>
          [...position.collateral, ...position.borrowed].map((row) => row.tokenId),
        ),
      ),
    ].sort();
    const metadataResults = await mapWithConcurrency(
      tokenIds,
      METADATA_READ_CONCURRENCY,
      async (tokenId) => {
        const view = await optionalView(this.rpc, tokenId, FT_METADATA_METHOD, blockHash);
        return {
          tokenId,
          view: view.status === "unverified" ? parseMetadata(tokenId, rawView(view)) : view,
        };
      },
    );
    const tokenMetadata: Record<string, ReadView<BurrowTokenMetadata>> = Object.create(null);
    for (const result of metadataResults) tokenMetadata[result.tokenId] = result.view;

    let pythPrices: ReadView<readonly OraclePrice[]> = unavailable(
      "Pyth prices were not requested.",
    );
    let pythFreshness: Readonly<Record<string, PythFreshness>> = Object.freeze({});
    if (config.status !== "unverified") {
      pythPrices = unavailable("Burrow configuration is unavailable.");
    } else if (!config.value.enablePythOracle) {
      pythPrices = unavailable(
        "The configured price oracle path is not supported by the Pyth-only assessment boundary.",
      );
    } else if (pythMappings.status !== "unverified") {
      pythPrices = unavailable("Pyth mappings are unavailable.");
    } else {
      const mappingByToken = new Map(
        pythMappings.value.map((mapping) => [mapping.tokenId, mapping]),
      );
      const requiredMappings = tokenIds.map((tokenId) => mappingByToken.get(tokenId));
      if (requiredMappings.some((mapping) => !mapping)) {
        pythPrices = unavailable("A required position token has no Pyth mapping.", {
          data: pythMappings.rawResponse,
          provenance: pythMappings.provenance,
          validation: "rpc-envelope-and-json-decoded",
        });
      } else if (requiredMappings.length === 0) {
        pythPrices = unavailable(
          "The position view contains no collateral or debt tokens to price.",
        );
      } else {
        const mappings = requiredMappings as BurrowPythMapping[];
        const priceIds = mappings.map((mapping) => mapping.priceId).sort();
        const oracleRaw = await optionalView(
          this.rpc,
          config.value.pythOracleAccountId as string,
          LIST_PYTH_PRICES_METHOD,
          blockHash,
          { price_ids: priceIds, age: PINNED_PYTH_MAX_AGE_SECONDS },
        );
        if (oracleRaw.status === "unverified") {
          const parsed = parsePythPrices(
            rawView(oracleRaw),
            mappings,
            tokenMetadata,
            Math.floor(this.now().getTime() / 1000),
          );
          pythPrices = parsed.stage;
          pythFreshness = parsed.freshness;
        } else {
          pythPrices = oracleRaw;
        }
      }
    }

    const assetIds =
      assets.status === "unverified" ? new Set(assets.value.map((item) => item.tokenId)) : null;
    const requiredAssetsPresent =
      assetIds !== null && tokenIds.every((tokenId) => assetIds.has(tokenId));
    const allMetadataPresent =
      tokenIds.length > 0 &&
      tokenIds.every((tokenId) => tokenMetadata[tokenId]?.status === "unverified");
    const allStagesPresent =
      config.status === "unverified" &&
      assets.status === "unverified" &&
      pythMappings.status === "unverified" &&
      pythPrices.status === "unverified" &&
      allMetadataPresent &&
      requiredAssetsPresent;
    const nowMs = this.now().getTime();
    const pricesRemainFresh =
      pythPrices.status === "unverified" &&
      pythPrices.value.every((price) => {
        const timestamp = price.publishedAt * 1000;
        return timestamp <= nowMs && nowMs - timestamp <= PINNED_PYTH_MAX_AGE_SECONDS * 1000;
      });
    return Object.freeze({
      accountId,
      block: Object.freeze({ height: blockHeight, hash: blockHash }),
      positions,
      config,
      assets,
      tokenMetadata: Object.freeze(tokenMetadata),
      pythMappings,
      pythPrices,
      pythFreshness,
      assetCoverage: "unverified",
      positionCompleteness: "unverified",
      decimalUnitRelationship: "unverified",
      status: allStagesPresent && pricesRemainFresh ? "complete-unverified" : "incomplete",
      assessmentEvidence: Object.freeze({
        status: "unavailable",
        reason:
          "Burrow deployed-code equivalence, complete position/asset coverage, and RPC source authenticity are not established.",
      }),
    });
  }
}
