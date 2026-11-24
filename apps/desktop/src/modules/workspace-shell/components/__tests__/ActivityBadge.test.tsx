import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { ActivityBadge } from "@/modules/workspace-shell/components/ActivityBadge";

afterEach(() => {
  vi.useRealTimers();
});

function badge(): HTMLElement {
  // The badge is the element carrying the state; the dot inside it is decoration.
  const found = document.querySelector(".ws-activity");
  if (!found) throw new Error("no activity badge rendered");
  return found as HTMLElement;
}

describe("the activity badge", () => {
  it("says what it is, in words, not only in colour", () => {
    render(<ActivityBadge activity="working" />);
    expect(screen.getByText("working")).toBeInTheDocument();
  });

  it("marks work in progress for animation", () => {
    render(<ActivityBadge activity="working" />);
    expect(badge()).toHaveAttribute("data-animate", "true");
    expect(badge()).toHaveAttribute("data-tone", "live");
  });

  it("never marks an ask for animation", () => {
    // The invariant, at the last place it could be broken: a pulsing "answer me" reads as
    // progress. CSS keys the animation off this attribute and nothing else.
    render(<ActivityBadge activity="needs-you" />);
    expect(badge()).not.toHaveAttribute("data-animate");
    expect(badge()).toHaveAttribute("data-tone", "ask");
  });

  it("prints how long a state has held, once there is a whole minute of it", () => {
    const now = Date.now();
    const { rerender } = render(<ActivityBadge activity="needs-you" since={now - 30_000} />);
    // Under a minute the number would only pull the eye to a pane that just started.
    expect(screen.getByText("needs you")).toBeInTheDocument();

    rerender(<ActivityBadge activity="needs-you" since={now - 12 * 60_000} />);
    expect(screen.getByText("needs you · 12m")).toBeInTheDocument();
  });

  it("keeps no age on a state where the number means nothing", () => {
    render(<ActivityBadge activity="idle" since={Date.now() - 40 * 60_000} />);
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("keeps the words for a screen reader when it is drawn as a dot", () => {
    render(<ActivityBadge activity="needs-you" compact />);
    expect(badge()).toHaveAttribute("data-compact", "true");
    // Compact spends no pixels on the label; it must still be readable by anything that is not
    // looking at hues.
    expect(screen.getByText("needs you")).toHaveClass("sr-only");
    expect(badge()).toHaveAttribute("title", "needs you");
  });

  it("runs no timer for a pane whose state has no age to print", () => {
    // A workspace of sixteen resting panes must not hold sixteen intervals.
    vi.useFakeTimers();
    const interval = vi.spyOn(globalThis, "setInterval");
    render(<ActivityBadge activity="idle" since={Date.now()} />);
    expect(interval).not.toHaveBeenCalled();

    render(<ActivityBadge activity="working" since={Date.now()} />);
    expect(interval).toHaveBeenCalled();
  });
});
