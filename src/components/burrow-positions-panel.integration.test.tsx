import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NearRpcError } from "@/lib/near-rpc/client";

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
    readAccountData = readAccountData;
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

  it("allows a wallet-reported account with unavailable verification to make a public read", async () => {
    readAccountData.mockRejectedValueOnce(new NearRpcError("NETWORK_FAILURE", "RPC offline"));
    render(<BurrowPositionsPanel />);
    // The mocked session is verification-unavailable; eligibility is likewise
    // intentionally independent of verification status for this public view.
    fireEvent.click(await screen.findByRole("button", { name: "Read testnet Burrow data" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("RPC offline");
    expect(readAccountData).toHaveBeenCalledWith("alice.testnet");
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
