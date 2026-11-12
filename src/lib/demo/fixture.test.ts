import { describe, expect, it } from "vitest";
import {
  getDemoAssessment,
  getDemoFallbackRecommendation,
  buildRepaymentCandidates,
  validateDemoRecommendation,
} from "./fixture";

describe("synthetic demo assessment", () => {
  it("calculates fixed risk and balance-capped repayment options deterministically", () => {
    const first = getDemoAssessment();
    const second = getDemoAssessment();
    expect(first).toEqual(second);
    expect(first.healthFactor).toBeCloseTo(6000 / 6500);
    expect(first.risk).toBe("At illustrative liquidation risk");
    expect(first.candidates.map(({ amount }) => amount)).toEqual([1000, 2000]);
    expect(
      first.candidates.every((candidate) => candidate.amount <= first.position.repayBalance.amount),
    ).toBe(true);
    expect(first.candidates.every((candidate) => candidate.healthFactor > 1)).toBe(true);
    expect(first.candidates.map(({ healthFactor }) => healthFactor)).toEqual([
      6000 / 5500,
      6000 / 4500,
    ]);
    expect(first.candidates.map(({ amountRaw }) => amountRaw)).toEqual([
      "1000000000",
      "2000000000",
    ]);
  });

  it("orders candidates by repayment amount and caps each at debt and synthetic balance", () => {
    const assessment = getDemoAssessment();
    expect(assessment.candidates.map(({ amount }) => amount)).toEqual([1000, 2000]);
    expect(assessment.candidates).toEqual(
      [...assessment.candidates].sort((left, right) => left.amount - right.amount),
    );
    expect(
      assessment.candidates.every(
        ({ amount }) =>
          amount > 0 &&
          amount < assessment.position.debt.amount &&
          amount <= assessment.position.repayBalance.amount,
      ),
    ).toBe(true);
  });

  it("fails closed for zero, negative, malformed or non-integer repayment inputs", () => {
    expect(buildRepaymentCandidates(0, 6000, 3000)).toEqual([]);
    expect(buildRepaymentCandidates(-1, 6000, 3000)).toEqual([]);
    expect(buildRepaymentCandidates(6500, -1, 3000)).toEqual([]);
    expect(buildRepaymentCandidates(6500, 6000, 0)).toEqual([]);
    expect(buildRepaymentCandidates(6500.5, 6000, 3000)).toEqual([]);
    expect(buildRepaymentCandidates(Number.NaN, 6000, 3000)).toEqual([]);
  });

  it("deduplicates capped strategies and never repays all debt", () => {
    const candidates = buildRepaymentCandidates(1_500, 600, 1_000);
    expect(candidates.map(({ amount }) => amount)).toEqual([1_000]);
    expect(candidates.every(({ amount, debtAfter }) => amount < 1_500 && debtAfter > 0)).toBe(true);
  });

  it("provides a schema-valid local explanation without an AI provider", () => {
    expect(validateDemoRecommendation(getDemoFallbackRecommendation())).toMatchObject({
      recommendedCandidateId: "buffered",
    });
  });

  it("accepts only a bounded recommendation for the exact supplied candidate IDs", () => {
    const valid = {
      recommendedCandidateId: "partial",
      reasoningSummary:
        "The smaller payment improves the illustrative ratio while using less cash.",
      comparisons: [
        { candidateId: "partial", pros: ["Lower amount"], cons: ["Smaller buffer"] },
        { candidateId: "buffered", pros: ["Larger buffer"], cons: ["Higher amount"] },
      ],
      limitations: ["Fixture values are synthetic."],
    };
    expect(validateDemoRecommendation(valid)).toMatchObject({ recommendedCandidateId: "partial" });
    expect(validateDemoRecommendation({ ...valid, recommendedCandidateId: "invented" })).toBeNull();
    expect(validateDemoRecommendation({ ...valid, extra: "unexpected" })).toBeNull();
    expect(
      validateDemoRecommendation({
        ...valid,
        reasoningSummary: "Repay $100 to get a higher ratio.",
      }),
    ).toBeNull();
    expect(
      validateDemoRecommendation({ ...valid, reasoningSummary: "Two options are available." }),
    ).toBeNull();
    expect(
      validateDemoRecommendation({
        ...valid,
        comparisons: [valid.comparisons[0], valid.comparisons[0]],
      }),
    ).toBeNull();
  });
});
