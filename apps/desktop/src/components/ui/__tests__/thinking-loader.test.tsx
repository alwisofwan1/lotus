import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThinkingLoader } from "../thinking-loader";

// motion caches the media query in a module singleton; control the hook directly.
let reduceMotion = false;
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reduceMotion,
}));

afterEach(() => {
  reduceMotion = false;
});

describe("ThinkingLoader", () => {
  it("announces the caller's label, not a scripted phase", () => {
    render(<ThinkingLoader label="Reading src/app.ts" />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Reading src\/app\.ts$/);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the detail out of the announcement", () => {
    render(<ThinkingLoader label="Thinking" detail="12s" />);
    expect(screen.getByText("12s")).toHaveAttribute("aria-hidden", "true");
  });

  it("replaces the label in place when it changes", () => {
    const { rerender } = render(<ThinkingLoader label="Thinking" />);
    rerender(<ThinkingLoader label="Searching useChat" />);
    expect(screen.getByText("Searching useChat")).toBeInTheDocument();
  });

  it("marks reduced motion so the skin stops the spinner and sweep", () => {
    reduceMotion = true;
    render(<ThinkingLoader label="Thinking" />);
    expect(screen.getByRole("status")).toHaveAttribute("data-motion", "reduced");
  });
});
