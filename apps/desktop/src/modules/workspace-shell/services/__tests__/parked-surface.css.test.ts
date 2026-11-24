import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A parked surface must not be laid out.
 *
 * Modes and the parked shell hide with opacity so their panes stay attached (see
 * `WorkspaceShellPage.tsx` and `AppShell.tsx`). Opacity alone still lays the subtree out: sampled
 * 2026-09-29, the hidden Code mode kept re-measuring streaming terminal text on every frame — the
 * same ~140 layout samples per 5 s in Chat as in Code. `content-visibility: hidden` skips layout
 * and paint for the subtree while keeping its boxes and rendering state, so the panes stay
 * attached and coming back costs no re-attach.
 */

const read = (relative: string) => readFileSync(path.resolve(__dirname, relative), "utf8");

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} rule`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("parked surfaces skip layout", () => {
  it("an inactive shell mode is content-visibility hidden", () => {
    const css = read("../../../../styles/workspace-shell.css");
    expect(ruleBody(css, `.ws-surface:not([data-active="true"])`)).toMatch(/content-visibility:\s*hidden/);
  });

  it("the parked app shell is content-visibility hidden", () => {
    const css = read("../../../../app/globals.css");
    expect(ruleBody(css, ".app-shell-parked")).toMatch(/content-visibility:\s*hidden/);
  });
});
