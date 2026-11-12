"use client";

import { useRef, useState } from "react";
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

const BURROW_READ_ROUTE = "/api/burrow/read";

export function canReadBurrowPositions(wallet: WalletState): boolean {
  return (
    wallet.status === "connected" &&
    wallet.account !== null &&
    (wallet.testnetVerificationStatus === "verified" ||
      wallet.testnetVerificationStatus === "unavailable")
  );
}

export function BurrowPositionsPanel() {
  const { state: wallet, identityRef } = useWalletSession();
  const [readState, setReadState] = useState<ReadState>({ status: "idle" });
  const operation = useRef(0);
  const walletIdentity =
    wallet.status === "connected" && wallet.account
      ? `${wallet.status}:${wallet.account.accountId}:${wallet.account.publicKey}:${wallet.testnetVerificationStatus}`
      : wallet.status;
  const connectedAccount = wallet.status === "connected" ? wallet.account : null;
  const readableWallet = canReadBurrowPositions(wallet);

  async function loadPositions() {
    if (!readableWallet || !connectedAccount) return;
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
            : "Not loaded"}
        </Badge>
      </CardHeader>
      <CardBody>
        {!readableWallet && (
          <p role="status">
            Connect a wallet with a valid account before requesting Testnet position data. When
            Testnet identity verification is rejected or pending, position reads remain disabled. No
            account information is cached across wallet changes.
          </p>
        )}
        {readableWallet &&
          !read &&
          visibleState.status !== "error" &&
          visibleState.status !== "unavailable" && (
            <p role="status">
              {wallet.testnetVerificationStatus === "unavailable"
                ? "Testnet identity verification is unavailable. A read-only query can still use the connected account against fixed NEAR Testnet RPC; returned fields remain unverified."
                : "Position reads use the active wallet account and NEAR Testnet RPC. Returned fields remain unverified until the deployed Burrow code and completeness behavior are confirmed."}
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
            {process.env.NODE_ENV !== "production" && (
              <details>
                <summary>Developer RPC diagnostics</summary>
                <pre className="position-read-raw">{visibleState.diagnostic}</pre>
              </details>
            )}
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
              oracle source authenticity remain unverified. No balances or risk results are shown.
            </p>
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
        <Button
          onClick={loadPositions}
          disabled={!readableWallet || visibleState.status === "loading"}
        >
          {visibleState.status === "loading" ? "Loading Burrow data…" : "Read testnet Burrow data"}
        </Button>
        <p className="microcopy">
          This action makes read-only testnet RPC calls. It cannot sign, submit transactions, or
          authorize repayment.
        </p>
      </CardBody>
    </Card>
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
