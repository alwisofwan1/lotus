import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { countColorLiterals } from "./color-literals";

/**
 * The CodeSpace workbench (editor cell) against the approved Theme 10 mockup, decision T5:
 * the tab bar sits on canvas, the active tab is the editor's own ground with a 1.5px ink rule on
 * top, unsaved is a warning dot, and colour is only for status — no teal or blue washes.
 */
const globals = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
const start = globals.indexOf(".codespace-panel-surface {");
const end = globals.indexOf(".glass {");
const section = globals.slice(start, end);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = section.match(new RegExp(`^${escaped} \\{[^}]*\\}`, "m"));
  expect(match, `missing rule ${selector}`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("CodeSpace workbench (mockup T5)", () => {
  it("is bounded by the cell root and the glass utilities that follow it", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("derives the panel tokens from the design-system text and surface tokens", () => {
    const root = rule(".codespace-panel-surface");
    expect(root).toMatch(/--codespace-panel-text: var\(--fg\);/);
    expect(root).toMatch(/--codespace-panel-text-secondary: var\(--text-secondary\);/);
    expect(root).toMatch(/--codespace-panel-text-muted: var\(--text-muted\);/);
    expect(root).toMatch(/--codespace-panel-text-quiet: var\(--ds-text-quiet\);/);
    expect(root).toMatch(/background: var\(--bg\);/);
  });

  it("puts the tab bar on canvas and the active tab on the editor's ground, with an ink rule on top", () => {
    expect(rule(".codespace-workbench-tabbar")).toMatch(/background: var\(--bg-sidebar\);/);
    const active = rule(".codespace-workbench-tab-active");
    expect(active).toMatch(/background: var\(--bg\);/);
    expect(active).toMatch(/color: var\(--codespace-panel-text\);/);
    const ruleTop = rule(".codespace-workbench-tab-active::after");
    expect(ruleTop).toMatch(/top: 0;/);
    expect(ruleTop).toMatch(/height: 1\.5px;/);
    expect(ruleTop).toMatch(/background: var\(--ds-workbench-tab-active-color\);/);
  });

  it("marks unsaved with a plain warning dot, no glow", () => {
    const dot = rule(".codespace-workbench-tab-dirty");
    expect(dot).toMatch(/background: var\(--ds-workbench-tab-dirty-color\);/);
    expect(dot).not.toMatch(/box-shadow/);
  });

  it("selects a tree row with the active fill, not a hue", () => {
    const active = rule(".codespace-workbench-tree-row-active");
    expect(active).toMatch(/var\(--codespace-panel-surface-active\)/);
    expect(active).not.toMatch(/45, 212, 191/);
  });

  it("keeps hard-coded colour out of the section, except reasoned exemptions", () => {
    expect(countColorLiterals(section).count).toBe(0);
  });
});

describe("CodeSpace pane frame (mockup T5)", () => {
  const shell = readFileSync(resolve(process.cwd(), "src/styles/workspace-shell.css"), "utf8");
  const block = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...shell.matchAll(new RegExp(`^${escaped} \\{[^}]*\\}`, "gm"))].map((m) => m[0]).join("\n");
  };

  it("rounds a pane at the panel radius, its edge light and body with it", () => {
    expect(block(".ws-pane")).toMatch(/border-radius: var\(--ws-r-panel\);/);
    expect(block(".ws-pane-edge-light")).toMatch(/border-radius: calc\(var\(--ws-r-panel\) \+ 4px\);/);
    expect(block(".ws-pane > .ws-pane-body")).toMatch(/calc\(var\(--ws-r-panel\) - 1px\)/);
  });

  it("makes a terminal pane the terminal's well, under a translucent header", () => {
    expect(block('.ws-pane[data-kind="terminal"]')).toMatch(/background: var\(--ds-workbench-terminal-bg\);/);
    expect(block(".ws-pane-header")).toMatch(/background: var\(--ds-workbench-pane-header\);/);
  });

  it("shows a live pane in the success colour", () => {
    expect(shell).toMatch(/--ws-activity-live: var\(--ds-success\);/);
  });
});
