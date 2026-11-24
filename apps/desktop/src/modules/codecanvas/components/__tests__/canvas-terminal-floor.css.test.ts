import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toCanvasThemeStyle } from "@/modules/codecanvas/services/theme/canvas-theme-style";
import { resolveTerminalFloor } from "@/modules/codecanvas/services/theme/terminal-floor";
import { defaultCanvasTheme } from "@/modules/codecanvas/services/theme/builtin-themes";

/**
 * The canvas terminal floor (plans/canvas-terminal-opaque-floor).
 *
 * xterm now runs with `allowTransparency: false` and paints `--node-floor-solid` itself. Three
 * things follow, and each is checkable here:
 *
 *   1. The CSS viewport must carry the SAME floor. xterm covers the grid but not the moments
 *      before it mounts, nor the gutter a rim introduces — a different colour there reads as a
 *      seam down the node.
 *   2. The old `background-color: transparent !important` override on `.xterm` must not apply to
 *      the agent node any more. It would erase the floor xterm just painted and put the DOM
 *      renderer's alpha compositing straight back.
 *   3. There is NO glass rim. A 7px gutter of --node-surface was tried so photo wallpapers
 *      would still move at the edges, and removed after seeing it render: on a BRIGHT paper
 *      (Lakeside Day) the gutter reads as a light halo, and with the selection ring on top the
 *      node shows three nested frames. It only worked on the dark photo it was designed against.
 */

function read(name: string): string {
  return readFileSync(resolve(process.cwd(), `src/styles/canvas/${name}`), "utf8");
}

/**
 * Declarations only. These files carry long rationale comments that quote the very declarations
 * they explain having removed, so a bare `.not.toMatch()` over the raw text reports the comment
 * as the violation it was written to document.
 */
function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Grab a top-level rule by its exact (possibly multi-line) selector list. */
function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match, `missing rule: ${selector}`).not.toBeNull();
  return match?.[0] ?? "";
}

const terminalNode = read("terminal-node.css");
const theme = read("theme.css");

describe("canvas terminal floor — the viewport matches what xterm paints", () => {
  it("floors the live agent viewport with --node-floor-solid", () => {
    const rule = cssRule(terminalNode, ".canvas-agent-node .canvas-terminal-viewport");
    expect(rule).toContain("var(--node-floor-solid)");
  });

  it("floors the terminal node the same way, so both families read as one material", () => {
    expect(terminalNode).toContain("--canvas-terminal-bg: var(--node-floor-solid)");
  });

  it("never forces the xterm layers transparent — that would erase the floor xterm paints", () => {
    // Both families now run allowTransparency:false, so ANY `background-color: transparent`
    // reset on the xterm layers punches a hole straight back through the opaque ground.
    // The xterm TEXT layers only. `::-webkit-scrollbar-thumb` is also a `.xterm-viewport`
    // descendant and its transparency is deliberate — the thumb stays invisible until hover.
    const layerRules = (declarationsOnly(terminalNode).match(/^[^{}]*\.xterm[^{}]*\{[\s\S]*?^\}/gm) ?? [])
      .filter((rule) => !rule.slice(0, rule.indexOf("{")).includes("::"));
    expect(layerRules.length).toBeGreaterThan(0); // the rules still exist (width: auto lives there)
    for (const rule of layerRules) {
      expect(rule).not.toContain("background-color: transparent");
    }
  });
});

describe("canvas terminal floor — the token is actually defined", () => {
  /**
   * The regression this pins. terminal-node.css consumed `var(--node-floor-solid)` and
   * resolve-canvas-theme.ts emitted `--ct-node-floor-solid`, but no rule ever bridged the two.
   * An undefined custom property makes every declaration referencing it invalid at computed-value
   * time, so the viewport silently fell back to TRANSPARENT while xterm kept painting its own
   * opaque rows. The only pixels that gave it away were the sub-row strip along the bottom edge,
   * where the node's glass showed through the hole.
   */
  it("bridges --ct-node-floor-solid onto the public token, like every other --ct-* var", () => {
    const shell = cssRule(theme, ".codecanvas-shell");
    expect(shell).toMatch(/--node-floor-solid:\s*var\(--ct-node-floor-solid,[^)]*\)/);
  });

  it("carries an OPAQUE fallback, so a shell rendered before the resolver still has a ground", () => {
    const [, fallback] = theme.match(/--node-floor-solid:\s*var\(--ct-node-floor-solid,\s*([^)]*\)?[^;]*)\);/) ?? [];
    expect(fallback?.trim()).toBe("rgb(8, 8, 12)"); // FALLBACK_PAPER in terminal-floor.ts
  });

  it("bridges the EXACT name the resolver emits — the chain has to close on a literal string", () => {
    // The break was a name mismatch across a layer boundary, invisible to both sides: the resolver
    // emits `--node-floor-solid`, toCanvasThemeStyle renames it to `--ct-node-floor-solid` on the
    // canvas root, and CSS has to read that renamed token back. Nothing but a test comparing the
    // two literals can catch a rename on either side, since a missing custom property fails
    // silently rather than erroring.
    const emitted = toCanvasThemeStyle(defaultCanvasTheme()) as Record<string, string>;
    const floor = resolveTerminalFloor(defaultCanvasTheme()).background;
    expect(emitted["--ct-node-floor-solid"]).toBe(floor);
    expect(cssRule(theme, ".codecanvas-shell")).toContain("var(--ct-node-floor-solid,");
  });

  it("keeps no theme-scoped override that re-transparents the floor", () => {
    // `--canvas-terminal-bg: transparent` under [data-canvas-theme="custom"] is what kept the
    // Terminal Node on blurred wallpaper while the live agent moved to an opaque ground.
    expect(declarationsOnly(theme)).not.toMatch(/--canvas-terminal-bg:\s*transparent/);
  });
});

describe("canvas terminal floor — one material across both node families", () => {
  const customTerminalRules =
    theme.match(/^\.codecanvas-shell\[data-canvas-theme="custom"\] \.canvas-terminal-node[^{]*\{[\s\S]*?^\}/gm) ?? [];

  it("does not give the Terminal Node its own glass recipe on the custom wallpaper theme", () => {
    // The custom theme used to re-glass the terminal alone: a translucent host with its own
    // blur(18px), a tinted body, and a private --node-glass-* set. Side by side with a live agent
    // on the opaque floor the two read as different materials — which is the reported bug.
    for (const rule of customTerminalRules) {
      expect(rule).not.toMatch(/backdrop-filter:\s*blur/);
      expect(rule).not.toMatch(/--node-glass-(bg|filter|inset):/);
    }
  });

  it("keeps the header's blur suppression, which is what stops a double-frost", () => {
    // The node shell already owns one backdrop-filter; the header must not add a second.
    const headerRule = cssRule(theme, '.codecanvas-shell[data-canvas-theme="custom"] .canvas-terminal-node .cth-root');
    expect(headerRule).toMatch(/backdrop-filter:\s*none/);
  });
});

describe("canvas terminal floor — no glass rim", () => {
  it("gives the agent viewport one uniform floor, with no theme-scoped gutter", () => {
    expect(terminalNode).not.toContain("[data-canvas-paper-media] .canvas-agent-node");
  });

  it("does not carve the terminal host away from the viewport edges", () => {
    // The host is `position: absolute; inset: 0`. Any override of that inset is a gutter by
    // another name — and padding on the viewport could never have produced one anyway, since an
    // absolutely positioned box resolves its offsets against the containing block's PADDING box.
    const hostRules = terminalNode.match(/^[^{}]*\.canvas-terminal-host[^{}]*\{[\s\S]*?^\}/gm) ?? [];
    for (const rule of hostRules) {
      // Read the declared value rather than pattern-matching around it: `\s*(?!0)` backtracks to
      // empty and then passes on the space before a perfectly valid `inset: 0`.
      for (const [, value] of rule.matchAll(/inset:\s*([^;]+);/g)) {
        expect(value.trim()).toBe("0");
      }
    }
  });
});
