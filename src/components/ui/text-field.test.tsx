import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextField } from "./text-field";

describe("TextField", () => {
  it("associates the label and hint with the input", () => {
    render(<TextField id="limit" label="Limit" hint="USD equivalent" />);

    expect(screen.getByLabelText("Limit")).toHaveAttribute("aria-describedby", "limit-hint");
    expect(screen.getByText("USD equivalent")).toBeInTheDocument();
  });

  it("exposes an error accessibly", () => {
    render(<TextField id="limit" label="Limit" error="Enter a valid limit." />);

    expect(screen.getByLabelText("Limit")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid limit.");
  });
});
