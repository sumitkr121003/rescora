import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NearRpcError } from "@/lib/near-rpc/client";
import { NearRpcProxyClient } from "@/lib/near-rpc/proxy-client";
import { BurrowPositionReadError } from "@/lib/burrow/positions";

const { readAccountData } = vi.hoisted(() => ({
  readAccountData: vi.fn(),
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
    },
    identityRef: {
      current:
        "connected:alice.testnet:ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa:unavailable",
    },
  }),
}));

vi.mock("@/lib/burrow/data-pipeline", () => ({
  BurrowDataPipeline: class {
    constructor(private readonly rpc: unknown) {}
    readAccountData(accountId: string) {
      return readAccountData(accountId, this.rpc);
    }
  },
}));

import { BurrowPositionsPanel } from "./burrow-positions-panel";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ fastNearConfigured: true })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Burrow live read failure boundary", () => {
  it("tests same-origin POST routing independently from a Burrow read", async () => {
    const requestId = "5354d2ec-0f83-4b91-8d89-1a6fc0f78c6b";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/burrow/read/status") {
        return Response.json({ fastNearConfigured: false });
      }
      expect(String(input)).toBe("/api/burrow/read/transport-check");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toBeUndefined();
      return Response.json(
        { requestId, serverTimestamp: "2026-11-12T00:00:00.000Z" },
        {
          headers: {
            "x-rescora-route-reached": "true",
            "x-rescora-rpc-attempted": "false",
          },
        },
      );
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<BurrowPositionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Test application POST" }));

    expect(await screen.findByText(requestId)).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(readAccountData).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.map(([input, init]) => [String(input), init?.method])).toEqual([
      ["/api/burrow/read/status", "GET"],
      ["/api/burrow/read/transport-check", "POST"],
    ]);
  });

  it("shows transport errors and diagnostics without fabricating position data", async () => {
    readAccountData.mockRejectedValueOnce(
      new NearRpcError("NETWORK_FAILURE", "NEAR Testnet RPC transport failed."),
    );
    render(<BurrowPositionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Read testnet Burrow data" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "NEAR Testnet RPC transport failed. No position data was loaded.",
    );
    expect(
      screen.queryByText(/DEMO MODE — SYNTHETIC DATA|demo\.borrower|2,000 NEAR|6,500 USDC/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText("RPC diagnostics")).toBeInTheDocument();
    expect(screen.getByText(/NETWORK_FAILURE/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Burrow data/ })).not.toBeInTheDocument();
  });

  it("renders provider attempts preserved through the Burrow and RPC error wrappers", async () => {
    readAccountData.mockRejectedValueOnce(
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

    fireEvent.click(await screen.findByRole("button", { name: "Read testnet Burrow data" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("transport failed");
    expect(screen.getByText(/"provider": "FastNear"/)).toBeInTheDocument();
    expect(screen.getByText(/"failureCategory": "dns"/)).toBeInTheDocument();
    expect(screen.getByText(/"authorizationAttached": true/)).toBeInTheDocument();
  });

  it("shows diagnostics from the actual POST read response in the panel", async () => {
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
    readAccountData.mockImplementationOnce(async (_accountId, rpc) => {
      return (rpc as NearRpcProxyClient).callFunction({
        contractAccountId: "burrow.services.ref-labs.testnet",
        methodName: "get_config",
      });
    });
    render(<BurrowPositionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Read testnet Burrow data" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("transport failed");
    expect(await screen.findByText("Live read request diagnostics")).toBeInTheDocument();
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
    readAccountData.mockRejectedValueOnce(new NearRpcError("NETWORK_FAILURE", "RPC offline"));
    render(<BurrowPositionsPanel />);
    // The mocked session is verification-unavailable; eligibility is likewise
    // intentionally independent of verification status for this public view.
    fireEvent.click(await screen.findByRole("button", { name: "Read testnet Burrow data" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("RPC offline");
    expect(readAccountData).toHaveBeenCalledWith("alice.testnet", expect.any(NearRpcProxyClient));
  });

  it("displays contract-returned collateral and debt as raw units only", async () => {
    readAccountData.mockResolvedValueOnce({
      accountId: "alice.testnet",
      block: { height: "123", hash: "block-hash" },
      positions: {
        accountId: "alice.testnet",
        positionStatus: "returned",
        positions: {
          REGULAR: {
            collateral: [{ tokenId: "wrap.testnet", balanceRaw: "1234500000000000000" }],
            borrowed: [{ tokenId: "usdc.testnet", balanceRaw: "2500000" }],
          },
        },
        supplied: [],
      },
      config: { status: "unavailable", reason: "unverified" },
      assets: { status: "unavailable", reason: "unverified" },
      tokenMetadata: {},
      pythMappings: { status: "unavailable", reason: "unverified" },
      pythPrices: { status: "unavailable", reason: "unverified" },
      assessmentEvidence: { status: "unavailable", reason: "unverified" },
    });
    render(<BurrowPositionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Read testnet Burrow data" }));
    expect(await screen.findByText("1234500000000000000")).toBeInTheDocument();
    expect(screen.getByText("2500000")).toBeInTheDocument();
    expect(
      screen.getByText(/no token decimal conversion, USD valuation or risk result/),
    ).toBeInTheDocument();
  });

  it("hides the live-read action when authenticated FastNear is not configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ fastNearConfigured: false })),
    );
    render(<BurrowPositionsPanel />);

    expect(
      await screen.findByText(/Set FASTNEAR_API_KEY in the server environment/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Burrow data/ })).not.toBeInTheDocument();
  });
});
