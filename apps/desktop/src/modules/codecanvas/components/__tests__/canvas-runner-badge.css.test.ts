import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(process.cwd(), "src/styles/canvas/agent-node-persona-nl.css"),
  "utf8",
);

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match, `missing rule: ${selector}`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("Canvas live-agent runner badge", () => {
  it("keeps glyph and terminal marks transparent while only logo marks receive a mask fill", () => {
    const badge = cssRule(".canvas-persona-badge");
    const logo = cssRule('.canvas-persona-badge[data-mark="logo"]');

    expect(badge).toMatch(/background:\s*transparent/);
    expect(badge).toMatch(/color:\s*var\(--badge-color/);
    expect(badge).not.toMatch(/mask:/);

    expect(logo).toMatch(/background:\s*currentColor/);
    expect(logo).toMatch(/-webkit-mask:/);
    expect(logo).toMatch(/mask:/);
  });
});
