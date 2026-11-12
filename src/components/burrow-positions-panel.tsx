"use client";

import { useEffect, useRef, useState } from "react";
import { BurrowDataPipeline, type BurrowDataPipelineResult } from "@/lib/burrow/data-pipeline";
import { BurrowPositionReadError } from "@/lib/burrow/positions";
import { NearRpcError } from "@/lib/near-rpc/client";
import { NearRpcProxyClient, type BurrowRequestDiagnostic } from "@/lib/near-rpc/proxy-client";
import { useWalletSession } from "@/components/wallet-session-provider";
import type { WalletState } from "@/lib/wallet/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

type ReadState =
  | { status: "idle" }
  | { status: "loading"; identity: string }
  | { status: "loaded"; read: BurrowDataPipelineResult; identity: string }
  | { status: "unavailable"; message: string; identity: string }
  | { status: "error"; message: string; identity: string; diagnostic: string };
type FastNearAvailability = "checking" | "ready" | "unavailable" | "failed";

const BURROW_STATUS_ROUTE = "/api/burrow/read/status";

export function canReadBurrowPositions(wallet: WalletState): boolean {
  // Burrow's view call is public. A wallet-reported, syntactically valid
  // account can be queried even when independent key verification is pending
  // or unavailable; this does not upgrade the identity's verification state.
  return wallet.status === "connected" && wallet.account !== null;
}

export function BurrowPositionsPanel() {
  const { state: wallet, identityRef } = useWalletSession();
  const [readState, setReadState] = useState<ReadState>({ status: "idle" });
  const [fastNearAvailability, setFastNearAvailability] =
    useState<FastNearAvailability>("checking");
  const [requestDiagnostics, setRequestDiagnostics] = useState<readonly BurrowRequestDiagnostic[]>(
    [],
  );
  const operation = useRef(0);
  useEffect(() => {
    let active = true;
    void fetch(BURROW_STATUS_ROUTE, { method: "GET", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return false;
        const body: unknown = await response.json().catch(() => null);
        return (
          typeof body === "object" &&
          body !== null &&
          !Array.isArray(body) &&
          (body as Record<string, unknown>).fastNearConfigured === true
        );
      })
      .then((configured) => {
        if (active) setFastNearAvailability(configured ? "ready" : "unavailable");
      })
      .catch(() => {
        if (active) setFastNearAvailability("unavailable");
      });
    return () => {
      active = false;
    };
  }, []);
  const walletIdentity =
    wallet.status === "connected" && wallet.account
      ? `${wallet.status}:${wallet.account.accountId}:${wallet.account.publicKey}:${wallet.testnetVerificationStatus}`
      : wallet.status;
  const connectedAccount = wallet.status === "connected" ? wallet.account : null;
  const readableWallet = canReadBurrowPositions(wallet);

  async function loadPositions() {
    if (
      !readableWallet ||
      !connectedAccount ||
      (fastNearAvailability !== "ready" && fastNearAvailability !== "failed")
    )
      return;
    const requestId = ++operation.current;
    const identity = walletIdentity;
    const requestHistory: BurrowRequestDiagnostic[] = [];
    setRequestDiagnostics([]);
    setReadState({ status: "loading", identity });
    try {
      const rpc = new NearRpcProxyClient(globalThis.fetch, 18_000, (diagnostic) => {
        requestHistory.push(diagnostic);
        setRequestDiagnostics([...requestHistory]);
      });
      const read = await new BurrowDataPipeline(rpc).readAccountData(connectedAccount.accountId);
      if (operation.current !== requestId || identityRef.current !== identity) return;
      setReadState({ status: "loaded", read, identity });
    } catch (error) {
      if (operation.current !== requestId || identityRef.current !== identity) return;
      setFastNearAvailability("failed");
      setReadState({
        status: "error",
        identity,
        message:
          "We couldn't load Burrow position data. Please try again. No transaction was submitted.",
        diagnostic: JSON.stringify(
          {
            error: describeReadError(error),
            requests: requestHistory,
            observedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      });
    }
  }

  const visibleState: ReadState =
    readState.status !== "idle" && readState.identity !== walletIdentity
      ? { status: "idle" }
      : readState;
  const read = visibleState.status === "loaded" ? visibleState.read : null;
  const positionAvailable = read?.positions.positionStatus === "returned";
  const showDeveloperDiagnostics = process.env.NODE_ENV === "development";
  return (
    <Card className="position-read-card">
      <CardHeader>
        <div>
          <p className="eyebrow">NEAR TESTNET</p>
          <h2>Burrow position</h2>
        </div>
        <Badge tone={positionAvailable ? "info" : "neutral"}>
          Position: {positionAvailable ? "Loaded" : "Not available"}
        </Badge>
      </CardHeader>
      <CardBody>
        <dl className="position-summary">
          <div>
            <dt>Account</dt>
            <dd>{connectedAccount?.accountId ?? "Connect wallet to view account"}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>NEAR Testnet</dd>
          </div>
        </dl>
        {visibleState.status === "loading" && (
          <p role="status" className="position-read-message">
            Checking your Burrow position…
          </p>
        )}
        {fastNearAvailability === "unavailable" && (
          <p role="status" className="position-read-message">
            Live position lookup is unavailable right now. You can explore the synthetic demo.
          </p>
        )}
        {(visibleState.status === "error" || visibleState.status === "unavailable") && (
          <p role="status" className="position-read-message">
            {visibleState.status === "error"
              ? "We couldn't load Burrow position data. Please try again. No transaction was submitted."
              : visibleState.message}
          </p>
        )}
        {read && (
          <div className="position-read-result">
            {read.positions.positionStatus === "no-record" ? (
              <p role="status" className="position-read-message">
                We couldn&apos;t retrieve a Burrow position for this account. This doesn&apos;t
                necessarily mean you have no positions. No transaction was submitted.
              </p>
            ) : (
              <div className="position-read-values">
                {Object.entries(read.positions.positions).map(([positionId, position]) => (
                  <section key={positionId} aria-label={`Position ${positionId}`}>
                    <h3>Position</h3>
                    <PositionRows label="Collateral" rows={position.collateral} />
                    <PositionRows label="Debt" rows={position.borrowed} />
                  </section>
                ))}
                {Object.keys(read.positions.positions).length === 0 && (
                  <p role="status">Position data is loaded, but no position rows were returned.</p>
                )}
                <p className="microcopy">
                  Amounts are shown in raw contract units. No live risk assessment is available.
                </p>
              </div>
            )}
            {showDeveloperDiagnostics && (
              <details>
                <summary>Developer diagnostics</summary>
                <pre className="position-read-raw">
                  {JSON.stringify(
                    {
                      response: read.positions.responseDiagnostics,
                      requests: requestDiagnostics,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            )}
          </div>
        )}
        {readableWallet &&
          (fastNearAvailability === "ready" || fastNearAvailability === "failed") && (
            <>
              <Button
                onClick={loadPositions}
                disabled={!readableWallet || visibleState.status === "loading"}
              >
                {visibleState.status === "loading"
                  ? "Checking position…"
                  : read?.positions.positionStatus === "no-record" ||
                      visibleState.status === "error"
                    ? "Retry"
                    : read
                      ? "Refresh"
                      : "View position"}
              </Button>
              {showDeveloperDiagnostics && visibleState.status === "error" && (
                <details className="developer-diagnostics">
                  <summary>Developer diagnostics</summary>
                  <pre className="position-read-raw">{visibleState.diagnostic}</pre>
                </details>
              )}
            </>
          )}
        {showDeveloperDiagnostics && requestDiagnostics.length > 0 && !read && (
          <details className="developer-diagnostics">
            <summary>Live request diagnostics</summary>
            <pre className="position-read-raw">{JSON.stringify(requestDiagnostics, null, 2)}</pre>
          </details>
        )}
      </CardBody>
    </Card>
  );
}

function PositionRows({
  label,
  rows,
}: {
  label: string;
  rows: BurrowDataPipelineResult["positions"]["supplied"];
}) {
  return (
    <div>
      <h4>{label} (raw contract units)</h4>
      {rows.length === 0 ? (
        <p className="microcopy">No {label.toLowerCase()} rows returned.</p>
      ) : (
        <ul>
          {rows.map((row, index) => (
            <li key={`${row.tokenId}:${index}`}>
              <code>{row.tokenId}</code>: <code>{row.balanceRaw}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describeReadError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof BurrowPositionReadError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      ...(error.diagnostics ? { burrowResponseDiagnostics: error.diagnostics } : {}),
      cause: describeReadError(error.cause),
    };
  }
  if (error instanceof NearRpcError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      details: error.details ?? null,
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}
