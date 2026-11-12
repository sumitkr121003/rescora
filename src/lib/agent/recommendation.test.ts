import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateAssessmentEvidence,
  validateCandidatesForAssessment,
  isAssessmentCurrent,
  type AssessmentDraft,
  type CandidateDraft,
  type JsonValue,
} from "./assessment";
import { recommendValidatedCandidate, type AgentInput } from "./recommendation";

// Entirely synthetic unit fixture. These values test binding/validation only;
// they are not represented as captured Burrow or oracle data.
const TEST_NOW = "2026-11-04T12:00:00.000Z";
const BLOCK_HEIGHT = "123456";
const BLOCK_HASH = "11111111111111111111111111111111111111111111";
const ACCOUNT_ID = "rescora-fixture.testnet";
const BURROW_ID = "burrow.services.ref-labs.testnet";
const ORACLE_ID = "pyth-oracle.testnet";

const verified = <T>(value: T, source: string) => ({ status: "verified" as const, value, source });
const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });

function readSource(contractId: string, method: string, args: Record<string, JsonValue> = {}) {
  return { contractId, method, args, blockHeight: BLOCK_HEIGHT, blockHash: BLOCK_HASH };
}

function draftFixture(overrides: Partial<AssessmentDraft> = {}): AssessmentDraft {
  return {
    version: "rescora.assessment.v1",
    createdAt: TEST_NOW,
    accountId: verified(ACCOUNT_ID, "synthetic wallet fixture"),
    protocol: verified({ id: "burrow", contractId: BURROW_ID }, "synthetic contract fixture"),
    network: verified("testnet", "synthetic runtime network fixture"),
    positionSnapshot: verified(
      {
        positions: {
          REGULAR: {
            collateral: [{ tokenId: "wrap.testnet", balanceRaw: "100000000" }],
            borrowed: [{ tokenId: "usdtt.ft.ref-labs.testnet", balanceRaw: "5000000" }],
          },
        },
        source: readSource(BURROW_ID, "get_account_all_positions", { account_id: ACCOUNT_ID }),
      },
      "synthetic NEAR RPC fixture",
    ),
    protocolParameters: verified(
      {
        reference: "synthetic-config-fixture",
        maximum_recency_duration_sec: 60,
        values: { enable_pyth_oracle: true, pyth_oracle_account_id: ORACLE_ID },
        source: readSource(BURROW_ID, "get_config"),
      },
      "synthetic NEAR RPC fixture",
    ),
    oraclePrices: verified(
      {
        contractId: ORACLE_ID,
        mappingSource: readSource(BURROW_ID, "get_all_token_pyth_infos"),
        mappings: [
          {
            tokenId: "usdtt.ft.ref-labs.testnet",
            priceId: "fixture-price-id",
            tokenDecimals: 6,
            fractionDigits: 4,
          },
          {
            tokenId: "wrap.testnet",
            priceId: "fixture-wrap-price-id",
            tokenDecimals: 24,
            fractionDigits: 4,
          },
        ],
        source: readSource(ORACLE_ID, "list_prices_no_older_than", {
          price_ids: ["fixture-price-id", "fixture-wrap-price-id"],
          age: 60,
        }),
        prices: [
          {
            tokenId: "usdtt.ft.ref-labs.testnet",
            priceId: "fixture-price-id",
            tokenDecimals: 6,
            fractionDigits: 4,
            price: "100000000",
            exponent: -8,
            confidence: "1000",
            publishedAt: Math.floor(Date.parse(TEST_NOW) / 1000) - 10,
          },
          {
            tokenId: "wrap.testnet",
            priceId: "fixture-wrap-price-id",
            tokenDecimals: 24,
            fractionDigits: 4,
            price: "100000000",
            exponent: -8,
            confidence: "1000",
            publishedAt: Math.floor(Date.parse(TEST_NOW) / 1000) - 10,
          },
        ],
      },
      "synthetic Pyth fixture",
    ),
    ...overrides,
  };
}

async function acceptedAssessment(draft = draftFixture()) {
  const result = await validateAssessmentEvidence(draft);
  if (result.status !== "accepted") throw new Error(`Fixture rejected: ${result.reason}`);
  return result.assessment;
}

function candidateFixture(
  assessmentId: string,
  snapshotReference: string,
  overrides: Partial<CandidateDraft> = {},
): CandidateDraft {
  return {
    candidateId: "candidate-a",
    assessmentId,
    positionSnapshotReference: snapshotReference,
    accountId: ACCOUNT_ID,
    protocol: "burrow",
    network: "testnet",
    positionId: "REGULAR",
    tokenId: "usdtt.ft.ref-labs.testnet",
    amountRaw: "1000000",
    repaymentCostDisplay: "$1.00 (fixture)",
    projectedHealthFactorDisplay: "105% (fixture estimate)",
    ...overrides,
  };
}

async function validatedCandidates(assessment: Awaited<ReturnType<typeof acceptedAssessment>>) {
  const result = await validateCandidatesForAssessment(assessment, [
    candidateFixture(assessment.assessmentId, assessment.positionSnapshotReference),
  ]);
  if (result.status !== "accepted") throw new Error(`Candidate fixture rejected: ${result.reason}`);
  return result.candidates;
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TEST_NOW));
});

describe("assessment provenance and recommendation boundary", () => {
  it("rejects missing provenance instead of accepting a caller verification flag", async () => {
    const result = await validateAssessmentEvidence(
      draftFixture({ accountId: unavailable("Wallet identity was not verified.") }),
    );

    expect(result).toMatchObject({ status: "rejected", reasonCode: "UNAVAILABLE_EVIDENCE" });
  });

  it("rejects an assessment whose position query belongs to another account", async () => {
    const base = draftFixture();
    const mismatched: AssessmentDraft = {
      ...base,
      positionSnapshot:
        base.positionSnapshot.status === "verified"
          ? verified(
              {
                ...base.positionSnapshot.value,
                source: readSource(BURROW_ID, "get_account_all_positions", {
                  account_id: "someone-else.testnet",
                }),
              },
              "synthetic NEAR RPC fixture",
            )
          : base.positionSnapshot,
    };

    expect(await validateAssessmentEvidence(mismatched)).toMatchObject({
      status: "rejected",
      reasonCode: "INVALID_ASSESSMENT",
    });
  });

  it("rejects an unsupported protocol network", async () => {
    const base = draftFixture();
    const unsupported: AssessmentDraft = {
      ...base,
      network: verified("mainnet", "synthetic invalid-network fixture"),
    };

    expect(await validateAssessmentEvidence(unsupported)).toMatchObject({
      status: "rejected",
      reasonCode: "UNSUPPORTED_NETWORK",
    });
  });

  it("rejects a candidate associated with a different account", async () => {
    const assessment = await acceptedAssessment();
    const result = await validateCandidatesForAssessment(assessment, [
      candidateFixture(assessment.assessmentId, assessment.positionSnapshotReference, {
        accountId: "other.testnet",
      }),
    ]);

    expect(result).toMatchObject({ status: "rejected", reasonCode: "INVALID_CANDIDATE" });
  });

  it("rejects a candidate with a mismatched snapshot identity", async () => {
    const assessment = await acceptedAssessment();
    const result = await validateCandidatesForAssessment(assessment, [
      candidateFixture(assessment.assessmentId, "sha256:detached-snapshot"),
    ]);

    expect(result).toMatchObject({ status: "rejected", reasonCode: "INVALID_CANDIDATE" });
  });

  it("binds assessment identity to the position snapshot and protocol parameters", async () => {
    const original = await acceptedAssessment();
    const base = draftFixture();
    const changedParameters: AssessmentDraft = {
      ...base,
      protocolParameters:
        base.protocolParameters.status === "verified"
          ? verified(
              { ...base.protocolParameters.value, maximum_recency_duration_sec: 59 },
              "synthetic NEAR RPC fixture",
            )
          : base.protocolParameters,
    };
    const changed = await acceptedAssessment(changedParameters);

    expect(changed.positionSnapshotReference).toBe(original.positionSnapshotReference);
    expect(changed.protocolParameterReference).not.toBe(original.protocolParameterReference);
    expect(changed.assessmentId).not.toBe(original.assessmentId);
  });

  it("rejects unavailable and stale oracle evidence", async () => {
    const unavailablePrice = await validateAssessmentEvidence(
      draftFixture({ oraclePrices: unavailable("Oracle view failed.") }),
    );
    const base = draftFixture();
    const staleDraft: AssessmentDraft = {
      ...base,
      oraclePrices:
        base.oraclePrices.status === "verified"
          ? verified(
              {
                ...base.oraclePrices.value,
                prices: base.oraclePrices.value.prices.map((price) => ({
                  ...price,
                  publishedAt: 1,
                })),
              },
              "synthetic Pyth fixture",
            )
          : base.oraclePrices,
    };
    const stalePrice = await validateAssessmentEvidence(staleDraft);

    expect(unavailablePrice).toMatchObject({
      status: "rejected",
      reasonCode: "UNAVAILABLE_EVIDENCE",
    });
    expect(stalePrice).toMatchObject({ status: "rejected", reasonCode: "STALE_ORACLE" });
  });

  it("freezes the assessment after validation and rejects a copied object without validator identity", async () => {
    const assessment = await acceptedAssessment();
    const candidates = await validatedCandidates(assessment);
    const copied = structuredClone(assessment);
    expect(
      Reflect.set(
        copied.draft.positionSnapshot.value.positions.REGULAR.borrowed[0],
        "balanceRaw",
        "999999999",
      ),
    ).toBe(true);
    const evaluate = vi.fn(async () => ({
      recommendedCandidateId: "candidate-a",
      reasoningSummary: "Fixture candidate selected.",
      comparisons: [],
      uncertainties: ["Synthetic fixture only."],
    }));

    expect(
      Object.isFrozen(assessment.draft.positionSnapshot.value.positions.REGULAR.borrowed),
    ).toBe(true);
    expect(
      Reflect.set(
        assessment.draft.positionSnapshot.value.positions.REGULAR.borrowed[0],
        "balanceRaw",
        "999999999",
      ),
    ).toBe(false);
    expect(await isAssessmentCurrent(assessment)).toBe(true);
    expect(
      await recommendValidatedCandidate({
        assessment: copied as typeof assessment,
        candidates,
        evaluate,
      }),
    ).toMatchObject({ status: "stopped", reasonCode: "ASSESSMENT_NOT_VALIDATED" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("rejects raw objects even when the caller also supplies the old true bypass flag", async () => {
    const raw = draftFixture();
    const evaluate = vi.fn();

    const result = await recommendValidatedCandidate({
      assessment: raw as never,
      assessmentVerified: true,
      candidates: [] as never,
      evaluate,
    } as never);

    expect(result).toEqual({ status: "stopped", reasonCode: "ASSESSMENT_NOT_VALIDATED" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("rejects a candidate for a token without assessed debt or with a zero amount", async () => {
    const assessment = await acceptedAssessment();
    const noDebtToken = await validateCandidatesForAssessment(assessment, [
      candidateFixture(assessment.assessmentId, assessment.positionSnapshotReference, {
        tokenId: "wrap.testnet",
      }),
    ]);
    const zeroAmount = await validateCandidatesForAssessment(assessment, [
      candidateFixture(assessment.assessmentId, assessment.positionSnapshotReference, {
        amountRaw: "0",
      }),
    ]);

    expect(noDebtToken).toMatchObject({ status: "rejected", reasonCode: "INVALID_CANDIDATE" });
    expect(zeroAmount).toMatchObject({ status: "rejected", reasonCode: "INVALID_CANDIDATE" });
  });

  it("selects an existing bound candidate and preserves assessment provenance in evaluator input", async () => {
    const assessment = await acceptedAssessment();
    const candidates = await validatedCandidates(assessment);
    let received: AgentInput | undefined;
    const result = await recommendValidatedCandidate({
      assessment,
      candidates,
      evaluate: async (input) => {
        received = input;
        return {
          recommendedCandidateId: "candidate-a",
          reasoningSummary: "The deterministic candidate has the stated trade-off.",
          comparisons: [
            { candidateId: "candidate-a", pros: ["Fits assessed debt."], cons: ["Estimate only."] },
          ],
          uncertainties: ["Fixture data is synthetic."],
        };
      },
    });

    expect(result.status).toBe("recommended");
    expect(received).toMatchObject({
      assessmentId: assessment.assessmentId,
      accountId: ACCOUNT_ID,
      protocol: "burrow",
      network: "testnet",
      positionSnapshotReference: assessment.positionSnapshotReference,
    });
    if (result.status === "recommended") expect(result.candidate).toBe(candidates[0]);
  });

  it("does not return a selection if the assessment expires while evaluation is pending", async () => {
    const assessment = await acceptedAssessment();
    const candidates = await validatedCandidates(assessment);
    const result = await recommendValidatedCandidate({
      assessment,
      candidates,
      evaluate: async () => {
        vi.setSystemTime(new Date(Date.parse(TEST_NOW) + 61_000));
        return {
          recommendedCandidateId: "candidate-a",
          reasoningSummary: "This result arrived after oracle expiry.",
          comparisons: [],
          uncertainties: ["Stale inputs."],
        };
      },
    });

    expect(result).toEqual({ status: "stopped", reasonCode: "ASSESSMENT_CHANGED" });
  });
});
