import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoExperience } from "./demo-experience";

vi.mock("@/components/burrow-positions-panel", () => ({
  BurrowPositionsPanel: () => <div>Live Burrow read panel</div>,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("demo experience", () => {
  it("loads synthetic positions without requiring a wallet connection", () => {
    render(<DemoExperience />);

    expect(screen.getByRole("button", { name: "Explore Demo" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("2,000 NEAR")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Compare repayment strategies" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("DEMO MODE — SYNTHETIC DATA").length).toBeGreaterThan(1);
    expect(screen.getByText(/does not belong to your connected wallet/i)).toBeInTheDocument();
  });

  it("clears synthetic position details when switching to live and restores demo explicitly", () => {
    render(<DemoExperience />);
    fireEvent.click(screen.getByRole("button", { name: "Live connection" }));
    expect(screen.getByText("Live assessment unavailable")).toBeInTheDocument();
    expect(screen.queryByText("2,000 NEAR")).not.toBeInTheDocument();
    expect(screen.queryByText("DEMO MODE — SYNTHETIC DATA")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Explore Demo" }));
    expect(screen.getByText("2,000 NEAR")).toBeInTheDocument();
  });

  it("keeps proposal review explicitly unsigned and unsubmitted", () => {
    render(<DemoExperience />);
    fireEvent.click(screen.getByRole("button", { name: /Lower-cost relief/ }));

    expect(screen.getByText("REVIEW ONLY · NO TRANSACTION SUBMITTED")).toBeInTheDocument();
    expect(screen.getByText(/no transaction will be signed or submitted/i)).toBeInTheDocument();
    expect(screen.queryByText(/transaction hash/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/repayment succeeded/i)).not.toBeInTheDocument();
  });

  it("shows a deterministic recommendation when Groq is not configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "AI_NOT_CONFIGURED",
              error: "AI setup required: configure GROQ_API_KEY on the server, then retry.",
            }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    render(<DemoExperience />);

    fireEvent.click(screen.getByRole("button", { name: "Get AI recommendation" }));
    expect(await screen.findByRole("status")).toHaveTextContent("deterministic fallback");
    expect(screen.getByText(/Recommended:/)).toBeInTheDocument();
    expect(screen.queryByText("Asking the model…")).not.toBeInTheDocument();
  });

  it("uses the deterministic fallback at the client deadline", async () => {
    vi.useFakeTimers();
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => (fetchStarted = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        fetchStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }),
    );
    render(<DemoExperience />);

    fireEvent.click(screen.getByRole("button", { name: "Get AI recommendation" }));
    await started;
    expect(screen.getByRole("button", { name: "Asking the model…" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_001);
    });

    expect(screen.getByRole("status")).toHaveTextContent("timed out");
    expect(screen.getByText(/Recommended:/)).toBeInTheDocument();
    expect(screen.queryByText("Asking the model…")).not.toBeInTheDocument();
  });
});
