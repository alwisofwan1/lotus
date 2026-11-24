import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Regression guard for the Canvas Terminal resize bug: a fixed px width/height on
 * `.canvas-terminal-node` pins `.canvas-terminal-host`, so the ResizeObserver in
 * useTerminalRuntime never fires and dragging the NodeResizer does nothing. The
 * node must fill its ReactFlow wrapper (which NodeResizer drives) instead.
 */
function terminalNodeRule(css: string): string {
  const match = css.match(/^\.canvas-terminal-node \{[\s\S]*?^\}/m);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

describe("canvas terminal CSS — terminal node resize contract", () => {
  const cssPath = resolve(process.cwd(), "src/styles/canvas/terminal-node.css");
  const css = readFileSync(cssPath, "utf8");
  const rule = terminalNodeRule(css);

  it("fills its ReactFlow wrapper so resize propagates to the xterm host", () => {
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/height:\s*100%/);
  });

  it("does not pin the node to a fixed pixel size", () => {
    expect(rule).not.toMatch(/width:\s*\d+px/);
    expect(rule).not.toMatch(/height:\s*\d+px/);
  });

  it("keeps live-agent PTY background owned by the resolved node floor", () => {
    // The ground moved from --node-surface (translucent ink wash) to --node-floor-solid
    // (opaque, resolved in JS and painted by xterm too). See canvas-terminal-floor.css.test.ts.
    const agentViewportRule = cssRule(css, ".canvas-agent-node .canvas-terminal-viewport");
    expect(agentViewportRule).toMatch(/background:\s*var\(--node-floor-solid\)/);
  });
});
