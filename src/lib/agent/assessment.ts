/**
 * Runtime assessment and candidate binding for the recommendation boundary.
 *
 * Validation here checks structure, provenance consistency, and hashes. It
 * does not authenticate an RPC provider or prove that the supplied evidence
 * is truthful; a trusted data adapter must establish that before calling it.
 */

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type Evidence<T> =
  { status: "verified"; value: T; source: string } | { status: "unavailable"; reason: string };

export type ReadSource = Readonly<{
  contractId: string;
  method: string;
  args: Readonly<Record<string, JsonValue>>;
  blockHeight: string;
  blockHash: string;
}>;

export type PositionAsset = Readonly<{ tokenId: string; balanceRaw: string }>;

export type PositionSnapshot = Readonly<{
  positions: Readonly<
    Record<
      string,
      Readonly<{
        collateral: readonly PositionAsset[];
        borrowed: readonly PositionAsset[];
      }>
    >
  >;
  source: ReadSource;
}>;

export type ProtocolParameters = Readonly<{
  reference: string;
  maximum_recency_duration_sec: number;
  values: Readonly<Record<string, JsonValue>>;
  source: ReadSource;
}>;

export type OraclePrice = Readonly<{
  tokenId: string;
  priceId: string;
  tokenDecimals: number;
  fractionDigits: number;
  price: string;
  exponent: number;
  confidence: string;
  publishedAt: number;
}>;

export type OraclePriceMapping = Readonly<{
  tokenId: string;
  priceId: string;
  tokenDecimals: number;
  fractionDigits: number;
}>;

export type OracleEvidence = Readonly<{
  contractId: string;
  mappings: readonly OraclePriceMapping[];
  prices: readonly OraclePrice[];
  mappingSource: ReadSource;
  source: ReadSource;
}>;

export type AssessmentDraft = Readonly<{
  version: "rescora.assessment.v1";
  createdAt: string;
  accountId: Evidence<string>;
  protocol: Evidence<Readonly<{ id: "burrow"; contractId: string }>>;
  network: Evidence<string>;
  positionSnapshot: Evidence<PositionSnapshot>;
  protocolParameters: Evidence<ProtocolParameters>;
  oraclePrices: Evidence<OracleEvidence>;
}>;

type VerifiedEvidence<T> = Extract<Evidence<T>, { status: "verified" }>;
export type VerifiedAssessmentDraft = Readonly<
  Omit<
    AssessmentDraft,
    | "accountId"
    | "protocol"
    | "network"
    | "positionSnapshot"
    | "protocolParameters"
    | "oraclePrices"
  > & {
    accountId: VerifiedEvidence<string>;
    protocol: VerifiedEvidence<Readonly<{ id: "burrow"; contractId: string }>>;
    network: VerifiedEvidence<string>;
    positionSnapshot: VerifiedEvidence<PositionSnapshot>;
    protocolParameters: VerifiedEvidence<ProtocolParameters>;
    oraclePrices: VerifiedEvidence<OracleEvidence>;
  }
>;

declare const validatedAssessmentBrand: unique symbol;
declare const validatedCandidateBrand: unique symbol;

export type ValidatedAssessment = Readonly<{
  draft: VerifiedAssessmentDraft;
  positionSnapshotReference: string;
  protocolParameterReference: string;
  assessmentId: string;
  readonly [validatedAssessmentBrand]: true;
}>;

export type CandidateDraft = Readonly<{
  candidateId: string;
  assessmentId: string;
  positionSnapshotReference: string;
  accountId: string;
  protocol: "burrow";
  network: "testnet";
  positionId: string;
  tokenId: string;
  amountRaw: string;
  repaymentCostDisplay: string;
  projectedHealthFactorDisplay: string;
}>;

export type ValidatedCandidate = Readonly<
  CandidateDraft & { readonly [validatedCandidateBrand]: true }
>;

export type ValidationFailure = Readonly<{
  status: "rejected";
  reasonCode:
    | "INVALID_ASSESSMENT"
    | "UNAVAILABLE_EVIDENCE"
    | "UNSUPPORTED_NETWORK"
    | "INCONSISTENT_PROVENANCE"
    | "STALE_ORACLE"
    | "INVALID_CANDIDATE";
  reason: string;
}>;

export type AssessmentValidation =
  { status: "accepted"; assessment: ValidatedAssessment } | ValidationFailure;

export type CandidateValidation =
  { status: "accepted"; candidates: readonly ValidatedCandidate[] } | ValidationFailure;

const BURROW_TESTNET = "burrow.services.ref-labs.testnet";
const assessmentRegistry = new WeakSet<object>();
const candidateRegistry = new WeakSet<object>();

function reject(reasonCode: ValidationFailure["reasonCode"], reason: string): ValidationFailure {
  return { status: "rejected", reasonCode, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isUnsignedInteger(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 40) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(
    ([key, item]) => key !== "__proto__" && isJsonValue(item, depth + 1),
  );
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function digest(value: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hashed = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0"));
  return `sha256:${hex.join("")}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function readVerified<T>(
  value: Evidence<T>,
): value is { status: "verified"; value: T; source: string } {
  return (
    isPlainRecord(value) &&
    exactKeys(value, ["status", "value", "source"]) &&
    value.status === "verified" &&
    isText(value.source)
  );
}

function allEvidenceVerified(value: AssessmentDraft): value is VerifiedAssessmentDraft {
  return (
    readVerified(value.accountId) &&
    readVerified(value.protocol) &&
    readVerified(value.network) &&
    readVerified(value.positionSnapshot) &&
    readVerified(value.protocolParameters) &&
    readVerified(value.oraclePrices)
  );
}

function validBlockSource(
  value: unknown,
  expectedContract: string,
  expectedMethod: string,
  expectedArgs?: Readonly<Record<string, JsonValue>>,
): value is ReadSource {
  return (
    isPlainRecord(value) &&
    exactKeys(value, ["contractId", "method", "args", "blockHeight", "blockHash"]) &&
    value.contractId === expectedContract &&
    value.method === expectedMethod &&
    isPlainRecord(value.args) &&
    isJsonValue(value.args) &&
    (expectedArgs === undefined ||
      canonicalJson(value.args as JsonValue) === canonicalJson(expectedArgs)) &&
    isUnsignedInteger(value.blockHeight) &&
    BigInt(value.blockHeight) > BigInt(0) &&
    typeof value.blockHash === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value.blockHash)
  );
}

function validateSnapshot(value: unknown, accountId: string): value is PositionSnapshot {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, ["positions", "source"]) ||
    !isPlainRecord(value.positions) ||
    Object.keys(value.positions).length === 0 ||
    !validBlockSource(value.source, BURROW_TESTNET, "get_account_all_positions", {
      account_id: accountId,
    })
  ) {
    return false;
  }
  return (
    Object.values(value.positions).every((position) => {
      if (
        !isPlainRecord(position) ||
        !exactKeys(position, ["collateral", "borrowed"]) ||
        !Array.isArray(position.collateral) ||
        !Array.isArray(position.borrowed)
      ) {
        return false;
      }
      return [...position.collateral, ...position.borrowed].every(
        (asset) =>
          isPlainRecord(asset) &&
          exactKeys(asset, ["tokenId", "balanceRaw"]) &&
          isText(asset.tokenId) &&
          isUnsignedInteger(asset.balanceRaw),
      );
    }) &&
    value.source.contractId === BURROW_TESTNET &&
    accountId.length > 0
  );
}

function validParameters(value: unknown): value is ProtocolParameters {
  return (
    isPlainRecord(value) &&
    exactKeys(value, ["reference", "maximum_recency_duration_sec", "values", "source"]) &&
    isText(value.reference) &&
    Number.isSafeInteger(value.maximum_recency_duration_sec) &&
    Number(value.maximum_recency_duration_sec) > 0 &&
    isPlainRecord(value.values) &&
    isJsonValue(value.values) &&
    validBlockSource(value.source, BURROW_TESTNET, "get_config", {})
  );
}

function validOracleEvidence(
  value: unknown,
  parameters: ProtocolParameters,
): value is OracleEvidence {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, ["contractId", "mappings", "prices", "mappingSource", "source"])
  ) {
    return false;
  }
  const contractId = value.contractId;
  const mappings = value.mappings;
  const prices = value.prices;
  const source = value.source;
  const mappingSource = value.mappingSource;
  if (!isPlainRecord(source) || !isPlainRecord(source.args)) return false;
  const requestedPriceIds = source.args.price_ids;
  if (!Array.isArray(requestedPriceIds) || !requestedPriceIds.every((priceId) => isText(priceId))) {
    return false;
  }
  if (
    !isText(contractId) ||
    !Array.isArray(mappings) ||
    mappings.length === 0 ||
    !Array.isArray(prices) ||
    prices.length === 0 ||
    !validBlockSource(source, contractId, "list_prices_no_older_than") ||
    !validBlockSource(mappingSource, BURROW_TESTNET, "get_all_token_pyth_infos", {}) ||
    source.blockHeight !== parameters.source.blockHeight ||
    source.blockHash !== parameters.source.blockHash ||
    mappingSource.blockHeight !== parameters.source.blockHeight ||
    mappingSource.blockHash !== parameters.source.blockHash ||
    !Number.isSafeInteger(source.args.age) ||
    Number(source.args.age) <= 0 ||
    parameters.values.pyth_oracle_account_id !== contractId
  ) {
    return false;
  }
  const mappingsByToken = new Map<string, OraclePriceMapping>();
  for (const mapping of mappings) {
    if (
      !isPlainRecord(mapping) ||
      !exactKeys(mapping, ["tokenId", "priceId", "tokenDecimals", "fractionDigits"]) ||
      !isText(mapping.tokenId) ||
      !isText(mapping.priceId) ||
      !Number.isSafeInteger(mapping.tokenDecimals) ||
      Number(mapping.tokenDecimals) < 0 ||
      !Number.isSafeInteger(mapping.fractionDigits) ||
      Number(mapping.fractionDigits) < 0 ||
      mappingsByToken.has(mapping.tokenId)
    ) {
      return false;
    }
    mappingsByToken.set(mapping.tokenId, mapping as OraclePriceMapping);
  }
  const mappedPriceIds = [...mappingsByToken.values()].map((mapping) => mapping.priceId).sort();
  const requestedIds = [...requestedPriceIds].sort();
  const pricedTokenIds = prices
    .map((price) =>
      isPlainRecord(price) && typeof price.tokenId === "string" ? price.tokenId : "",
    )
    .sort();
  const mappedTokenIds = [...mappingsByToken.keys()].sort();
  if (
    new Set(mappedPriceIds).size !== mappedPriceIds.length ||
    mappedPriceIds.length !== requestedIds.length ||
    mappedPriceIds.some((priceId, index) => priceId !== requestedIds[index]) ||
    new Set(pricedTokenIds).size !== pricedTokenIds.length ||
    pricedTokenIds.length !== mappedTokenIds.length ||
    pricedTokenIds.some((tokenId, index) => tokenId !== mappedTokenIds[index])
  ) {
    return false;
  }
  const allPricesValid = prices.every((price) => {
    if (!isPlainRecord(price)) return false;
    const mapping = mappingsByToken.get(String(price.tokenId));
    return (
      exactKeys(price, [
        "tokenId",
        "priceId",
        "tokenDecimals",
        "fractionDigits",
        "price",
        "exponent",
        "confidence",
        "publishedAt",
      ]) &&
      isText(price.tokenId) &&
      isText(price.priceId) &&
      mapping?.priceId === price.priceId &&
      mapping.tokenDecimals === price.tokenDecimals &&
      mapping.fractionDigits === price.fractionDigits &&
      requestedPriceIds.includes(price.priceId) &&
      Number.isSafeInteger(price.tokenDecimals) &&
      Number(price.tokenDecimals) >= 0 &&
      Number.isSafeInteger(price.fractionDigits) &&
      Number(price.fractionDigits) >= 0 &&
      typeof price.price === "string" &&
      /^-?(0|[1-9][0-9]*)$/.test(price.price) &&
      BigInt(price.price) > BigInt(0) &&
      Number.isSafeInteger(price.exponent) &&
      Math.abs(Number(price.exponent)) <= 100 &&
      isUnsignedInteger(price.confidence) &&
      Number.isSafeInteger(price.publishedAt) &&
      Number(price.publishedAt) > 0
    );
  });
  return allPricesValid;
}

function validateDraftShape(value: unknown): value is AssessmentDraft {
  return (
    isPlainRecord(value) &&
    exactKeys(value, [
      "version",
      "createdAt",
      "accountId",
      "protocol",
      "network",
      "positionSnapshot",
      "protocolParameters",
      "oraclePrices",
    ]) &&
    value.version === "rescora.assessment.v1" &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    new Date(value.createdAt).toISOString() === value.createdAt
  );
}

export async function validateAssessmentEvidence(input: unknown): Promise<AssessmentValidation> {
  if (!validateDraftShape(input)) {
    return reject("INVALID_ASSESSMENT", "Assessment evidence is malformed or has unknown fields.");
  }
  if (
    [
      input.accountId,
      input.protocol,
      input.network,
      input.positionSnapshot,
      input.protocolParameters,
      input.oraclePrices,
    ].some((item) => item.status === "unavailable")
  ) {
    return reject(
      "UNAVAILABLE_EVIDENCE",
      "Required account, protocol, position, parameter, or price evidence is unavailable.",
    );
  }
  if (!allEvidenceVerified(input)) {
    return reject(
      "UNAVAILABLE_EVIDENCE",
      "Every required evidence item must be explicitly verified and sourced.",
    );
  }
  const verifiedInput = input;

  const accountId = verifiedInput.accountId.value;
  if (
    !isText(accountId, 64) ||
    verifiedInput.network.value !== "testnet" ||
    !isPlainRecord(verifiedInput.protocol.value) ||
    !exactKeys(verifiedInput.protocol.value, ["id", "contractId"]) ||
    verifiedInput.protocol.value.id !== "burrow" ||
    verifiedInput.protocol.value.contractId !== BURROW_TESTNET
  ) {
    return reject("UNSUPPORTED_NETWORK", "Only a verified Burrow testnet assessment is accepted.");
  }
  if (!validateSnapshot(verifiedInput.positionSnapshot.value, accountId)) {
    return reject(
      "INVALID_ASSESSMENT",
      "Position snapshot is malformed or is not bound to the Burrow testnet view.",
    );
  }
  if (!validParameters(verifiedInput.protocolParameters.value)) {
    return reject(
      "INVALID_ASSESSMENT",
      "Protocol parameters are malformed or lack a valid source block.",
    );
  }

  const snapshotSource = verifiedInput.positionSnapshot.value.source;
  const parameterSource = verifiedInput.protocolParameters.value.source;
  if (
    snapshotSource.blockHeight !== parameterSource.blockHeight ||
    snapshotSource.blockHash !== parameterSource.blockHash ||
    verifiedInput.protocolParameters.value.values.enable_pyth_oracle !== true ||
    !validOracleEvidence(verifiedInput.oraclePrices.value, verifiedInput.protocolParameters.value)
  ) {
    return reject(
      "INCONSISTENT_PROVENANCE",
      "Position, parameter, and oracle evidence must use consistent testnet provenance.",
    );
  }

  const requiredTokenIds = new Set(
    Object.values(verifiedInput.positionSnapshot.value.positions).flatMap((position) =>
      [...position.collateral, ...position.borrowed].map((asset) => asset.tokenId),
    ),
  );
  const pricedTokenIds = new Set(
    verifiedInput.oraclePrices.value.prices.map((price) => price.tokenId),
  );
  if ([...requiredTokenIds].some((tokenId) => !pricedTokenIds.has(tokenId))) {
    return reject(
      "UNAVAILABLE_EVIDENCE",
      "Oracle evidence is missing a price for an assessed collateral or debt token.",
    );
  }

  const createdAtMs = Date.parse(verifiedInput.createdAt);
  const now = Date.now();
  const maximumAgeMs = Number(verifiedInput.oraclePrices.value.source.args.age) * 1000;
  const pricesAreFresh = verifiedInput.oraclePrices.value.prices.every((price) => {
    const publishedAtMs = price.publishedAt * 1000;
    return (
      createdAtMs <= now &&
      publishedAtMs <= createdAtMs &&
      createdAtMs - publishedAtMs <= maximumAgeMs &&
      publishedAtMs <= now &&
      now - publishedAtMs <= maximumAgeMs
    );
  });
  if (!pricesAreFresh) {
    return reject(
      "STALE_ORACLE",
      "Oracle prices are stale or timestamped after assessment creation.",
    );
  }

  const normalizedDraft = JSON.parse(JSON.stringify(verifiedInput)) as VerifiedAssessmentDraft;
  const positionSnapshotReference = await digest(
    normalizedDraft.positionSnapshot.value as unknown as JsonValue,
  );
  const protocolParameterReference = await digest(
    normalizedDraft.protocolParameters.value as unknown as JsonValue,
  );
  const assessmentId = await digest({
    version: normalizedDraft.version,
    createdAt: normalizedDraft.createdAt,
    accountId,
    protocol: normalizedDraft.protocol.value,
    network: normalizedDraft.network.value,
    positionSnapshotReference,
    protocolParameterReference,
    oraclePrices: normalizedDraft.oraclePrices.value,
  });
  const assessment = deepFreeze({
    draft: normalizedDraft,
    positionSnapshotReference,
    protocolParameterReference,
    assessmentId,
  }) as ValidatedAssessment;
  assessmentRegistry.add(assessment);
  return { status: "accepted", assessment };
}

export function isValidatedAssessment(assessment: unknown): assessment is ValidatedAssessment {
  return isPlainRecord(assessment) && assessmentRegistry.has(assessment);
}

export async function isAssessmentCurrent(assessment: unknown): Promise<boolean> {
  if (!isValidatedAssessment(assessment)) return false;
  const result = await validateAssessmentEvidence(assessment.draft);
  return result.status === "accepted" && result.assessment.assessmentId === assessment.assessmentId;
}

export function isValidatedCandidate(candidate: unknown): candidate is ValidatedCandidate {
  return isPlainRecord(candidate) && candidateRegistry.has(candidate);
}

export async function validateCandidatesForAssessment(
  assessment: unknown,
  input: unknown,
): Promise<CandidateValidation> {
  // Binds outputs from the deterministic candidate/policy layer to this exact
  // assessment. It does not generate candidates or prove repayment economics;
  // callers must run their independent deterministic checks before this step.
  if (!isValidatedAssessment(assessment) || !(await isAssessmentCurrent(assessment))) {
    return reject(
      "INVALID_ASSESSMENT",
      "Candidates require a current validator-produced assessment.",
    );
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > 20) {
    return reject("INVALID_CANDIDATE", "A bounded, non-empty candidate set is required.");
  }

  const snapshot = assessment.draft.positionSnapshot.value;
  const candidateIds = new Set<string>();
  const candidates: ValidatedCandidate[] = [];
  for (const candidate of input) {
    if (
      !isPlainRecord(candidate) ||
      !exactKeys(candidate, [
        "candidateId",
        "assessmentId",
        "positionSnapshotReference",
        "accountId",
        "protocol",
        "network",
        "positionId",
        "tokenId",
        "amountRaw",
        "repaymentCostDisplay",
        "projectedHealthFactorDisplay",
      ]) ||
      !isText(candidate.candidateId, 80) ||
      candidateIds.has(candidate.candidateId) ||
      candidate.assessmentId !== assessment.assessmentId ||
      candidate.positionSnapshotReference !== assessment.positionSnapshotReference ||
      candidate.accountId !== assessment.draft.accountId.value ||
      candidate.protocol !== "burrow" ||
      candidate.network !== "testnet" ||
      !isText(candidate.positionId, 120) ||
      !isText(candidate.tokenId, 128) ||
      !isUnsignedInteger(candidate.amountRaw) ||
      BigInt(candidate.amountRaw) <= BigInt(0) ||
      !isText(candidate.repaymentCostDisplay, 120) ||
      !isText(candidate.projectedHealthFactorDisplay, 120)
    ) {
      return reject(
        "INVALID_CANDIDATE",
        "Candidate identity or fields are malformed or detached from the assessment.",
      );
    }
    const position = snapshot.positions[candidate.positionId];
    const debt = position?.borrowed.find((asset) => asset.tokenId === candidate.tokenId);
    if (!debt) {
      return reject(
        "INVALID_CANDIDATE",
        "Candidate token is not a debt in the bound position snapshot.",
      );
    }
    const normalized = deepFreeze({ ...candidate }) as ValidatedCandidate;
    candidateRegistry.add(normalized);
    candidates.push(normalized);
    candidateIds.add(candidate.candidateId);
  }
  return { status: "accepted", candidates: Object.freeze(candidates) };
}
