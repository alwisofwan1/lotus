import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Canvas terminal typography contract.
 *
 * The two live node families (Terminal Node + Live Agent Terminal) declare "monospace chrome"
 * (ADR-0033), and both used to spell that as `var(--canvas-code)`. That token is the WHITEBOARD
 * code face — `node-shell.css` defines it as Comic Mono for Excalidraw parity, and
 * `shape-defaults.ts` maps a shape's `fontFamily: "code"` onto it. So the terminal chrome was
 * rendering in a rounded comic face while the theme's actual mono choice
 * (`--canvas-font-mono`, JetBrains Mono via resolve-canvas-theme.ts) reached nothing but the
 * memory panel.
 *
 * Three rules, each checkable here:
 *   1. Terminal chrome reads the THEME mono token, so an Artisan theme's `fonts.mono` is what
 *      the header actually renders in.
 *   2. The whiteboard token is untouched — shape text must stay Comic Mono.
 *   3. Every `var()` on a font token carries a real fallback chain. These tokens are written by
 *      JS (resolve-canvas-theme) or by Tailwind's theme layer, so a frame rendered before they
 *      land must still be monospace rather than falling back to the inherited body sans.
 */

function read(relPath: string): string {
  return readFileSync(resolve(process.cwd(), relPath), "utf8");
}

/** Strip comments so assertions read declarations, not prose that merely names a token. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Grab a top-level rule by its exact (possibly multi-line) selector list. */
function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match, `missing rule: ${selector}`).not.toBeNull();
  return stripCssComments(match?.[0] ?? "");
}

const terminalCss = read("src/styles/canvas/terminal-node.css");
const personaCss = read("src/styles/canvas/agent-node-persona-nl.css");
const nodeShellCss = read("src/styles/canvas/node-shell.css");
const globalsCss = read("src/app/globals.css");

describe("terminal node chrome typography", () => {
  const cthRoot = cssRule(terminalCss, ".cth-root");

  it("takes the header face from the theme mono token", () => {
    expect(cthRoot).toMatch(/font-family:\s*var\(--canvas-font-mono/);
  });

  it("does not use the whiteboard code token for terminal chrome", () => {
    // Rule 1: `--canvas-code` is Comic Mono. A terminal header is not a whiteboard sticky.
    expect(cthRoot).not.toMatch(/--canvas-code/);
  });

  it("keeps a monospace fallback for the frame before the theme vars land", () => {
    expect(cthRoot).toMatch(/font-family:\s*var\(--canvas-font-mono,[^)]*monospace/);
  });
});

describe("live agent persona header typography", () => {
  const personaHeader = cssRule(personaCss, ".canvas-persona-header");

  it("takes the header face from the theme mono token", () => {
    expect(personaHeader).toMatch(/font-family:\s*var\(--canvas-font-mono/);
  });

  it("does not use the whiteboard code token for terminal chrome", () => {
    expect(personaHeader).not.toMatch(/--canvas-code/);
  });

  it("keeps a monospace fallback for the frame before the theme vars land", () => {
    expect(personaHeader).toMatch(/font-family:\s*var\(--canvas-font-mono,[^)]*monospace/);
  });
});

describe("whiteboard code token is untouched", () => {
  it("still resolves --canvas-code to the Excalidraw-parity comic face", () => {
    // Rule 2: shape text with `fontFamily: "code"` renders through this token
    // (shape-defaults.ts). Repointing the terminal chrome must not restyle the whiteboard.
    const shell = cssRule(nodeShellCss, ".codecanvas-shell");
    expect(shell).toMatch(/--canvas-code:\s*"Comic Mono"/);
  });
});

describe("--font-mono token resolves to a real face", () => {
  // `@theme inline { --font-mono: var(--font-geist-mono) }` DID emit
  // `:root, :host { --font-mono: var(--font-geist-mono) }` (verified by compiling globals.css
  // through this project's own @tailwindcss/postcss 4.2.1). `--font-geist-mono` is defined
  // nowhere and `geist` is not a dependency, so every `var(--font-mono, <fallback>)` consumer
  // was invalid-at-computed-value-time: the fallback never fires, font-family becomes `unset`,
  // and the element INHERITS the body sans. That silently un-monospaced 77 call sites.
  const themeBlock = stripCssComments(globalsCss).match(/@theme inline\s*\{[\s\S]*?\n\}/)?.[0] ?? "";

  it("declares --font-mono inside @theme inline", () => {
    expect(themeBlock).toMatch(/--font-mono:/);
  });

  it("never leaves --font-mono as a bare reference to the undefined geist token", () => {
    expect(themeBlock).not.toMatch(/--font-mono:\s*var\(--font-geist-mono\)\s*;/);
  });

  it("falls back to JetBrains Mono and a generic monospace", () => {
    const decl = themeBlock.match(/--font-mono:[^;]*;/)?.[0] ?? "";
    expect(decl).toMatch(/"JetBrains Mono"/);
    expect(decl).toMatch(/monospace/);
  });
});
