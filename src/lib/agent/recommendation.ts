/**
 * Bounded recommendation selection. This module has no wallet, RPC, approval,
 * or execution capability; financial facts remain owned by deterministic code.
 */

import {
  isAssessmentCurrent,
  isValidatedCandidate,
  type ValidatedAssessment,
  type ValidatedCandidate,
} from "./assessment";

export type AgentCandidateSummary = Readonly<{
  candidateId: string;
  repaymentCostDisplay: string;
  projectedHealthFactorDisplay: string;
}>;

export type AgentInput = Readonly<{
  assessmentId: string;
  accountId: string;
  protocol: "burrow";
  network: string;
  positionSnapshotReference: string;
  candidates: readonly AgentCandidateSummary[];
}>;

export type AgentOutput = Readonly<{
  recommendedCandidateId: string | null;
  reasoningSummary: string;
  comparisons: readonly Readonly<{
    candidateId: string;
    pros: readonly string[];
    cons: readonly string[];
  }>[];
  uncertainties: readonly string[];
}>;

export type AgentEvaluator = (input: AgentInput) => Promise<unknown>;

export type RecommendationResult =
  | {
      status: "stopped";
      reasonCode:
        | "ASSESSMENT_NOT_VALIDATED"
        | "ASSESSMENT_CHANGED"
        | "NO_VALID_CANDIDATES"
        | "CANDIDATE_NOT_BOUND";
    }
  | { status: "invalid-output"; reason: string }
  | {
      status: "recommended";
      candidate: ValidatedCandidate;
      explanation: AgentOutput;
    };

const MAX_TEXT_LENGTH = 500;
const MAX_BULLETS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function parseOutput(
  output: unknown,
  candidates: readonly ValidatedCandidate[],
): AgentOutput | null {
  if (
    !isRecord(output) ||
    !exactKeys(output, [
      "recommendedCandidateId",
      "reasoningSummary",
      "comparisons",
      "uncertainties",
    ]) ||
    !(
      output.recommendedCandidateId === null || typeof output.recommendedCandidateId === "string"
    ) ||
    !isBoundedText(output.reasoningSummary) ||
    !Array.isArray(output.comparisons) ||
    output.comparisons.length > candidates.length ||
    !Array.isArray(output.uncertainties) ||
    output.uncertainties.length > MAX_BULLETS ||
    !output.uncertainties.every(isBoundedText)
  ) {
    return null;
  }

  const allowedIds = new Set(candidates.map((candidate) => candidate.candidateId));
  if (
    (output.recommendedCandidateId !== null && !allowedIds.has(output.recommendedCandidateId)) ||
    !output.comparisons.every(
      (comparison) =>
        isRecord(comparison) &&
        exactKeys(comparison, ["candidateId", "pros", "cons"]) &&
        typeof comparison.candidateId === "string" &&
        allowedIds.has(comparison.candidateId) &&
        Array.isArray(comparison.pros) &&
        comparison.pros.length <= MAX_BULLETS &&
        comparison.pros.every(isBoundedText) &&
        Array.isArray(comparison.cons) &&
        comparison.cons.length <= MAX_BULLETS &&
        comparison.cons.every(isBoundedText),
    )
  ) {
    return null;
  }
  return output as AgentOutput;
}

export async function recommendValidatedCandidate(options: {
  assessment: ValidatedAssessment;
  candidates: readonly ValidatedCandidate[];
  evaluate: AgentEvaluator;
}): Promise<RecommendationResult> {
  if (!(await isAssessmentCurrent(options.assessment))) {
    return { status: "stopped", reasonCode: "ASSESSMENT_NOT_VALIDATED" };
  }
  if (options.candidates.length === 0) {
    return { status: "stopped", reasonCode: "NO_VALID_CANDIDATES" };
  }
  if (
    !options.candidates.every(
      (candidate) =>
        isValidatedCandidate(candidate) &&
        candidate.assessmentId === options.assessment.assessmentId &&
        candidate.positionSnapshotReference === options.assessment.positionSnapshotReference &&
        candidate.accountId === options.assessment.draft.accountId.value &&
        candidate.protocol === options.assessment.draft.protocol.value.id &&
        candidate.network === options.assessment.draft.network.value,
    )
  ) {
    return { status: "stopped", reasonCode: "CANDIDATE_NOT_BOUND" };
  }

  const output = await options.evaluate({
    assessmentId: options.assessment.assessmentId,
    accountId: options.assessment.draft.accountId.value,
    protocol: options.assessment.draft.protocol.value.id,
    network: options.assessment.draft.network.value,
    positionSnapshotReference: options.assessment.positionSnapshotReference,
    candidates: options.candidates.map(
      ({ candidateId, repaymentCostDisplay, projectedHealthFactorDisplay }) => ({
        candidateId,
        repaymentCostDisplay,
        projectedHealthFactorDisplay,
      }),
    ),
  });

  // Guard again after the evaluator's await to avoid returning a selection for
  // an assessment that became stale while the evaluation was in flight.
  if (!(await isAssessmentCurrent(options.assessment))) {
    return { status: "stopped", reasonCode: "ASSESSMENT_CHANGED" };
  }

  const explanation = parseOutput(output, options.candidates);
  if (!explanation || explanation.recommendedCandidateId === null) {
    return {
      status: "invalid-output",
      reason:
        "The evaluator did not return a schema-valid recommendation for a supplied candidate.",
    };
  }

  const candidate = options.candidates.find(
    (item) => item.candidateId === explanation.recommendedCandidateId,
  );
  if (!candidate) {
    return {
      status: "invalid-output",
      reason: "The recommendation did not resolve to a supplied candidate.",
    };
  }
  return { status: "recommended", candidate, explanation };
}
