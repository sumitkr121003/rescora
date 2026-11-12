/** Explicitly synthetic fixture and deterministic illustration logic. */
export const DEMO_POSITION = Object.freeze({
  positionId: "demo-position-01",
  accountId: "demo.borrower.testnet",
  collateral: Object.freeze({ token: "NEAR", amount: 2_000, priceUsd: 4 }),
  debt: Object.freeze({ token: "USDC", amount: 6_500, priceUsd: 1 }),
  repayBalance: Object.freeze({ token: "USDC", amount: 3_000, decimals: 6 }),
  // Fixture-only threshold assumption; it is not asserted to match Burrow.
  collateralFactor: 0.75,
  snapshot: "Synthetic fixture · fixed prices · no chain data",
});

export type DemoCandidate = Readonly<{
  id: "partial" | "buffered";
  label: string;
  token: "USDC";
  amount: number;
  amountRaw: string;
  debtAfter: number;
  healthFactor: number;
  tradeoff: string;
}>;

const QUANTIFICATION =
  /[0-9$%]|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|twice|half|percentage|percent)\b/i;

function isBoundedExplanation(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !QUANTIFICATION.test(value)
  );
}

export function getDemoAssessment() {
  // The demo uses fixed USD prices, a 1.00 risk boundary, and preselected
  // repayment sizes. Candidate size is capped by debt and available demo funds.
  const collateralValue = DEMO_POSITION.collateral.amount * DEMO_POSITION.collateral.priceUsd;
  const debtValue = DEMO_POSITION.debt.amount * DEMO_POSITION.debt.priceUsd;
  const liquidationValue = collateralValue * DEMO_POSITION.collateralFactor;
  const healthFactor = liquidationValue / debtValue;
  const candidates = buildRepaymentCandidates(
    debtValue,
    liquidationValue,
    DEMO_POSITION.repayBalance.amount,
  );
  return Object.freeze({
    position: DEMO_POSITION,
    collateralValue,
    debtValue,
    liquidationValue,
    healthFactor,
    risk: healthFactor < 1 ? "At illustrative liquidation risk" : "Illustratively above threshold",
    candidates: Object.freeze(candidates),
  });
}

/** Builds the fixed demo strategies while failing closed on invalid inputs. */
export function buildRepaymentCandidates(
  debtValue: number,
  liquidationValue: number,
  repaymentBalance: number,
): DemoCandidate[] {
  if (
    !Number.isSafeInteger(debtValue) ||
    debtValue <= 0 ||
    !Number.isSafeInteger(liquidationValue) ||
    liquidationValue < 0 ||
    !Number.isSafeInteger(repaymentBalance) ||
    repaymentBalance <= 0
  ) {
    return [];
  }
  const candidateAmounts = [...new Set([1_000, 2_000])]
    .map((amount) => Math.min(amount, debtValue, repaymentBalance))
    .filter(
      (amount, index, amounts) =>
        amount > 0 && amount < debtValue && amounts.indexOf(amount) === index,
    )
    .sort((left, right) => left - right);
  return candidateAmounts.map((amount, index) =>
    makeCandidate(
      index === 0 ? "partial" : "buffered",
      index === 0 ? "Lower-cost relief" : "Larger safety buffer",
      amount,
      debtValue,
      liquidationValue,
    ),
  );
}

/** Local deterministic explanation used whenever the optional Groq service fails. */
export function getDemoFallbackRecommendation() {
  const assessment = getDemoAssessment();
  const selected = assessment.candidates.at(-1);
  if (!selected || assessment.candidates.length !== 2) return null;
  return {
    recommendedCandidateId: selected.id,
    reasoningSummary:
      "This deterministic fallback selects the larger precomputed repayment to show its stronger illustrative buffer. Consider the smaller option when preserving more of the synthetic balance matters.",
    comparisons: assessment.candidates.map((candidate) => ({
      candidateId: candidate.id,
      pros: [candidate.tradeoff],
      cons: [
        candidate.id === "partial"
          ? "Leaves a smaller illustrative buffer."
          : "Uses more of the synthetic repay balance.",
      ],
    })),
    limitations: [
      "Deterministic fallback; no AI provider response was used.",
      "Position, balances, prices and risk are synthetic; no transaction occurs.",
    ],
  };
}

function makeCandidate(
  id: DemoCandidate["id"],
  label: string,
  amount: number,
  debtValue: number,
  liquidationValue: number,
): DemoCandidate {
  const debtAfter = debtValue - amount;
  return Object.freeze({
    id,
    label,
    token: "USDC",
    amount,
    amountRaw: String(amount * 1_000_000),
    debtAfter,
    healthFactor: liquidationValue / debtAfter,
    tradeoff:
      id === "partial"
        ? "Uses less cash; leaves less room for further price changes."
        : "Uses more cash; leaves a larger illustrative buffer.",
  });
}

export function validateDemoRecommendation(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== 4 ||
    !["recommendedCandidateId", "reasoningSummary", "comparisons", "limitations"].every(
      (key) => key in result,
    )
  )
    return null;
  const assessment = getDemoAssessment();
  const ids = assessment.candidates.map(({ id }) => id);
  if (result.recommendedCandidateId !== "partial" && result.recommendedCandidateId !== "buffered")
    return null;
  if (!ids.includes(result.recommendedCandidateId as DemoCandidate["id"])) return null;
  if (!isBoundedExplanation(result.reasoningSummary, 800)) return null;
  if (!Array.isArray(result.comparisons) || result.comparisons.length !== 2) return null;
  const comparisons = result.comparisons as unknown[];
  if (
    !comparisons.every((item) => {
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      return (
        Object.keys(row).length === 3 &&
        ["candidateId", "pros", "cons"].every((key) => key in row) &&
        ids.includes(row.candidateId as DemoCandidate["id"]) &&
        Array.isArray(row.pros) &&
        row.pros.length <= 4 &&
        row.pros.every((x) => isBoundedExplanation(x, 240)) &&
        Array.isArray(row.cons) &&
        row.cons.length <= 4 &&
        row.cons.every((x) => isBoundedExplanation(x, 240))
      );
    }) ||
    new Set(comparisons.map((item) => (item as { candidateId: string }).candidateId)).size !== 2
  )
    return null;
  if (
    !Array.isArray(result.limitations) ||
    result.limitations.length > 5 ||
    !result.limitations.every((x) => isBoundedExplanation(x, 240))
  )
    return null;
  return Object.freeze({
    recommendedCandidateId: result.recommendedCandidateId as DemoCandidate["id"],
    reasoningSummary: result.reasoningSummary,
    comparisons: comparisons as { candidateId: string; pros: string[]; cons: string[] }[],
    limitations: result.limitations as string[],
  });
}
