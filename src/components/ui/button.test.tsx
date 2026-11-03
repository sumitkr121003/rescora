import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("renders a button with a safe non-submit default type", () => {
    render(<Button>Continue</Button>);

    expect(screen.getByRole("button", { name: "Continue" })).toHaveAttribute("type", "button");
  });

  it("preserves the disabled state", () => {
    render(<Button disabled>Unavailable</Button>);

    expect(screen.getByRole("button", { name: "Unavailable" })).toBeDisabled();
  });
});
