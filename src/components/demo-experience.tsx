"use client";

import { useRef, useState } from "react";
import {
  getDemoAssessment,
  getDemoFallbackRecommendation,
  type DemoCandidate,
} from "@/lib/demo/fixture";
import { BurrowPositionsPanel } from "@/components/burrow-positions-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

type Recommendation = {
  recommendedCandidateId: DemoCandidate["id"];
  reasoningSummary: string;
  comparisons: { candidateId: string; pros: string[]; cons: string[] }[];
  limitations: string[];
};

const CLIENT_REQUEST_TIMEOUT_MS = 20_000;

class RecommendationRequestError extends Error {}

export function DemoExperience() {
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [selected, setSelected] = useState<DemoCandidate["id"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState("");
  const activeRequest = useRef<AbortController | null>(null);
  const data = getDemoAssessment();
  const candidate = data.candidates.find((item) => item.id === selected) ?? null;

  async function askAgent() {
    if (busy) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), CLIENT_REQUEST_TIMEOUT_MS);
    setBusy(true);
    setAiStatus("");
    setRecommendation(null);
    try {
      const response = await fetch("/api/demo/recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "demo" }),
        signal: controller.signal,
      });
      let result: { recommendation?: Recommendation; error?: string };
      try {
        result = (await response.json()) as typeof result;
      } catch {
        if (controller.signal.aborted) throw new Error("timeout");
        throw new RecommendationRequestError(
          "The recommendation service returned a malformed response. Try again.",
        );
      }
      if (!response.ok || !result.recommendation) {
        const message =
          typeof result.error === "string" && result.error.length <= 500
            ? result.error
            : "The recommendation could not be validated. Try again.";
        throw new RecommendationRequestError(message);
      }
      setRecommendation(result.recommendation);
      setSelected(result.recommendation.recommendedCandidateId);
    } catch (caught) {
      if (activeRequest.current !== controller) return;
      const reason = controller.signal.aborted
        ? "the request timed out"
        : caught instanceof RecommendationRequestError
          ? caught.message
          : "the recommendation service could not be reached";
      const fallback = getDemoFallbackRecommendation();
      if (fallback) {
        setRecommendation(fallback);
        setSelected(fallback.recommendedCandidateId);
        setAiStatus(`Groq unavailable: ${reason} Showing a deterministic fallback.`);
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  }

  function changeMode(nextMode: "demo" | "live") {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setBusy(false);
    setAiStatus("");
    setRecommendation(null);
    setSelected(null);
    setMode(nextMode);
  }

  return (
    <div className="page-stack">
      <section className="page-heading demo-heading">
        <div>
          <p className="eyebrow">RESCORA · BURROW POSITION SAFETY</p>
          <h1>Know your risk. Review a rescue.</h1>
          <p className="page-description">
            Connect a wallet to check a position, then understand risk and review a repayment option
            when validated data is available. Explore the synthetic demo without connecting.
          </p>
        </div>
        <div className="mode-switch" role="group" aria-label="Data source">
          <button
            type="button"
            className="explore-demo"
            aria-pressed={mode === "demo"}
            onClick={() => changeMode("demo")}
          >
            Explore Demo
          </button>
          <button type="button" aria-pressed={mode === "live"} onClick={() => changeMode("live")}>
            Live connection
          </button>
        </div>
      </section>

      <ol className="product-flow" aria-label="How RESCORA works">
        <li>
          <span>01</span>Connect wallet
        </li>
        <li>
          <span>02</span>View position
        </li>
        <li>
          <span>03</span>Understand risk
        </li>
        <li>
          <span>04</span>Review recommendation
        </li>
      </ol>

      {mode === "live" ? (
        <>
          <div className="live-notice">
            <strong>Live risk assessment unavailable</strong>
            <span>
              Burrow position reads are read-only. Risk and repayment recommendations stay disabled
              until live inputs pass validation. Choose Explore Demo above for a clearly labelled
              synthetic example.
            </span>
          </div>
          <BurrowPositionsPanel />
        </>
      ) : (
        <>
          <div className="demo-banner">
            <span>DEMO — SYNTHETIC DATA</span>
            <p>
              This illustrative position does not belong to your connected wallet and is not a real
              Burrow account or market snapshot.
            </p>
          </div>
          <nav className="demo-journey" aria-label="Demo steps">
            <a href="#demo-position">
              <span>01</span>Position
            </a>
            <a href="#demo-risk">
              <span>02</span>Risk
            </a>
            <a href="#demo-strategies">
              <span>03</span>Compare
            </a>
            <a href="#demo-recommendation">
              <span>04</span>Recommendation
            </a>
            <a href={candidate ? "#demo-proposal" : "#demo-strategies"}>
              <span>05</span>Proposal review
            </a>
          </nav>
          <section className="demo-overview" aria-label="Synthetic lending position">
            <Card className="demo-position-card" id="demo-position">
              <SyntheticLabel />
              <CardHeader>
                <div>
                  <p className="eyebrow">SAMPLE BURROW POSITION</p>
                  <h2>Position overview</h2>
                </div>
                <Badge tone="neutral">Synthetic</Badge>
              </CardHeader>
              <CardBody>
                <p className="demo-account">
                  {data.position.accountId}
                  <span>Sample account · no wallet required</span>
                </p>
                <div className="metric-grid">
                  <Metric
                    label="Collateral"
                    value={`${data.position.collateral.amount.toLocaleString()} NEAR`}
                    detail={`$${data.collateralValue.toLocaleString()} at $${data.position.collateral.priceUsd.toFixed(2)} / NEAR`}
                  />
                  <Metric
                    label="Borrowed"
                    value={`${data.position.debt.amount.toLocaleString()} USDC`}
                    detail={`$${data.debtValue.toLocaleString()} at $1.00 / USDC`}
                  />
                  <Metric
                    label="Collateral value at factor"
                    value={`$${data.liquidationValue.toLocaleString()}`}
                    detail="Illustrative 75% collateral factor"
                  />
                  <Metric
                    label="Synthetic repay balance"
                    value={`${data.position.repayBalance.amount.toLocaleString()} USDC`}
                    detail="Demo-only available balance used to cap candidates"
                  />
                </div>
              </CardBody>
            </Card>
            <Card className="risk-card" id="demo-risk">
              <SyntheticLabel />
              <CardHeader>
                <div>
                  <p className="eyebrow">DETERMINISTIC ILLUSTRATION</p>
                  <h2>Liquidation risk</h2>
                </div>
                <Badge tone="neutral">Demo model</Badge>
              </CardHeader>
              <CardBody>
                <div className="risk-score">
                  <strong>{data.healthFactor.toFixed(2)}</strong>
                  <span>illustrative health factor</span>
                </div>
                <p className="risk-status">{data.risk}</p>
                <p className="risk-explain">
                  Illustrative health factor = collateral value × 75% ÷ debt value. Below 1.00 means
                  this simplified fixture falls under its stated liquidation boundary. Burrow’s
                  deployed mechanics and live oracle prices are not represented.
                </p>
              </CardBody>
            </Card>
          </section>

          <Card className="strategy-card" id="demo-strategies">
            <SyntheticLabel />
            <CardHeader>
              <div>
                <p className="eyebrow">DETERMINISTIC OPTIONS</p>
                <h2>Compare repayment strategies</h2>
                <p className="card-subtitle">
                  Both candidates repay the synthetic USDC debt directly. Amounts and projected
                  ratios are computed from the fixture.
                </p>
              </div>
              <Badge tone="info">2 valid demo options</Badge>
            </CardHeader>
            <CardBody>
              <div className="strategy-list">
                {data.candidates.map((item) => (
                  <button
                    className={`strategy-option${selected === item.id ? " is-selected" : ""}`}
                    key={item.id}
                    onClick={() => setSelected(item.id)}
                    aria-pressed={selected === item.id}
                  >
                    <span className="strategy-option__title">
                      {item.label}
                      <small>{item.tradeoff}</small>
                    </span>
                    <span className="strategy-option__amount">
                      {item.amount.toLocaleString()} USDC
                      <small>Exact fixture units: {item.amountRaw} (6 decimals)</small>
                    </span>
                    <span className="strategy-option__result">
                      {item.healthFactor.toFixed(2)}
                      <small>projected illustrative HF</small>
                    </span>
                  </button>
                ))}
              </div>
              <div className="agent-row" id="demo-recommendation">
                <div>
                  <h3>AI rescue recommendation</h3>
                  <p>
                    {recommendation
                      ? recommendation.reasoningSummary
                      : "The model can compare only these precomputed options. It cannot change any amounts or risk values."}
                  </p>
                </div>
                <Button onClick={askAgent} disabled={busy}>
                  {busy
                    ? "Asking the model…"
                    : recommendation
                      ? "Refresh recommendation"
                      : "Get AI recommendation"}
                </Button>
              </div>
              <SyntheticLabel />
              {aiStatus && (
                <p role="status" className="microcopy">
                  {aiStatus}
                </p>
              )}
              {recommendation && (
                <div className="recommendation-details">
                  <strong>
                    Recommended:{" "}
                    {
                      data.candidates.find(
                        (item) => item.id === recommendation.recommendedCandidateId,
                      )?.label
                    }
                  </strong>
                  <div className="comparison-grid">
                    {recommendation.comparisons.map((item) => (
                      <div key={item.candidateId}>
                        <h4>{data.candidates.find((c) => c.id === item.candidateId)?.label}</h4>
                        <p>
                          <b>Advantages</b>: {item.pros.join("; ") || "None stated"}
                        </p>
                        <p>
                          <b>Trade-offs</b>: {item.cons.join("; ") || "None stated"}
                        </p>
                      </div>
                    ))}
                  </div>
                  <p className="microcopy">
                    Model limitations: {recommendation.limitations.join(" · ")}
                  </p>
                </div>
              )}
              {candidate && (
                <section
                  className="proposal-review"
                  id="demo-proposal"
                  aria-labelledby="proposal-title"
                >
                  <SyntheticLabel />
                  <div>
                    <p className="eyebrow">REVIEW ONLY · NO TRANSACTION SUBMITTED</p>
                    <h3 id="proposal-title">Proposal details</h3>
                    <p>
                      Inspect the exact deterministic candidate before any future approval workflow.
                    </p>
                  </div>
                  <dl>
                    <div>
                      <dt>Position</dt>
                      <dd>
                        {data.position.positionId} · {data.position.accountId}
                      </dd>
                    </div>
                    <div>
                      <dt>Repayment</dt>
                      <dd>
                        {candidate.amount.toLocaleString()} {candidate.token}
                      </dd>
                    </div>
                    <div>
                      <dt>Token base units</dt>
                      <dd>{candidate.amountRaw} (6 decimals)</dd>
                    </div>
                    <div>
                      <dt>Remaining debt</dt>
                      <dd>{candidate.debtAfter.toLocaleString()} USDC (fixture estimate)</dd>
                    </div>
                    <div>
                      <dt>Projected health factor</dt>
                      <dd>{candidate.healthFactor.toFixed(2)} (illustrative)</dd>
                    </div>
                    <div>
                      <dt>Execution</dt>
                      <dd>Disabled · no transaction will be signed or submitted</dd>
                    </div>
                  </dl>
                </section>
              )}
            </CardBody>
          </Card>
          <p className="demo-footnote">
            Prices, balances, collateral factor, risk and candidates are synthetic. AI text is
            explanatory only. No wallet data enters demo mode, and no transaction is approved or
            executed.
          </p>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="demo-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function SyntheticLabel() {
  return <p className="synthetic-label">DEMO — SYNTHETIC DATA</p>;
}
