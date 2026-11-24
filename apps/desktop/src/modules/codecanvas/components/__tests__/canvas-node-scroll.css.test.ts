import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

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

describe("canvas node scrollbars", () => {
  const noteCss = readCanvasCss("note-node.css");
  const skillsCss = readCanvasCss("skills-node.css");
  const agentCss = readCanvasCss("agent-node.css", "agent-node-graph.css", "agent-node-plan-composer.css", "agent-node-persona-nl.css");

  it("keeps the note body as a clipped flex column so attachments cannot break textarea scroll", () => {
    const rule = cssRule(noteCss, ".canvas-note-node-body");
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/flex-direction:\s*column/);
    expect(rule).toMatch(/overflow:\s*hidden/);
  });

  it("lets note content shrink and scroll inside resized nodes", () => {
    const rule = cssRule(noteCss, ".canvas-note-editor");
    expect(rule).toMatch(/flex:\s*1 1 auto/);
    expect(rule).toMatch(/min-height:\s*0/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
    expect(rule).toMatch(/scrollbar-gutter:\s*stable/);
    expect(rule).not.toMatch(/min-height:\s*\d+px/);
  });

  it("styles the skills list and skill preview scrollbars consistently", () => {
    // Three surfaces share one scrollbar now: the list column, the in-node SKILL.md reader,
    // and the popped-out skill node.
    expect(skillsCss).toMatch(/\.canvas-skills-node-list,\s*\n\.canvas-skills-detail-body \.wbmd-scroll,\s*\n\.canvas-skill-node-body \.wbmd-scroll\s*\{/);
    expect(skillsCss).toMatch(/\.canvas-skills-node-list::-webkit-scrollbar,\s*\n\.canvas-skills-detail-body \.wbmd-scroll::-webkit-scrollbar,\s*\n\.canvas-skill-node-body \.wbmd-scroll::-webkit-scrollbar\s*\{[\s\S]*?width:\s*10px;[\s\S]*?height:\s*10px;/);
  });

  it("gives the note editor its own theme-derived scrollbar instead of borrowing the skills rule", () => {
    // The note's scrollbar used to be declared in skills-node.css, which is how it ended up with a
    // literal white thumb that disappears on light paper.
    expect(skillsCss).not.toMatch(/\.canvas-note-editor/);
    expect(noteCss).toMatch(/\.canvas-note-editor::-webkit-scrollbar\s*\{[\s\S]*?width:\s*8px;/);
    expect(noteCss).toMatch(/\.canvas-note-editor::-webkit-scrollbar-thumb\s*\{[\s\S]*?background:\s*var\(--note-ink-18\);/);
    expect(noteCss).toMatch(/--note-ink-18:\s*color-mix\(in oklab, var\(--nv-ink\)/);
  });

  it("styles agent and plan node scroll regions consistently", () => {
    expect(agentCss).toMatch(/\.agent-transcript-scroll,\s*\n\.agent-def-preview,\s*\n\.agent-history-list,\s*\n\.agent-history-actions,\s*\n\.plan-card-body,\s*\n\.agent-diff-body\s*\{/);
    expect(agentCss).toMatch(/\.plan-card-body::-webkit-scrollbar/);
    expect(agentCss).toMatch(/\.agent-diff-body::-webkit-scrollbar-thumb:hover/);
  });
});
