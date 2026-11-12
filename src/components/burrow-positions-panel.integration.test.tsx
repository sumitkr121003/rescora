import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

describe("Burrow live read failure boundary", () => {
  it("shows transport errors and diagnostics without fabricating position data", async () => {
    readAccountData.mockRejectedValueOnce(
      new NearRpcError("NETWORK_FAILURE", "NEAR Testnet RPC transport failed."),
    );
    render(<BurrowPositionsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Read testnet Burrow data" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "NEAR Testnet RPC transport failed. No position data was loaded.",
    );
    expect(screen.queryByText(/demo|synthetic|collateral|borrowed/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Developer RPC diagnostics/)).toBeInTheDocument();
    expect(screen.getByText(/NETWORK_FAILURE/)).toBeInTheDocument();
  });
});
