import Groq from "groq-sdk";
import { NextResponse } from "next/server";
import { getDemoAssessment, validateDemoRecommendation } from "../../../../lib/demo/fixture";

const SERVER_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

type ApiErrorCode =
  | "INVALID_REQUEST"
  | "AI_NOT_CONFIGURED"
  | "AI_RATE_LIMITED"
  | "AI_PROVIDER_AUTH_ERROR"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_PROVIDER_ERROR"
  | "AI_REQUEST_TIMEOUT"
  | "AI_NETWORK_ERROR"
  | "AI_MALFORMED_RESPONSE"
  | "AI_INVALID_RESPONSE";

class RequestTimeoutError extends Error {}

function errorResponse(code: ApiErrorCode, error: string, status: number, retryable = false) {
  return NextResponse.json({ error, code, retryable }, { status });
}

function providerErrorResponse(status: number) {
  if (status === 429) {
    return errorResponse(
      "AI_RATE_LIMITED",
      "Groq is rate limiting requests. Wait briefly, then retry.",
      429,
      true,
    );
  }
  if (status === 401 || status === 403) {
    return errorResponse(
      "AI_PROVIDER_AUTH_ERROR",
      "Groq rejected its server credentials. Check GROQ_API_KEY.",
      503,
    );
  }
  if (status >= 500) {
    return errorResponse(
      "AI_PROVIDER_UNAVAILABLE",
      "Groq is temporarily unavailable. Retry in a moment.",
      502,
      true,
    );
  }
  return errorResponse("AI_PROVIDER_ERROR", "Groq rejected the recommendation request.", 502);
}

function providerHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function providerDetails(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  const payload = (error as { error?: unknown }).error;
  if (!payload || typeof payload !== "object") return null;
  const nested = (payload as { error?: unknown }).error;
  return nested && typeof nested === "object"
    ? (nested as Record<string, unknown>)
    : (payload as Record<string, unknown>);
}

function providerErrorCode(error: unknown): string | number | null {
  const nestedCode = providerDetails(error)?.code;
  if (typeof nestedCode === "string" || typeof nestedCode === "number") return nestedCode;
  const directCode = (error as { code?: unknown }).code;
  return typeof directCode === "string" || typeof directCode === "number" ? directCode : null;
}

function sanitizedProviderMessage(error: unknown, apiKey: string): string | null {
  if (!(error instanceof Error)) return null;
  let message = error.message;
  const providerMessage = providerDetails(error)?.message;
  if (typeof providerMessage === "string") message = providerMessage;

  return message
    .replaceAll(apiKey, "[redacted]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/(?:authorization|api[_-]?key)(\s*[:=]\s*)[^\s,;"']+/gi, "[credential redacted]")
    .replace(/gsk_[\w-]+/g, "[redacted]")
    .slice(0, 300);
}

function logProviderFailure(error: unknown, apiKey: string) {
  const errorObject = error && typeof error === "object" ? error : null;
  const name =
    errorObject && typeof (errorObject as { name?: unknown }).name === "string"
      ? (errorObject as { name: string }).name
      : "UnknownError";
  const constructorName =
    errorObject && errorObject.constructor && typeof errorObject.constructor.name === "string"
      ? errorObject.constructor.name
      : "UnknownError";

  console.error(
    "Groq recommendation provider failure",
    JSON.stringify({
      name,
      type: constructorName,
      httpStatus: providerHttpStatus(error),
      groqCode: providerErrorCode(error),
      message: sanitizedProviderMessage(error, apiKey),
    }),
  );
}

function logRequestTiming(
  phase: string,
  startedAt: number,
  details: Record<string, string | number | null> = {},
) {
  console.info(
    "Groq recommendation request timing",
    JSON.stringify({ phase, elapsedMs: Date.now() - startedAt, ...details }),
  );
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || (body as { mode?: unknown }).mode !== "demo") {
    return errorResponse("INVALID_REQUEST", "This endpoint accepts demo mode only.", 400);
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return errorResponse(
      "AI_NOT_CONFIGURED",
      "AI setup required: configure GROQ_API_KEY on the server, then retry.",
      503,
    );
  }

  const assessment = getDemoAssessment();
  const payload = {
    position: {
      collateral: `${assessment.position.collateral.amount} ${assessment.position.collateral.token}`,
      collateralPriceUsd: assessment.position.collateral.priceUsd,
      debt: `${assessment.position.debt.amount} ${assessment.position.debt.token}`,
      debtPriceUsd: assessment.position.debt.priceUsd,
      collateralFactor: assessment.position.collateralFactor,
    },
    risk: { healthFactor: assessment.healthFactor, status: assessment.risk },
    candidates: assessment.candidates.map(
      ({ id, label, token, amount, debtAfter, healthFactor, tradeoff }) => ({
        id,
        label,
        token,
        amount,
        debtAfter,
        healthFactor,
        tradeoff,
      }),
    ),
  };
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const requestStartedAt = Date.now();

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new RequestTimeoutError("The Groq request timed out."));
      }, SERVER_REQUEST_TIMEOUT_MS);
    });
    const client = new Groq({
      apiKey,
      timeout: SERVER_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      fetch: async (input, init) => {
        logRequestTiming("http_request_started", requestStartedAt);
        try {
          const response = await globalThis.fetch(input, init);
          logRequestTiming("response_headers_received", requestStartedAt, {
            httpStatus: response.status,
          });
          return response;
        } catch (error) {
          logRequestTiming("http_request_failed", requestStartedAt, {
            errorType:
              error &&
              typeof error === "object" &&
              typeof (error as { name?: unknown }).name === "string"
                ? (error as { name: string }).name
                : "UnknownError",
          });
          throw error;
        }
      },
    });
    logRequestTiming("sdk_call_started", requestStartedAt);
    const providerCall = client.chat.completions
      .create(
        {
          model: process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL,
          messages: [
            {
              role: "system",
              content:
                "You are a bounded DeFi risk explainer. Explain the supplied synthetic position and compare only the supplied deterministic candidates. Never calculate, modify, or invent financial facts, quantities, prices, ratios, fees, or costs. Use qualitative language only; do not write numerals, currency symbols, percentages, or number words. Recommend one candidate by ID. State that the fixture is synthetic and no transaction occurs. Return only JSON matching the required schema.",
            },
            { role: "user", content: JSON.stringify(payload) },
          ],
          reasoning_effort: "low",
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "demo_recommendation",
              strict: true,
              schema: recommendationSchema(assessment.candidates.map(({ id }) => id)),
            },
          },
        },
        { signal: controller.signal },
      )
      .then(
        (completion) => {
          // Non-streaming Chat Completions resolves after the full body is parsed.
          logRequestTiming("sdk_response_complete", requestStartedAt);
          return completion;
        },
        (error: unknown) => {
          logRequestTiming("sdk_request_failed", requestStartedAt, {
            errorType:
              error &&
              typeof error === "object" &&
              typeof (error as { name?: unknown }).name === "string"
                ? (error as { name: string }).name
                : "UnknownError",
          });
          throw error;
        },
      );

    const completion = await Promise.race([providerCall, timeout]);
    const content = completion.choices[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      return errorResponse(
        "AI_MALFORMED_RESPONSE",
        "Groq returned no structured recommendation. Retry the recommendation.",
        502,
        true,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return errorResponse(
        "AI_MALFORMED_RESPONSE",
        "Groq returned malformed structured output. Retry the recommendation.",
        502,
        true,
      );
    }
    const recommendation = validateDemoRecommendation(parsed);
    if (!recommendation) {
      return errorResponse(
        "AI_INVALID_RESPONSE",
        "Groq's response failed candidate and content validation. Retry the recommendation.",
        502,
        true,
      );
    }
    return NextResponse.json({ recommendation });
  } catch (error) {
    logProviderFailure(error, apiKey);
    if (
      error instanceof RequestTimeoutError ||
      controller.signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          error.name === "TimeoutError" ||
          error.name === "APIConnectionTimeoutError"))
    ) {
      return errorResponse(
        "AI_REQUEST_TIMEOUT",
        "The Groq recommendation timed out. No action was taken. Retry when ready.",
        504,
        true,
      );
    }
    const status = providerHttpStatus(error);
    if (status !== null) return providerErrorResponse(status);
    if (error instanceof SyntaxError) {
      return errorResponse(
        "AI_MALFORMED_RESPONSE",
        "Groq returned a malformed provider response. Retry the recommendation.",
        502,
        true,
      );
    }
    return errorResponse(
      "AI_NETWORK_ERROR",
      "Could not reach Groq. Check the server connection and retry.",
      502,
      true,
    );
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function recommendationSchema(candidateIds: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["recommendedCandidateId", "reasoningSummary", "comparisons", "limitations"],
    properties: {
      recommendedCandidateId: { type: "string", enum: candidateIds },
      reasoningSummary: { type: "string" },
      comparisons: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["candidateId", "pros", "cons"],
          properties: {
            candidateId: { type: "string", enum: candidateIds },
            pros: { type: "array", items: { type: "string" } },
            cons: { type: "array", items: { type: "string" } },
          },
        },
      },
      limitations: { type: "array", items: { type: "string" } },
    },
  };
}
