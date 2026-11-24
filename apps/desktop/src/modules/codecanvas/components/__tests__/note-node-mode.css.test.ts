import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/canvas/note-node.css"), "utf8");

/** Declarations only. The file documents the blur policy in prose, including the property name. */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Split a `transition` value on top-level commas only — `var(--x, fallback)` also holds one. */
function transitionProperties(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
}

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match, `missing rule: ${selector}`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("Note read/edit mode chrome", () => {
  it("has no read|edit pill — edit mode is a sage ring on the whole note", () => {
    expect(css).not.toContain("canvas-note-mode");
    expect(css).toMatch(
      /\.canvas-note-node:has\(\.canvas-note-node-body\[data-note-mode="edit"\]\)\s*\{\s*box-shadow:\s*0 0 0 2px var\(--nv-sage\)/,
    );
  });

  it("hides the header actions with pointer-events, never opacity alone", () => {
    // An opacity:0 control that still takes clicks is a trap.
    const block = rule(".cnh-actions");
    expect(block).toMatch(/opacity:\s*0/);
    expect(block).toMatch(/pointer-events:\s*none/);
    // Keyboard users still reach them: focus-within reveals, and an open menu keeps them shown.
    expect(css).toMatch(/\.canvas-note-node:focus-within \.cnh-actions/);
    expect(css).toMatch(/\.canvas-note-header\[data-menu-open\] \.cnh-actions/);
  });

  it("animates with compositable or cheap paint properties only", () => {
    for (const block of [rule(".cnh-actions"), rule(".cnh-label"), rule(".canvas-note-editor")]) {
      const transitions = [...block.matchAll(/transition:\s*([^;]+);/g)].map((match) => match[1]);
      for (const value of transitions) {
        for (const property of transitionProperties(value)) {
          expect(["transform", "opacity", "color", "background", "border-color", "box-shadow"]).toContain(property);
        }
        expect(value).not.toMatch(/blur|border-radius|backdrop-filter/);
      }
    }
  });

  it("keeps read mode caretless but selectable, with a text cursor that invites the click", () => {
    expect(css).toMatch(
      /\.canvas-note-node-body\[data-note-mode="read"\] \.canvas-note-editor\s*\{[\s\S]*?caret-color:\s*transparent;[\s\S]*?user-select:\s*text;/,
    );
    expect(css).toMatch(/\.canvas-note-node-body\[data-note-mode="read"\]\s*\{\s*cursor:\s*text;/);
  });

  it("collapses motion under prefers-reduced-motion", () => {
    const query = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(query).toMatch(/\.cnh-actions/);
    expect(query).toMatch(/transition-duration:\s*0\.01ms/);
  });
});

describe("Note paper (ADR-0046)", () => {
  it("roots every ink step on the paper ink, so no light-mode branch is needed", () => {
    for (const step of [96, 90, 78, 58, 42, 30, 18, 10, 6]) {
      const token = `--note-ink-${String(step).padStart(2, "0")}`;
      expect(css, token).toContain(`${token}: color-mix(in oklab, var(--nv-ink)`);
    }
    expect(css).not.toMatch(/data-canvas-mode="light"/);
  });

  it("turns the shell glass into paper by re-pointing its tokens, at (0,2,0)", () => {
    const paper = rule(".codecanvas-shell .canvas-note-node");
    expect(paper).toMatch(/--node-glass-bg:\s*var\(--nv-paper\)/);
    expect(paper).toMatch(/--node-accent:\s*var\(--nv-sage\)/);
    expect(paper).toMatch(/--node-resting-filter:\s*none/);
  });

  it("uses the serif face for the title and Inter for the body — no mono", () => {
    expect(rule(".canvas-note-editor h1")).toMatch(/font-family:\s*var\(--nv-font-serif\)/);
    expect(rule(".canvas-note-editor")).toMatch(/font-family:\s*var\(--nv-font-body\)/);
    expect(declarations).not.toMatch(/--canvas-font-mono/);
  });

  it("marks only the first H1 as the title with the short sage bar", () => {
    expect(css).toMatch(/\.canvas-note-editor > h1:first-child::after\s*\{[\s\S]*?background:\s*var\(--nv-sage-soft\)/);
  });

  it("draws round checks with a sage done state and no strike-through", () => {
    const box = css.match(/ul\[data-type="taskList"\] > li > label input\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(box).toMatch(/border-radius:\s*999px/);
    expect(box).toMatch(/width:\s*1\.25rem/);
    expect(css).toMatch(/ul\[data-type="taskList"\] > li > label input:checked\s*\{[\s\S]*?background:\s*var\(--nv-sage\)/);
    expect(declarations).not.toMatch(/line-through/);
  });

  it("keeps blur off the note and its popovers", () => {
    expect(declarations).not.toMatch(/backdrop-filter/);
    expect(declarations).not.toMatch(/blur\(/);
  });

  it("never mixes a colour from --canvas-bg", () => {
    // --canvas-bg is paper.fill, a gradient on several themes; color-mix() with a gradient is invalid.
    expect(css).not.toMatch(/color-mix\([^)]*var\(--canvas-bg\)/);
  });

  it("scopes the slash palette to shell-level tokens, since it mounts outside the node", () => {
    // --node-* and --nv-* live on .canvas-note-node; the palette is appended to .codecanvas-shell.
    const menu = rule(".canvas-note-slash-menu");
    expect(menu).not.toMatch(/var\(--node-/);
    expect(menu).not.toMatch(/var\(--note-ink/);
  });

  it("wins over the shared scrim by specificity, not by @import order", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/styles/canvas/node-shell.css"), "utf8");
    expect(shell).toMatch(/\.canvas-note-node-body,/);
    expect(css).toMatch(/^\.canvas-note-node \.canvas-note-node-body\s*\{/m);
  });

  it("keeps every surface that sits on the paper opaque", () => {
    for (const token of ["--note-raise", "--note-inset"]) {
      const declaration = css.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1] ?? "";
      expect(declaration, token).not.toContain("transparent");
    }
    expect(rule(".cnh-menu")).toMatch(/background:\s*var\(--note-raise\)/);
    expect(rule(".canvas-note-bubble")).toMatch(/background:\s*var\(--nv-forest\)/);
  });

  it("leaves the drop overlay translucent — it must show the content it is about to land on", () => {
    expect(rule(".canvas-note-drop-overlay")).toMatch(/background:\s*color-mix\(in oklab, var\(--note-paper\) \d+%, transparent\)/);
  });
});
