import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AgentCompletionToasts } from "../AgentCompletionToasts";
import {
  buildCompletionToast,
  selectToastStackView,
  type CompletionToast,
} from "../../services/agent-completion-toast";

function make(over: Partial<CompletionToast> & { id: string }): CompletionToast {
  return {
    dedupeKey: over.id,
    agentId: over.id,
    agentName: "Nara",
    agentProjectId: undefined,
    projectLabel: "orbit-vault",
    scope: "same",
    durationMs: 6000,
    createdAt: 0,
    ...over,
  };
}

describe("AgentCompletionToasts", () => {
  it("renders the agent name and the project it finished in", () => {
    const view = selectToastStackView([make({ id: "a", agentName: "Nara", projectLabel: "orchids-agent-teams" })]);
    render(<AgentCompletionToasts view={view} onDismiss={vi.fn()} onActivate={vi.fn()} />);
    expect(screen.getByText("Nara")).toBeInTheDocument();
    expect(screen.getByText("orchids-agent-teams")).toBeInTheDocument();
  });

  it("marks a background finish and shows the go-there affordance", () => {
    const toast = buildCompletionToast({
      eventId: "a", agentId: "a", agentName: "Nara",
      agentProjectId: "p1", activeProjectId: "active",
      resolveProjectLabel: () => "orbit-vault", now: 0,
    });
    const view = selectToastStackView([toast]);
    const { container } = render(<AgentCompletionToasts view={view} onDismiss={vi.fn()} onActivate={vi.fn()} />);
    expect(container.querySelector(".canvas-agent-toast--background")).toBeTruthy();
    expect(screen.getByText("↗")).toBeInTheDocument();
  });

  it("dismisses via the close button AFTER the exit animation ends (leaving state first)", () => {
    const onDismiss = vi.fn();
    const view = selectToastStackView([make({ id: "a" })]);
    const { container } = render(<AgentCompletionToasts view={view} onDismiss={onDismiss} onActivate={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    // Removal is deferred so the card can animate out — it is marked leaving instead.
    const card = container.querySelector(".canvas-agent-toast");
    expect(onDismiss).not.toHaveBeenCalled();
    expect(card?.getAttribute("data-leaving")).toBe("true");

    // jsdom quirk: style.animation is undefined there, so React registers the VENDOR-PREFIXED
    // animation event name (webkitAnimationEnd) — dispatching plain "animationend" never reaches
    // onAnimationEnd. Real browsers use the standard name. animationName is hand-attached because
    // jsdom has no AnimationEvent constructor.
    const end = new Event("webkitAnimationEnd", { bubbles: true });
    Object.defineProperty(end, "animationName", { value: "canvas-agent-toast-out" });
    fireEvent(card!, end);
    expect(onDismiss).toHaveBeenCalledWith("a");
  });

  it("falls back to a timer when animation events never fire (reduced motion / no CSS)", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      const view = selectToastStackView([make({ id: "a" })]);
      render(<AgentCompletionToasts view={view} onDismiss={onDismiss} onActivate={vi.fn()} />);

      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
      expect(onDismiss).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500); // > exit fallback window
      expect(onDismiss).toHaveBeenCalledWith("a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("activates a toast when its body is clicked", () => {
    const onActivate = vi.fn();
    const toast = make({ id: "a" });
    const view = selectToastStackView([toast]);
    render(<AgentCompletionToasts view={view} onDismiss={vi.fn()} onActivate={onActivate} />);
    fireEvent.click(screen.getByRole("button", { name: /open nara/i }));
    expect(onActivate).toHaveBeenCalledWith(toast);
  });

  it("collapses extra toasts behind a +N chip, then expands them in place (never discards)", () => {
    const toasts = Array.from({ length: 5 }, (_, i) => make({ id: `t${i}`, dedupeKey: `k${i}`, createdAt: i, agentName: `Agent${i}` }));
    const view = selectToastStackView(toasts); // cap 3 → 2 cards + 3 folded behind the chip
    render(<AgentCompletionToasts view={view} onDismiss={vi.fn()} onActivate={vi.fn()} />);
    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.queryByText("Agent0")).not.toBeInTheDocument(); // a folded toast, not yet a card

    fireEvent.click(screen.getByRole("button", { name: /view all/i }));

    // The chip reveals every finished agent as a card and disappears (nothing lost).
    expect(screen.queryByText("+3")).not.toBeInTheDocument();
    expect(screen.getByText("Agent0")).toBeInTheDocument();
    expect(screen.getByText("Agent4")).toBeInTheDocument();
  });

  it("layers multiple toasts as a deck — newest in front (--stack-i 0), older peeking behind", () => {
    const toasts = Array.from({ length: 3 }, (_, i) => make({ id: `t${i}`, dedupeKey: `k${i}`, createdAt: i, agentName: `Agent${i}` }));
    const { container } = render(<AgentCompletionToasts view={selectToastStackView(toasts)} onDismiss={vi.fn()} onActivate={vi.fn()} />);
    const cards = [...container.querySelectorAll<HTMLElement>(".canvas-agent-toast")];
    // Cards render oldest→newest; --stack-i is each card's distance from the newest (the front).
    expect(cards.map((c) => c.style.getPropertyValue("--stack-i"))).toEqual(["2", "1", "0"]);
    const list = container.querySelector<HTMLElement>(".canvas-agent-toast-list")!;
    expect(list.style.height).toBe("3.625rem"); // collapsed deck: 2.5rem + 2 peeks
  });

  it("fans the deck open on hover and closes again on leave", () => {
    const toasts = Array.from({ length: 3 }, (_, i) => make({ id: `t${i}`, dedupeKey: `k${i}`, createdAt: i }));
    const { container } = render(<AgentCompletionToasts view={selectToastStackView(toasts)} onDismiss={vi.fn()} onActivate={vi.fn()} />);
    const list = container.querySelector<HTMLElement>(".canvas-agent-toast-list")!;

    expect(list.getAttribute("data-open")).toBeNull();
    fireEvent.mouseOver(list);
    expect(list.getAttribute("data-open")).toBe("true");
    expect(list.style.height).toBe("8.5rem"); // open column: 3×2.5rem + 2×0.5rem gaps

    fireEvent.mouseOut(list);
    expect(list.getAttribute("data-open")).toBeNull();
  });

  it("shows the project label alone in the sub line — no 'Done on' prefix (the seal already says done)", () => {
    const view = selectToastStackView([make({ id: "a", projectLabel: "codespace-demo" })]);
    render(<AgentCompletionToasts view={view} onDismiss={vi.fn()} onActivate={vi.fn()} />);
    expect(screen.getByText("codespace-demo")).toBeInTheDocument();
    expect(screen.queryByText(/done on/i)).not.toBeInTheDocument();
  });

  it("activating a toast plays the exit animation too — dismissal is deferred, not instant", () => {
    const onActivate = vi.fn();
    const onDismiss = vi.fn();
    const toast = make({ id: "a" });
    const { container } = render(
      <AgentCompletionToasts view={selectToastStackView([toast])} onDismiss={onDismiss} onActivate={onActivate} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open nara/i }));
    expect(onActivate).toHaveBeenCalledWith(toast); // action fires immediately…
    expect(onDismiss).not.toHaveBeenCalled(); // …removal waits for the slide-out
    expect(container.querySelector(".canvas-agent-toast")?.getAttribute("data-leaving")).toBe("true");
  });

  it("recovers from the deck unmounting under the pointer — the next toast is not born suspended", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      const { container, rerender } = render(
        <AgentCompletionToasts view={selectToastStackView([make({ id: "a" })])} onDismiss={onDismiss} onActivate={vi.fn()} />,
      );
      // Hover the deck, then the last card is removed while the pointer is still there — the list
      // unmounts and no mouseleave ever fires.
      fireEvent.mouseOver(container.querySelector(".canvas-agent-toast-list")!);
      rerender(<AgentCompletionToasts view={selectToastStackView([])} onDismiss={onDismiss} onActivate={vi.fn()} />);

      // A later finish must start as a CLOSED deck with a live countdown, not pre-suspended.
      rerender(
        <AgentCompletionToasts view={selectToastStackView([make({ id: "b", durationMs: 6000 })])} onDismiss={onDismiss} onActivate={vi.fn()} />,
      );
      expect(container.querySelector(".canvas-agent-toast-list")?.getAttribute("data-open")).toBeNull();
      act(() => void vi.advanceTimersByTime(6_000));
      act(() => void vi.advanceTimersByTime(500));
      expect(onDismiss).toHaveBeenCalledWith("b");
    } finally {
      vi.useRealTimers();
    }
  });

  it("morphs a re-firing agent's card in place — same dedupeKey cancels a pending leave", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      const first = make({ id: "e1", dedupeKey: "agent-nara" });
      const { container, rerender } = render(
        <AgentCompletionToasts view={selectToastStackView([first])} onDismiss={onDismiss} onActivate={vi.fn()} />,
      );
      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
      expect(container.querySelector(".canvas-agent-toast")?.getAttribute("data-leaving")).toBe("true");

      // The agent finishes again before the exit completes — latest-wins replaces the toast (new
      // event id, same dedupeKey). The card must stay, un-leave, and never fire the stale dismissal.
      const second = make({ id: "e2", dedupeKey: "agent-nara" });
      rerender(<AgentCompletionToasts view={selectToastStackView([second])} onDismiss={onDismiss} onActivate={vi.fn()} />);
      expect(container.querySelector(".canvas-agent-toast")?.getAttribute("data-leaving")).toBeNull();
      act(() => void vi.advanceTimersByTime(500));
      expect(onDismiss).not.toHaveBeenCalledWith("e1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps completion notifications until manually dismissed when auto-dismiss is off", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      const view = selectToastStackView([make({ id: "a", durationMs: 6000 })]);
      const { container } = render(
        <AgentCompletionToasts
          view={view}
          autoDismiss={false}
          onDismiss={onDismiss}
          onActivate={vi.fn()}
        />,
      );

      act(() => void vi.advanceTimersByTime(60_000));

      expect(onDismiss).not.toHaveBeenCalled();
      expect(container.querySelector(".canvas-agent-toast")?.getAttribute("data-leaving")).toBeNull();
      expect(container.querySelector(".canvas-agent-toast__life")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh countdown when auto-dismiss is re-enabled", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      const view = selectToastStackView([make({ id: "a", durationMs: 6000 })]);
      const { container, rerender } = render(
        <AgentCompletionToasts view={view} autoDismiss onDismiss={onDismiss} onActivate={vi.fn()} />,
      );

      act(() => void vi.advanceTimersByTime(5_000));
      rerender(<AgentCompletionToasts view={view} autoDismiss={false} onDismiss={onDismiss} onActivate={vi.fn()} />);
      act(() => void vi.advanceTimersByTime(60_000));
      rerender(<AgentCompletionToasts view={view} autoDismiss onDismiss={onDismiss} onActivate={vi.fn()} />);
      act(() => void vi.advanceTimersByTime(5_000));

      expect(container.querySelector(".canvas-agent-toast")?.getAttribute("data-leaving")).toBeNull();
      act(() => void vi.advanceTimersByTime(1_000));
      expect(container.querySelector(".canvas-agent-toast")?.getAttribute("data-leaving")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes the countdown with the REMAINING time after an inspect, not a fresh full duration", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      const view = selectToastStackView([make({ id: "a", durationMs: 6000 })]);
      const { container } = render(<AgentCompletionToasts view={view} onDismiss={onDismiss} onActivate={vi.fn()} />);
      const list = container.querySelector<HTMLElement>(".canvas-agent-toast-list")!;

      act(() => void vi.advanceTimersByTime(3_000)); // half the life is spent…
      fireEvent.mouseOver(list); // …inspect…
      act(() => void vi.advanceTimersByTime(60_000));
      fireEvent.mouseOut(list); // …and leave: only ~3s of budget remains
      act(() => void vi.advanceTimersByTime(3_000));
      act(() => void vi.advanceTimersByTime(500));
      expect(onDismiss).toHaveBeenCalledWith("a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the open column at 6 cards — the chip keeps the tally of what stays folded", () => {
    const toasts = Array.from({ length: 10 }, (_, i) => make({ id: `t${i}`, dedupeKey: `k${i}`, createdAt: i, agentName: `Agent${i}` }));
    render(<AgentCompletionToasts view={selectToastStackView(toasts)} onDismiss={vi.fn()} onActivate={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /view all/i }));
    // Newest 6 become cards; the 4 oldest stay folded behind an inert tally chip.
    expect(screen.getByText("Agent9")).toBeInTheDocument();
    expect(screen.getByText("Agent4")).toBeInTheDocument();
    expect(screen.queryByText("Agent3")).not.toBeInTheDocument();
    // The leftover tally is NOT a disabled button (a dead click target) — it is plain text.
    const chip = screen.getByText("+4");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("data-inert")).toBe("true");
    expect(screen.queryByRole("button", { name: /view all/i })).not.toBeInTheDocument();
  });

  it("gives every card a visible life bar carrying that toast's own duration", () => {
    const toasts = [
      make({ id: "a", dedupeKey: "ka", createdAt: 0, durationMs: 6000 }),
      make({ id: "b", dedupeKey: "kb", createdAt: 1, durationMs: 10000, scope: "background" }),
    ];
    const { container } = render(
      <AgentCompletionToasts view={selectToastStackView(toasts)} onDismiss={vi.fn()} onActivate={vi.fn()} />,
    );
    // The drain is CSS-driven off --toast-life, so the countdown a user SEES matches the timer that
    // actually removes the card (6s same-project, 10s background) with no JS ticking a progress value.
    const cards = [...container.querySelectorAll<HTMLElement>(".canvas-agent-toast")];
    expect(cards.map((c) => c.style.getPropertyValue("--toast-life"))).toEqual(["6000ms", "10000ms"]);
    expect(container.querySelectorAll(".canvas-agent-toast__life")).toHaveLength(2);
  });

  it("suspends every card's auto-dismiss while the deck is open, resuming on leave", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      const view = selectToastStackView([make({ id: "a", durationMs: 6000 })]);
      const { container } = render(<AgentCompletionToasts view={view} onDismiss={onDismiss} onActivate={vi.fn()} />);
      const list = container.querySelector<HTMLElement>(".canvas-agent-toast-list")!;

      fireEvent.mouseOver(list);
      act(() => void vi.advanceTimersByTime(20_000));
      expect(onDismiss).not.toHaveBeenCalled(); // inspecting the stack — nothing slips away

      fireEvent.mouseOut(list);
      act(() => void vi.advanceTimersByTime(6_000));
      act(() => void vi.advanceTimersByTime(500));
      expect(onDismiss).toHaveBeenCalledWith("a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses the auto-dismiss countdown while the tab is hidden (away-from-app finishes wait)", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      const view = selectToastStackView([make({ id: "a", durationMs: 6000 })]);
      render(<AgentCompletionToasts view={view} onDismiss={onDismiss} onActivate={vi.fn()} />);

      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(10_000);
      expect(onDismiss).not.toHaveBeenCalled(); // paused while the app is in the background

      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
      // act: the countdown callback now flips React state (leaving) instead of removing directly,
      // so the render + exit-fallback scheduling must flush before the second advance.
      act(() => void vi.advanceTimersByTime(6_000));
      act(() => void vi.advanceTimersByTime(500));
      expect(onDismiss).toHaveBeenCalledWith("a"); // resumes on return, then completes
    } finally {
      vi.useRealTimers();
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    }
  });

  it("is a polite live region that does not steal focus", () => {
    const view = selectToastStackView([make({ id: "a" })]);
    const { container } = render(<AgentCompletionToasts view={view} onDismiss={vi.fn()} onActivate={vi.fn()} />);
    const host = container.querySelector(".canvas-agent-toast-host");
    expect(host?.getAttribute("aria-live")).toBe("polite");
    expect(host?.getAttribute("role")).toBe("status");
  });

  it("anchors bottom-right by default when no position is given", () => {
    const view = selectToastStackView([make({ id: "a" })]);
    const { container } = render(<AgentCompletionToasts view={view} onDismiss={vi.fn()} onActivate={vi.fn()} />);
    expect(container.querySelector(".canvas-agent-toast-host")?.getAttribute("data-pos")).toBe("bottom-right");
  });

  it("reflects the configured position as data-pos on the host", () => {
    const view = selectToastStackView([make({ id: "a" })]);
    const { container } = render(
      <AgentCompletionToasts view={view} position="top-left" onDismiss={vi.fn()} onActivate={vi.fn()} />,
    );
    expect(container.querySelector(".canvas-agent-toast-host")?.getAttribute("data-pos")).toBe("top-left");
  });
});
