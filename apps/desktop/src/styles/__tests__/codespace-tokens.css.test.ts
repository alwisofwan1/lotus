import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * codespace.css after the CodeSpace page left (9ab0b1e3, Theme 13).
 *
 * Nothing renders `.codespace-shell` any more, and its `--cs-*` aliases went with it: the Fleet view
 * and the terminal drop overlay kept reading `var(--cs-text)` and got nothing, so every colour built
 * on it was invalid and fell back to the inherited one. These pin both halves of the fix.
 */
const css = readFileSync(resolve(process.cwd(), "src/styles/codespace.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("codespace.css tokens", () => {
  it("has no rule scoped to .codespace-shell, which nothing renders", () => {
    expect(css).not.toMatch(/\.codespace-shell\b/);
  });

  it("has no rule for the workspace rail's menu or tooltip, whose rail nothing mounts", () => {
    expect(css).not.toMatch(/\.codespace-workspace-rail-/);
  });

  it("declares every --cs-* token it reads", () => {
    const declared = new Set([...css.matchAll(/(--cs-[\w-]+)\s*:/g)].map((m) => m[1]));
    const read = new Set([...css.matchAll(/var\((--cs-[\w-]+)/g)].map((m) => m[1]));
    expect([...read].filter((name) => !declared.has(name))).toEqual([]);
  });

  it("declares them on :root, so portalled menus and the Fleet view reach them", () => {
    const root = css.match(/^:root \{[^}]*\}/m)?.[0] ?? "";
    expect(root).toMatch(/--cs-text:\s*var\(--ds-workbench-text\)/);
  });
});
