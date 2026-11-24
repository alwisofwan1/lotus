import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { CanvasPtyViewport } from "../nodes/CanvasPtyViewport";

const glyph = { label: "Terminal 1", tone: "neutral" as const, detail: "/repo", testId: "pty-glyph-cover" };

function renderViewport(overrides: Partial<React.ComponentProps<typeof CanvasPtyViewport>> = {}) {
  return render(
    <CanvasPtyViewport containerRef={createRef<HTMLDivElement>()} collapsed={false} glyph={glyph} {...overrides} />,
  );
}

describe("CanvasPtyViewport", () => {
  it("always renders the xterm host inside the viewport", () => {
    renderViewport();
    const host = document.querySelector(".canvas-terminal-host");
    expect(host).toBeInTheDocument();
    expect(host?.parentElement).toHaveClass("canvas-terminal-viewport");
  });

  it("never mounts a wallpaper backdrop layer", () => {
    // The viewport used to accept a `backdrop` and paint a blurred wallpaper copy beneath the
    // host. Both node families now run xterm with allowTransparency:false on an opaque floor, so
    // a layer at z-index 0 is unreachable by definition — it only ever cost a wallpaper redraw
    // plus a blur(11px) filter per node. The prop is gone; this pins that it stays gone.
    renderViewport();
    expect(document.querySelector(".canvas-terminal-backdrop-canvas")).not.toBeInTheDocument();
    expect(document.querySelector(".canvas-terminal-viewport")?.children).toHaveLength(1);
  });

  it("renders the search bar only when a search surface is provided", () => {
    renderViewport();
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
    renderViewport({ search: { api: { findNext: vi.fn(), findPrevious: vi.fn(), clearSearch: vi.fn() }, onClose: vi.fn() } });
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
  });

  it("shows a recovery overlay with a working restart button when recovery is given and not collapsed", () => {
    const onRecover = vi.fn();
    renderViewport({ recovery: { title: "Terminal needs recovery", sub: "Start fresh.", recoverLabel: "Restart terminal", onRecover } });
    expect(screen.getByText("Terminal needs recovery")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
    expect(onRecover).toHaveBeenCalledOnce();
  });

  it("omits the restart button when no recover handler is available", () => {
    renderViewport({ recovery: { title: "Terminal exited", sub: "x", recoverLabel: "Restart terminal" } });
    expect(screen.getByText("Terminal exited")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart terminal" })).not.toBeInTheDocument();
  });

  it("hides recovery and shows the glyph cover (keeping the host mounted) when collapsed", () => {
    renderViewport({ collapsed: true, recovery: { title: "Terminal needs recovery", sub: "x", recoverLabel: "Restart terminal", onRecover: vi.fn() } });
    expect(screen.queryByText("Terminal needs recovery")).not.toBeInTheDocument();
    expect(screen.getByTestId("pty-glyph-cover")).toBeInTheDocument();
    // host stays mounted at collapsed tiers (no DOM orphaning).
    expect(document.querySelector(".canvas-terminal-host")).toBeInTheDocument();
  });

  it("shows no glyph cover when not collapsed", () => {
    renderViewport({ collapsed: false });
    expect(screen.queryByTestId("pty-glyph-cover")).not.toBeInTheDocument();
  });
});
