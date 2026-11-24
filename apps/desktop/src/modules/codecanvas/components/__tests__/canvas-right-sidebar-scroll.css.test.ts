import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

/** Read + join a group of canvas CSS files (oversized files are split per the ≤600-line policy). */
function readCanvasCss(...names: string[]): string {
  return names
    .map((name) => readFileSync(resolve(process.cwd(), `src/styles/canvas/${name}`), "utf8"))
    .join("\n");
}

describe("CanvasRightSidebar scroll containment", () => {
  const layoutCss = readCanvasCss("layout.css", "layout-panels.css");
  const agentCss = readCanvasCss("agent-node.css", "agent-node-graph.css", "agent-node-plan-composer.css", "agent-node-persona-nl.css");

  it("keeps the right sidebar middle region as the parent scroll container", () => {
    const rule = cssRule(layoutCss, ".canvas-sidebar-scroll-area");
    expect(rule).toMatch(/flex:\s*1 1 auto/);
    expect(rule).toMatch(/min-height:\s*0/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
    expect(rule).toMatch(/overflow-x:\s*hidden/);
  });

  it("gives filters, expanded stacks, action footer, and inbox their own overflow paths", () => {
    expect(cssRule(layoutCss, ".canvas-process-filters")).toMatch(/overflow-y:\s*auto/);
    expect(cssRule(layoutCss, ".canvas-sidebar-body")).toMatch(/overflow:\s*visible/);
    expect(cssRule(layoutCss, ".canvas-process-group-body-inner")).toMatch(/max-height:\s*clamp/);
    expect(cssRule(layoutCss, ".canvas-process-group-body-inner")).toMatch(/overflow-y:\s*auto/);
    expect(cssRule(layoutCss, ".canvas-sidebar-actions")).toMatch(/overflow-y:\s*auto/);
    expect(cssRule(agentCss, ".canvas-inbox-scroll")).toMatch(/overflow-y:\s*auto/);
  });
});
