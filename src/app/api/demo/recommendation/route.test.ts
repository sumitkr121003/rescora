// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const TEST_API_KEY = "gsk_test_only_not_a_real_provider_key";

function demoRequest() {
  return new Request("http://localhost/api/demo/recommendation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "demo" }),
  });
}

function groqResponse(outputText: string, status = 200) {
  const body =
    status >= 400
      ? {
          error: {
            message: "provider detail must not be returned",
            type: "server_error",
            code: "service_unavailable",
          },
        }
      : {
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1,
          model: "openai/gpt-oss-120b",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: outputText },
            },
          ],
        };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validModelOutput() {
  return JSON.stringify({
    recommendedCandidateId: "buffered",
    reasoningSummary:
      "The larger repayment leaves a stronger illustrative buffer, while the smaller option preserves more of the synthetic balance.",
    comparisons: [
      {
        candidateId: "partial",
        pros: ["Uses less of the synthetic repay balance."],
        cons: ["Leaves a narrower illustrative cushion."],
      },
      {
        candidateId: "buffered",
        pros: ["Leaves a wider illustrative cushion."],
        cons: ["Uses more of the synthetic repay balance."],
      },
    ],
    limitations: ["The position and prices are synthetic; no transaction occurs."],
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Groq demo recommendation endpoint", () => {
  it("rejects non-demo requests before reading credentials or calling Groq", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(
      new Request("http://localhost/api/demo/recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "live" }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns setup guidance immediately without GROQ_API_KEY", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(demoRequest());
    const result = await response.json();
    expect(response.status).toBe(503);
    expect(result).toMatchObject({ code: "AI_NOT_CONFIGURED", retryable: false });
    expect(result.error).toContain("GROQ_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds the complete SDK request including a stalled response-body read", async () => {
    vi.stubEnv("GROQ_API_KEY", TEST_API_KEY);
    vi.useFakeTimers();
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => (fetchStarted = resolve));
    const stalledBody = groqResponse(validModelOutput());
    vi.spyOn(stalledBody, "json").mockImplementation(() => new Promise<unknown>(() => {}));
    vi.spyOn(stalledBody, "text").mockImplementation(() => new Promise<string>(() => {}));
    const fetchMock = vi.fn<typeof fetch>(async () => {
      fetchStarted();
      return stalledBody;
    });
    vi.stubGlobal("fetch", fetchMock);
    const pendingResponse = POST(demoRequest());
    await started;
    await vi.advanceTimersByTimeAsync(15_001);
    const response = await pendingResponse;
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      code: "AI_REQUEST_TIMEOUT",
      retryable: true,
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal?.aborted).toBe(true);
    const phases = consoleInfo.mock.calls.map((call) => String(call[1]));
    expect(phases.some((entry) => entry.includes('"phase":"http_request_started"'))).toBe(true);
    expect(phases.some((entry) => entry.includes('"phase":"response_headers_received"'))).toBe(
      true,
    );
    expect(phases.some((entry) => entry.includes('"phase":"sdk_response_complete"'))).toBe(false);
  });

  it("handles Groq HTTP 429 rate limits without exposing provider details", async () => {
    vi.stubEnv("GROQ_API_KEY", TEST_API_KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => groqResponse("", 429)),
    );
    const response = await POST(demoRequest());
    const text = await response.text();
    expect(response.status).toBe(429);
    expect(text).toContain("AI_RATE_LIMITED");
    expect(text).not.toContain("provider detail");
    expect(text).not.toContain(TEST_API_KEY);
  });

  it("handles authentication and other provider failures explicitly", async () => {
    vi.stubEnv("GROQ_API_KEY", TEST_API_KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => groqResponse("", 401)),
    );
    const authenticationFailure = await POST(demoRequest());
    const authText = await authenticationFailure.text();
    expect(authenticationFailure.status).toBe(503);
    expect(authText).toContain("AI_PROVIDER_AUTH_ERROR");
    expect(authText).toContain("GROQ_API_KEY");
    expect(authText).not.toContain(TEST_API_KEY);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => groqResponse("", 503)),
    );
    const providerFailure = await POST(demoRequest());
    await expect(providerFailure.json()).resolves.toMatchObject({
      code: "AI_PROVIDER_UNAVAILABLE",
      retryable: true,
    });
  });

  it("logs safe Groq diagnostics while keeping provider details out of the browser response", async () => {
    vi.stubEnv("GROQ_API_KEY", TEST_API_KEY);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: `temporary failure; Authorization: Bearer ${TEST_API_KEY}`,
                type: "server_error",
                code: "capacity_exhausted",
              },
            }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const response = await POST(demoRequest());
    const browserBody = await response.text();
    expect(response.status).toBe(502);
    expect(browserBody).toContain("AI_PROVIDER_UNAVAILABLE");
    expect(browserBody).not.toContain("temporary failure");
    expect(browserBody).not.toContain(TEST_API_KEY);

    expect(consoleError).toHaveBeenCalledOnce();
    const diagnostic = String(consoleError.mock.calls[0]?.[1]);
    expect(diagnostic).toContain('"type":"InternalServerError"');
    expect(diagnostic).toContain('"httpStatus":503');
    expect(diagnostic).toContain('"groqCode":"capacity_exhausted"');
    expect(diagnostic).toContain("temporary failure");
    expect(diagnostic).not.toContain(TEST_API_KEY);
    expect(diagnostic).not.toContain("Authorization");
  });

  it("handles network failures without returning low-level errors", async () => {
    vi.stubEnv("GROQ_API_KEY", TEST_API_KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("socket detail"))),
    );
    const response = await POST(demoRequest());
    const result = await response.json();
    expect(response.status).toBe(502);
    expect(result).toMatchObject({ code: "AI_NETWORK_ERROR", retryable: true });
    expect(JSON.stringify(result)).not.toContain("socket detail");
  });

  it("distinguishes malformed provider output from invalid structured content", async () => {
    vi.stubEnv("GROQ_API_KEY", TEST_API_KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not-json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const malformedProvider = await POST(demoRequest());
    await expect(malformedProvider.json()).resolves.toMatchObject({
      code: "AI_MALFORMED_RESPONSE",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => groqResponse("not-json")),
    );
    const malformedModel = await POST(demoRequest());
    await expect(malformedModel.json()).resolves.toMatchObject({
      code: "AI_MALFORMED_RESPONSE",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        groqResponse(
          JSON.stringify({
            ...JSON.parse(validModelOutput()),
            recommendedCandidateId: "invented-candidate",
          }),
        ),
      ),
    );
    const invalidCandidate = await POST(demoRequest());
    await expect(invalidCandidate.json()).resolves.toMatchObject({
      code: "AI_INVALID_RESPONSE",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const output = JSON.parse(validModelOutput());
        output.amount = 9_999_999;
        return groqResponse(JSON.stringify(output));
      }),
    );
    const attemptedAmountOverride = await POST(demoRequest());
    await expect(attemptedAmountOverride.json()).resolves.toMatchObject({
      code: "AI_INVALID_RESPONSE",
    });
  });

  it("returns validated structured output and sends strict schema to Groq", async () => {
    vi.stubEnv("GROQ_API_KEY", TEST_API_KEY);
    vi.stubEnv("GROQ_MODEL", "openai/gpt-oss-120b-test");
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>(async () => groqResponse(validModelOutput()));
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(demoRequest());
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.recommendation).toMatchObject({ recommendedCandidateId: "buffered" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const phases = consoleInfo.mock.calls.map((call) => String(call[1]));
    expect(phases.some((entry) => entry.includes('"phase":"http_request_started"'))).toBe(true);
    expect(phases.some((entry) => entry.includes('"phase":"response_headers_received"'))).toBe(
      true,
    );
    expect(phases.some((entry) => entry.includes('"phase":"sdk_response_complete"'))).toBe(true);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toContain("api.groq.com/openai/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    const requestBody = JSON.parse(String(init?.body));
    expect(requestBody).toMatchObject({
      model: "openai/gpt-oss-120b-test",
      reasoning_effort: "low",
      response_format: {
        type: "json_schema",
        json_schema: { name: "demo_recommendation", strict: true },
      },
    });
    expect(requestBody.response_format.json_schema.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["recommendedCandidateId", "reasoningSummary", "comparisons", "limitations"],
    });
    expect(JSON.stringify(result)).not.toContain(TEST_API_KEY);
  });
});
