import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasCornerControlBar, type CanvasCornerControlBarProps } from "../CanvasCornerControlBar";

function baseProps(overrides: Partial<CanvasCornerControlBarProps> = {}): CanvasCornerControlBarProps {
  return {
    zoom: 1,
    bounds: { minZoom: 0.04, maxZoom: 1.25 },
    onFitAll: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    memoryOpen: false,
    memoryCount: 0,
    onToggleMemory: vi.fn(),
    ...overrides,
  };
}

describe("CanvasCornerControlBar", () => {
  it("unifies zoom controls and the memory button in one group", () => {
    render(<CanvasCornerControlBar {...baseProps({ zoom: 0.5 })} />);
    const group = screen.getByRole("group", { name: /canvas controls/i });
    expect(group).toHaveTextContent("50%");
    expect(screen.getByRole("button", { name: /fit all canvas nodes/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /project memory/i })).toBeInTheDocument();
  });

  it("routes zoom actions and the memory toggle to their handlers", () => {
    const onFitAll = vi.fn();
    const onToggleMemory = vi.fn();
    render(<CanvasCornerControlBar {...baseProps({ onFitAll, onToggleMemory })} />);
    fireEvent.click(screen.getByRole("button", { name: /fit all canvas nodes/i }));
    fireEvent.click(screen.getByRole("button", { name: /project memory/i }));
    expect(onFitAll).toHaveBeenCalledOnce();
    expect(onToggleMemory).toHaveBeenCalledOnce();
  });

  it("reflects the open state on the memory button via aria-expanded", () => {
    const { rerender } = render(<CanvasCornerControlBar {...baseProps({ memoryOpen: false })} />);
    expect(screen.getByRole("button", { name: /project memory/i })).toHaveAttribute("aria-expanded", "false");
    rerender(<CanvasCornerControlBar {...baseProps({ memoryOpen: true })} />);
    expect(screen.getByRole("button", { name: /project memory/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows a memory count badge only when there is memory", () => {
    const { rerender } = render(<CanvasCornerControlBar {...baseProps({ memoryCount: 0 })} />);
    expect(screen.queryByText("3")).toBeNull();
    rerender(<CanvasCornerControlBar {...baseProps({ memoryCount: 3 })} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("drops to zoom-only when there is no open project", () => {
    render(<CanvasCornerControlBar {...baseProps({ showMemory: false })} />);
    expect(screen.getByRole("button", { name: /fit all canvas nodes/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /project memory/i })).toBeNull();
  });
});

// ── Sessions segment (plans/codecanvas-session-widget/, Slice 02) ────────────────────────────────

describe("CanvasCornerControlBar sessions segment", () => {
  it("is absent until a project is open, exactly as memory is", () => {
    const { rerender } = render(<CanvasCornerControlBar {...baseProps()} />);
    expect(screen.queryByRole("button", { name: /^sessions$/i })).not.toBeInTheDocument();

    rerender(
      <CanvasCornerControlBar {...baseProps({ showSessions: true, onToggleSessions: vi.fn() })} />,
    );
    expect(screen.getByRole("button", { name: /^sessions$/i })).toBeInTheDocument();
  });

  it("shows a count only when there is something to count", () => {
    const { rerender } = render(
      <CanvasCornerControlBar
        {...baseProps({ showSessions: true, onToggleSessions: vi.fn(), sessionCount: 0 })}
      />,
    );
    expect(screen.getByRole("button", { name: /^sessions$/i })).toHaveTextContent(/^Sessions$/);

    rerender(
      <CanvasCornerControlBar
        {...baseProps({ showSessions: true, onToggleSessions: vi.fn(), sessionCount: 3 })}
      />,
    );
    expect(screen.getByRole("button", { name: /^sessions$/i })).toHaveTextContent("3");
  });

  it("routes its toggle and reports open state through aria-expanded", () => {
    const onToggleSessions = vi.fn();
    const { rerender } = render(
      <CanvasCornerControlBar {...baseProps({ showSessions: true, onToggleSessions })} />,
    );
    const button = screen.getByRole("button", { name: /^sessions$/i });
    expect(button).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(button);
    expect(onToggleSessions).toHaveBeenCalledOnce();

    rerender(
      <CanvasCornerControlBar
        {...baseProps({ showSessions: true, onToggleSessions, sessionsOpen: true })}
      />,
    );
    expect(screen.getByRole("button", { name: /^sessions$/i })).toHaveAttribute("aria-expanded", "true");
  });

  // The bar publishes its own width so the NL command bar can reserve room; a third segment must not
  // break that contract, which is the exact failure a hardcoded reservation caused before.
  it("stays one group with zoom and memory when all three segments are present", () => {
    render(
      <CanvasCornerControlBar
        {...baseProps({ showSessions: true, onToggleSessions: vi.fn(), sessionCount: 2 })}
      />,
    );
    const group = screen.getByRole("group", { name: /canvas controls/i });
    expect(group).toContainElement(screen.getByRole("button", { name: /project memory/i }));
    expect(group).toContainElement(screen.getByRole("button", { name: /^sessions$/i }));
  });
});

describe("CanvasCornerControlBar — hidden by default (plans/canvas-dock/ S1b)", () => {
  afterEach(() => vi.useRealTimers());

  // The bar at 900..1100 × 700..740 in a 1200×800 window.
  function placeBar() {
    const group = screen.getByRole("group", { name: /canvas controls/i });
    group.getBoundingClientRect = () => ({ left: 900, top: 700, right: 1100, bottom: 740, width: 200, height: 40, x: 900, y: 700, toJSON: () => ({}) });
    return group;
  }
  const move = (x: number, y: number) => act(() => { window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y })); });

  it("rests hidden, wakes when the pointer reaches the corner, and rests again 1.6s after it leaves", () => {
    vi.useFakeTimers();
    render(<CanvasCornerControlBar {...baseProps()} />);
    const group = placeBar();
    expect(group).not.toHaveAttribute("data-awake");

    move(860, 660); // inside the reach above-left of the bar
    expect(group).toHaveAttribute("data-awake", "true");

    move(300, 300);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(group).toHaveAttribute("data-awake", "true");
    act(() => { vi.advanceTimersByTime(200); });
    expect(group).not.toHaveAttribute("data-awake");
  });

  it("coming back before the linger ends keeps it awake", () => {
    vi.useFakeTimers();
    render(<CanvasCornerControlBar {...baseProps()} />);
    const group = placeBar();
    move(950, 720);
    move(300, 300);
    act(() => { vi.advanceTimersByTime(1000); });
    move(950, 720);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(group).toHaveAttribute("data-awake", "true");
  });

  it("wakes on a zoom change and rests 1.6s after the last one; a re-render at the same zoom does nothing", () => {
    vi.useFakeTimers();
    const { rerender } = render(<CanvasCornerControlBar {...baseProps({ zoom: 1 })} />);
    const group = placeBar();
    rerender(<CanvasCornerControlBar {...baseProps({ zoom: 1 })} />);
    expect(group).not.toHaveAttribute("data-awake");

    rerender(<CanvasCornerControlBar {...baseProps({ zoom: 0.8 })} />);
    expect(group).toHaveAttribute("data-awake", "true");
    act(() => { vi.advanceTimersByTime(1000); });
    rerender(<CanvasCornerControlBar {...baseProps({ zoom: 0.6 })} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(group).toHaveAttribute("data-awake", "true");
    act(() => { vi.advanceTimersByTime(700); });
    expect(group).not.toHaveAttribute("data-awake");
  });

  it("CSS: invisible and click-through at rest; awake, focus and open popovers show it", () => {
    const css = readFileSync(join(__dirname, "../../../../styles/canvas/controls.css"), "utf8");
    const rest = css.match(/\.canvas-corner-bar \{[^}]*\}/)?.[0] ?? "";
    expect(rest).toMatch(/opacity: 0;/);
    expect(rest).toMatch(/pointer-events: none;/);
    const shown = css.match(/\.canvas-corner-bar\[data-awake\],[^{]*\{[^}]*\}/)?.[0] ?? "";
    for (const hold of [":focus-within", ".is-memory-open", ".is-sessions-open"]) expect(shown).toContain(`.canvas-corner-bar${hold}`);
    expect(shown).toMatch(/opacity: 1;/);
    expect(shown).toMatch(/pointer-events: auto;/);
  });
});
