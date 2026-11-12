import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NearRpcError } from "@/lib/near-rpc/client";
import { NearRpcProxyClient } from "@/lib/near-rpc/proxy-client";
import { BurrowPositionReadError } from "@/lib/burrow/positions";

const { readAccountPositions, sessionIdentity } = vi.hoisted(() => ({
  readAccountPositions: vi.fn(),
  sessionIdentity: { revision: 0 },
}));

vi.mock("@/components/wallet-session-provider", () => ({
  useWalletSession: () => ({
    state: {
      status: "connected",
      account: {
        accountId: "alice.testnet",
        publicKey: "ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa",
      },
      testnetVerificationStatus: "unavailable",
      identityRevision: sessionIdentity.revision,
    },
    identityRef: {
      current: `connected:alice.testnet:ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa:${sessionIdentity.revision}`,
    },
  }),
}));

vi.mock("@/lib/burrow/positions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/burrow/positions")>();
  return {
    ...actual,
    BurrowPositionReader: class {
      constructor(private readonly rpc: unknown) {}
      readAccountPositions(accountId: string) {
        return readAccountPositions(accountId, this.rpc);
      }
    },
  };
});

import { BurrowPositionsPanel } from "./burrow-positions-panel";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ fastNearConfigured: true })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Burrow live read failure boundary", () => {
  it("ends the capability check as unavailable when the status route times out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    render(<BurrowPositionsPanel />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByText(/Live position lookup is unavailable right now/)).toBeInTheDocument();
    expect(screen.queryByText(/Checking your Burrow position/)).not.toBeInTheDocument();
  });

  it("aborts and clears an in-flight read when wallet identity changes", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "GET") return Response.json({ fastNearConfigured: true });
        requestSignal = init?.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }),
    );
    readAccountPositions.mockImplementationOnce(async (_accountId, rpc) => {
      return (rpc as NearRpcProxyClient).callFunction({
        contractAccountId: "burrow.services.ref-labs.testnet",
        methodName: "get_account_all_positions",
        args: { account_id: "alice.testnet" },
      });
    });
    const view = render(<BurrowPositionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "View position" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Checking your Burrow position");

    sessionIdentity.revision += 1;
    view.rerender(<BurrowPositionsPanel />);

    expect(await screen.findByRole("button", { name: "View position" })).toBeInTheDocument();
    expect(requestSignal?.aborted).toBe(true);
    expect(screen.queryByText(/We couldn't load Burrow position data/)).not.toBeInTheDocument();
  });

  it("shows the concise empty-position message and allows retry", async () => {
    readAccountPositions.mockResolvedValueOnce({
      accountId: "alice.testnet",
      positionStatus: "no-record",
      positions: {},
      supplied: [],
      responseDiagnostics: {
        jsonRpcResponseReceived: true,
        jsonRpcErrorPresent: false,
        resultFieldPresent: true,
        resultType: "null",
        resultSummary: { rootObject: false },
        burrowResponseValidation: "passed",
        normalization: "passed",
        failureStage: null,
      },
    });
    render(<BurrowPositionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "View position" }));

    expect(
      await screen.findByText(
        "We couldn't retrieve a Burrow position for this account. This doesn't necessarily mean you have no positions. No transaction was submitted.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText(/transaction (succeeded|completed)/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/health factor|liquidation risk|recommended repayment/i),
    ).not.toBeInTheDocument();
  });

  it("shows safe Burrow shape-validation diagnostics when the provider response cannot normalize", async () => {
    vi.stubEnv("NODE_ENV", "development");
    readAccountPositions.mockRejectedValueOnce(
      new BurrowPositionReadError(
        "INVALID_RESPONSE",
        "Burrow position response is malformed.",
        undefined,
        {
          jsonRpcResponseReceived: true,
          jsonRpcErrorPresent: false,
          resultFieldPresent: true,
          resultType: "object",
          resultSummary: {
            rootObject: true,
            accountIdFieldPresent: false,
            positionsFieldPresent: true,
            positionsType: "object",
            positionCount: 1,
            suppliedFieldPresent: true,
            suppliedType: "array",
            suppliedRowCount: 0,
            collateralRowCount: 0,
            borrowedRowCount: 0,
          },
          burrowResponseValidation: "failed",
          normalization: "not-run",
          failureStage: "collateral-row-validation",
        },
      ),
    );
    render(<BurrowPositionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "View position" }));

    expect(await screen.findByText(/We couldn't load Burrow position data/)).toBeInTheDocument();
    expect(screen.getByText(/burrowResponseDiagnostics/)).toBeInTheDocument();
    expect(screen.getByText(/collateral-row-validation/)).toBeInTheDocument();
    expect(screen.queryByText(/rawResponse/)).not.toBeInTheDocument();
  });

  it("does not show the transport probe in the user interface", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/burrow/read/status");
      expect(init?.method).toBe("GET");
      return Response.json({ fastNearConfigured: true });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<BurrowPositionsPanel />);

    expect(screen.queryByRole("button", { name: "Test application POST" })).not.toBeInTheDocument();
    expect(readAccountPositions).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/burrow/read/status");
  });

  it("hides technical diagnostics in production and offers retry after failure", async () => {
    vi.stubEnv("NODE_ENV", "production");
    readAccountPositions
      .mockRejectedValueOnce(
        new NearRpcError("NETWORK_FAILURE", "NEAR Testnet RPC transport failed."),
      )
      .mockResolvedValueOnce({
        accountId: "alice.testnet",
        positionStatus: "returned",
        positions: {},
        supplied: [],
      });
    render(<BurrowPositionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "View position" }));

    expect(
      await screen.findByText(
        "We couldn't load Burrow position data. Please try again. No transaction was submitted.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/DEMO — SYNTHETIC DATA|demo\.borrower|2,000 NEAR|6,500 USDC/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/RPC diagnostics|NETWORK_FAILURE|requestDurationMs|provider/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText(/2,000 NEAR|6,500 USDC|health factor/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("Position data is loaded, but no position rows were returned."),
    ).toBeInTheDocument();
    expect(readAccountPositions).toHaveBeenCalledTimes(2);
  });

  it("renders provider attempts preserved through the Burrow and RPC error wrappers", async () => {
    vi.stubEnv("NODE_ENV", "development");
    readAccountPositions.mockRejectedValueOnce(
      new BurrowPositionReadError(
        "RPC_FAILURE",
        "Burrow Testnet RPC transport failed on all approved endpoints.",
        new NearRpcError("NETWORK_FAILURE", "Burrow Testnet RPC transport failed.", {
          failureKind: "transport",
          attempts: [
            {
              endpoint: "rpc.testnet.fastnear.com",
              provider: "FastNear",
              apiKeyConfigured: true,
              authorizationAttached: true,
              requestDurationMs: 12,
              failureCategory: "dns",
              nearRpcErrorCode: "NETWORK_FAILURE",
              nearRpcErrorMessage: "NEAR testnet RPC transport failed.",
            },
          ],
        }),
      ),
    );
    render(<BurrowPositionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "View position" }));

    expect(await screen.findByText(/We couldn't load Burrow position data/)).toBeInTheDocument();
    expect(screen.getByText(/"provider": "FastNear"/)).toBeInTheDocument();
    expect(screen.getByText(/"failureCategory": "dns"/)).toBeInTheDocument();
    expect(screen.getByText(/"authorizationAttached": true/)).toBeInTheDocument();
  });

  it("shows diagnostics from the actual POST read response in the panel", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const requestId = "5354d2ec-0f83-4b91-8d89-1a6fc0f78c6b";
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json({ fastNearConfigured: true });
      return Response.json(
        {
          errorCode: "NETWORK_FAILURE",
          failureKind: "transport",
          attempts: [
            {
              provider: "FastNear",
              endpoint: "rpc.testnet.fastnear.com",
              apiKeyConfigured: true,
              authorizationAttached: true,
              requestDurationMs: 24,
              failureCategory: "timeout",
            },
          ],
        },
        {
          status: 502,
          headers: {
            "x-rescora-route-reached": "true",
            "x-rescora-rpc-attempted": "true",
            "x-rescora-request-id": requestId,
          },
        },
      );
    });
    vi.stubGlobal("fetch", fetchImpl);
    readAccountPositions.mockImplementationOnce(async (_accountId, rpc) => {
      return (rpc as NearRpcProxyClient).callFunction({
        contractAccountId: "burrow.services.ref-labs.testnet",
        methodName: "get_config",
      });
    });
    render(<BurrowPositionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "View position" }));

    expect(await screen.findByText(/We couldn't load Burrow position data/)).toBeInTheDocument();
    expect(await screen.findByText("Live request diagnostics")).toBeInTheDocument();
    expect(screen.getAllByText(/"httpMethod": "POST"/)).not.toHaveLength(0);
    expect(screen.getAllByText(/"httpStatus": 502/)).not.toHaveLength(0);
    expect(screen.getAllByText(/"routeReached": true/)).not.toHaveLength(0);
    expect(screen.getAllByText(/"externalRpcRequestAttempted": true/)).not.toHaveLength(0);
    expect(screen.getAllByText(new RegExp(requestId))).not.toHaveLength(0);
    expect(screen.getAllByText(/"provider": "FastNear"/)).not.toHaveLength(0);
    expect(fetchImpl.mock.calls.map(([input, init]) => [String(input), init?.method])).toEqual([
      ["/api/burrow/read/status", "GET"],
      ["/api/burrow/read", "POST"],
    ]);
  });

  it("allows a wallet-reported account with unavailable verification to make a public read", async () => {
    readAccountPositions.mockRejectedValueOnce(new NearRpcError("NETWORK_FAILURE", "RPC offline"));
    render(<BurrowPositionsPanel />);
    // The mocked session is verification-unavailable; eligibility is likewise
    // intentionally independent of verification status for this public view.
    fireEvent.click(await screen.findByRole("button", { name: "View position" }));
    expect(await screen.findByText(/We couldn't load Burrow position data/)).toBeInTheDocument();
    expect(readAccountPositions).toHaveBeenCalledWith(
      "alice.testnet",
      expect.any(NearRpcProxyClient),
    );
  });

  it("displays contract-returned collateral and debt as raw units only", async () => {
    readAccountPositions.mockResolvedValueOnce({
      accountId: "alice.testnet",
      positionStatus: "returned",
      positions: {
        REGULAR: {
          collateral: [{ tokenId: "wrap.testnet", balanceRaw: "1234500000000000000" }],
          borrowed: [{ tokenId: "usdc.testnet", balanceRaw: "2500000" }],
        },
      },
      supplied: [],
    });
    render(<BurrowPositionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "View position" }));
    expect(await screen.findByText("1234500000000000000")).toBeInTheDocument();
    expect(screen.getByText("2500000")).toBeInTheDocument();
    expect(
      screen.getByText(/raw contract units\. No live risk assessment is available/),
    ).toBeInTheDocument();
  });

  it("hides the live-read action when authenticated FastNear is not configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ fastNearConfigured: false })),
    );
    render(<BurrowPositionsPanel />);

    expect(
      await screen.findByText(/Live position lookup is unavailable right now/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Burrow data/ })).not.toBeInTheDocument();
  });
});
