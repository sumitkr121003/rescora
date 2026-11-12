"use client";

import { useEffect, useRef, useState } from "react";
import {
  BurrowDataPipeline,
  type BurrowDataPipelineResult,
  type ReadView,
} from "@/lib/burrow/data-pipeline";
import { BURROW_TESTNET_ACCOUNT, BurrowPositionReadError } from "@/lib/burrow/positions";
import { NearRpcError } from "@/lib/near-rpc/client";
import { NearRpcProxyClient } from "@/lib/near-rpc/proxy-client";
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

const BURROW_READ_ROUTE = "/api/burrow/read";

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
  const operation = useRef(0);
  useEffect(() => {
    let active = true;
    void fetch(BURROW_READ_ROUTE, { method: "GET", cache: "no-store" })
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
    if (!readableWallet || !connectedAccount || fastNearAvailability !== "ready") return;
    const requestId = ++operation.current;
    const identity = walletIdentity;
    setReadState({ status: "loading", identity });
    try {
      const rpc = new NearRpcProxyClient();
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
          error instanceof Error
            ? error.message
            : "NEAR testnet position data could not be retrieved.",
        diagnostic: JSON.stringify(
          {
            accountId: connectedAccount.accountId,
            route: BURROW_READ_ROUTE,
            contractAccountId: BURROW_TESTNET_ACCOUNT,
            methodName: "get_account_all_positions",
            requestArguments: { account_id: connectedAccount.accountId },
            retryCount: 0,
            error: describeReadError(error),
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
  const unavailableStages = read ? collectUnavailableStages(read) : [];
  return (
    <Card className="position-read-card">
      <CardHeader>
        <div>
          <p className="eyebrow">TESTNET READ-ONLY</p>
          <h2>Burrow position data</h2>
        </div>
        <Badge tone={read ? "info" : "neutral"}>
          {read
            ? read.status === "complete-unverified"
              ? "Views returned · unverified"
              : "Read incomplete"
            : fastNearAvailability === "unavailable" || fastNearAvailability === "failed"
              ? "Live unavailable"
              : fastNearAvailability === "checking"
                ? "Checking provider"
                : "Not loaded"}
        </Badge>
      </CardHeader>
      <CardBody>
        {!readableWallet && (
          <p role="status">
            Connect a wallet with a valid account before requesting Testnet position data. The
            account ID is wallet-reported; failed or pending identity verification does not prevent
            this public read-only query and is not treated as verified. No account information is
            cached across wallet changes.
          </p>
        )}
        {fastNearAvailability === "checking" && (
          <p role="status">Checking authenticated FastNear Testnet RPC availability…</p>
        )}
        {fastNearAvailability === "unavailable" && (
          <p role="status">
            Live position lookup is unavailable because authenticated FastNear Testnet RPC is not
            configured or its configuration could not be checked. Set FASTNEAR_API_KEY in the server
            environment. Synthetic demo data is not used here.
          </p>
        )}
        {fastNearAvailability === "failed" && (
          <p role="status">
            Authenticated FastNear and configured RPC failover could not retrieve this live view.
            The live-read action is disabled; no synthetic data was substituted.
          </p>
        )}
        {readableWallet &&
          !read &&
          visibleState.status !== "error" &&
          visibleState.status !== "unavailable" && (
            <p role="status">
              {wallet.testnetVerificationStatus === "verified"
                ? "The wallet account's access key was independently found on NEAR Testnet. Burrow view results and their completeness, units, and deployment equivalence remain unverified."
                : `The account ID is reported by the connected wallet; independent Testnet identity verification is ${wallet.testnetVerificationStatus}. The public read-only query may still proceed, but this account is not labeled verified. Burrow result completeness, units, and deployment equivalence remain unverified.`}
            </p>
          )}
        {visibleState.status === "loading" && (
          <p role="status">Reading Burrow positions from testnet…</p>
        )}
        {visibleState.status === "unavailable" && <p role="status">{visibleState.message}</p>}
        {visibleState.status === "error" && (
          <div>
            <p className="position-read-error" role="alert">
              {visibleState.message} No position data was loaded.
            </p>
            <details>
              <summary>RPC diagnostics</summary>
              <pre className="position-read-raw">{visibleState.diagnostic}</pre>
            </details>
          </div>
        )}
        {read && (
          <div className="position-read-result">
            <p role="status">
              {read.positions.positionStatus === "no-record" ? (
                <>
                  Burrow returned no account-position record for <strong>{read.accountId}</strong>.
                  No position rows were fabricated, and this does not prove the account has no
                  position.
                </>
              ) : (
                <>
                  The source-declared view returned {Object.keys(read.positions.positions).length}{" "}
                  position rows for <strong>{read.accountId}</strong>.
                </>
              )}{" "}
              Assessment evidence remains unavailable.
            </p>
            <p className="microcopy">
              Block {read.block.height} · {read.block.hash}
            </p>
            <p className="microcopy">
              Position completeness, asset-list coverage, deployment equivalence, token units and
              oracle source authenticity remain unverified. Balances below are the raw values
              returned by the contract; no token decimal conversion, USD valuation or risk result is
              inferred.
            </p>
            {Object.entries(read.positions.positions).map(([positionId, position]) => (
              <section key={positionId} aria-label={`Position ${positionId}`}>
                <h3>Position {positionId}</h3>
                <PositionRows label="Collateral" rows={position.collateral} />
                <PositionRows label="Debt" rows={position.borrowed} />
              </section>
            ))}
            {read.positions.positions && Object.keys(read.positions.positions).length === 0 && (
              <p>No position rows were returned by this view.</p>
            )}
            {unavailableStages.length > 0 && (
              <ul className="position-read-unavailable" aria-label="Unavailable data views">
                {unavailableStages.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            <details>
              <summary>Show raw decoded view responses (unverified)</summary>
              <pre className="position-read-raw">{JSON.stringify(read, null, 2)}</pre>
            </details>
            {process.env.NODE_ENV !== "production" && (
              <details>
                <summary>Developer block and RPC provenance</summary>
                <pre className="position-read-raw">
                  {JSON.stringify(
                    {
                      accountId: read.accountId,
                      positionView: read.positions.provenance,
                      config: read.config,
                      assets: read.assets,
                      tokenMetadata: read.tokenMetadata,
                      pythMappings: read.pythMappings,
                      pythPrices: read.pythPrices,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            )}
          </div>
        )}
        {fastNearAvailability === "ready" && visibleState.status !== "error" && (
          <>
            <Button
              onClick={loadPositions}
              disabled={!readableWallet || visibleState.status === "loading"}
            >
              {visibleState.status === "loading"
                ? "Loading Burrow data…"
                : read
                  ? "Refresh testnet Burrow data"
                  : "Read testnet Burrow data"}
            </Button>
            <p className="microcopy">
              This action makes read-only testnet RPC calls. It cannot sign, submit transactions, or
              authorize repayment.
            </p>
          </>
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

function collectUnavailableStages(read: BurrowDataPipelineResult): string[] {
  const stages: ReadView<unknown>[] = [
    read.config,
    read.assets,
    read.pythMappings,
    read.pythPrices,
  ];
  const reasons = stages.flatMap((stage) => (stage.status === "unavailable" ? [stage.reason] : []));
  for (const [tokenId, stage] of Object.entries(read.tokenMetadata)) {
    if (stage.status === "unavailable") reasons.push(`${tokenId}: ${stage.reason}`);
  }
  if (Object.keys(read.positions.positions).length === 0) {
    reasons.push(
      read.positions.positionStatus === "no-record"
        ? "Burrow returned null and no account-position record; this does not prove the account has no position."
        : "No position rows were returned; this does not prove the account has no position.",
    );
  }
  return reasons;
}
