import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Node surfaces and semantic ink must answer to the theme's polarity.
 *
 * Measured on Garden of Dawn, in a browser, against the node body these files actually render:
 * every status and identity colour in the workflow nodes landed between 1.09 and 1.79:1 — the
 * priority chips, both critic verdicts, the dispatched marker, the waiting state, the critic icon
 * and the team pills were all effectively invisible. The same inks measure 6.1 to 10.6:1 on Void,
 * which is why a dark-theme reviewer sees nothing wrong. The music node was worse still: its
 * panels were a fixed blue-black while its text correctly followed --canvas-text, so a light theme
 * rendered dark ink on a near-black slab.
 *
 * ADR-0023 §2b is intact. It makes the run-state ramp theme-INDEPENDENT so "running" cannot mean a
 * different colour per theme — a guarantee about HUE. The light branch changes lightness only, by
 * mixing each colour toward the theme's own ink.
 */
const read = (rel: string): string =>
  readFileSync(resolve(process.cwd(), "src/styles/canvas", rel), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

describe("music node follows the page", () => {
  const css = read("music-node.css");

  it("derives its panels from the theme, not from a fixed blue-black", () => {
    expect(css).toMatch(/--music-panel:\s*color-mix\([^;]*--node-floor-solid/);
    expect(css).toMatch(/--music-panel-strong:\s*color-mix\([^;]*--node-floor-solid/);
  });

  it("keeps no opaque literal surface", () => {
    // Every `background` in this file must name a token. Drop shadows may stay literal — a shadow
    // is an absence of light in any palette — so only backgrounds are swept.
    const offenders = [...css.matchAll(/background(?:-color)?:\s*([^;]+);/g)]
      .map((m) => m[1].trim())
      .filter((v) => /oklch\(|#[0-9a-fA-F]{3,8}|rgba?\(\s*\d/.test(v.replace(/var\((?:[^()]|\([^()]*\))*\)/g, "")));
    expect(offenders, "derive from --node-floor-solid or the theme's ink").toEqual([]);
  });
});

describe("workflow node semantic ink", () => {
  const css = read("workflow-nodes.css");

  it("names every status and identity colour once, as a token", () => {
    for (const role of ["pass", "fail", "warn", "info", "critic", "team", "focus"]) {
      expect(css, `--wf-${role} is not declared`).toMatch(new RegExp(`--wf-${role}:`));
    }
  });

  it("has a light-mode branch that moves lightness, never hue", () => {
    const branch = css.match(
      /\.codecanvas-shell\[data-canvas-mode="light"\]\s+\.canvas-node\s*\{([^}]*)\}/,
    )?.[1];
    expect(branch, "no light branch — the ramp is unreadable on a light theme without it").toBeDefined();
    // Each override must be the SAME hex mixed toward the theme ink. A different hex here would
    // be a hue change, which is what the ADR forbids.
    for (const [, role, hex] of css.matchAll(/--wf-([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)) {
      expect(
        branch,
        `--wf-${role} light override must mix ${hex}, not another hue`,
      ).toMatch(new RegExp(`--wf-${role}:\\s*color-mix\\([^;]*${hex}[^;]*var\\(--canvas-text\\)`));
    }
  });

  it("leaves no bare status literal outside the token block", () => {
    // The literals used to be spelled out ~38 times. One place to change is the point.
    const afterTokens = css.slice(css.indexOf(".canvas-node {") + 1);
    const body = afterTokens.slice(afterTokens.indexOf("}"));
    const offenders = [...body.matchAll(/rgba\(\s*(?:52|248|251|96|165|56|186|139|124),[^)]*\)/g)].map(
      (m) => m[0],
    );
    expect(offenders, "use var(--wf-*) so the light branch reaches it").toEqual([]);
  });
});

/**
 * The ink blend, across every node stylesheet that carries hued text.
 *
 * Measured before the change, on the Garden of Dawn node body: 77 of 80 ink literals in these six
 * files were under 4.5:1, the worst at 1.01:1. Dark themes were fine, which is the whole reason
 * it survived — a reviewer on Void sees 6-10:1 everywhere.
 */
describe("node ink blend", () => {
  const FILES = [
    "agent-node.css",
    "agent-node-graph.css",
    "agent-node-plan-composer.css",
    "agent-node-persona-nl.css",
    "skills-node.css",
    "browser-node.css",
  ] as const;

  it("declares the switch once, with a light branch", () => {
    const shell = read("node-shell.css");
    expect(shell).toMatch(/--ink-blend:\s*100%/);
    expect(shell).toMatch(
      /\.codecanvas-shell\[data-canvas-mode="light"\]\s+\.canvas-node\s*\{[^}]*--ink-blend:\s*30%/,
    );
  });

  it.each(FILES.map((f) => [f] as const))("%s routes every hued ink through the blend", (file) => {
    const css = read(file);
    const offenders: string[] = [];
    for (const [, value] of css.matchAll(/(?<![-\w])color\s*:\s*([^;]*);/g)) {
      // Remove correctly blended inks, then any remaining var(), and see what literal survives.
      const rest = value
        .replace(
          /color-mix\(in oklab,\s*(?:#[0-9a-fA-F]{3,6}|rgba?\([^)]*\))\s*var\(--ink-blend\)[^)]*\)/g,
          "",
        )
        .replace(/var\((?:[^()]|\([^()]*\))*\)/g, "");
      for (const m of rest.matchAll(/#[0-9a-fA-F]{3,6}\b|rgba?\(\s*\d+[^)]*\)/g)) {
        offenders.push(m[0]);
      }
    }
    expect(
      offenders,
      "wrap the hue: color-mix(in oklab, <hue> var(--ink-blend), var(--canvas-text))",
    ).toEqual([]);
  });

  it("never puts the blend on a background or a border", () => {
    // Mixing a translucent tint toward an opaque ink RAISES its alpha — a 12% wash measured 74%
    // under the same blend, which turns a decorative tint into a slab. Measured, not reasoned.
    for (const file of FILES) {
      const css = read(file);
      for (const [decl] of css.matchAll(/(background[a-z-]*|border[a-z-]*)\s*:[^;]*;/g)) {
        expect(decl, `${file}: the blend is for \`color\` only`).not.toMatch(/--ink-blend/);
      }
    }
  });
});

/**
 * Status INK — the run-state ramp as text.
 *
 * The node-ink sweep above strips every var() before it looks for literals, so a bare
 * `color: var(--canvas-status-connecting)` passed it while measuring 1.57:1 on Garden of Dawn.
 * Text reads the `-ink` twin; dots, tints and borders keep the bare tone.
 */
describe("status ink", () => {
  const STATES = ["idle", "connecting", "running", "completed", "error", "blocked"] as const;
  const theme = read("theme.css");

  it("declares an ink twin per state, with a light branch that keeps the hue", () => {
    const branch = theme.match(/\.codecanvas-shell\[data-canvas-mode="light"\]\s*\{([^}]*)\}/)?.[1];
    expect(branch, "no light branch for status ink").toBeDefined();
    for (const s of STATES) {
      expect(theme).toMatch(new RegExp(`--canvas-status-${s}-ink:`));
      if (s === "idle") continue;
      expect(branch).toMatch(
        new RegExp(`--canvas-status-${s}-ink:\\s*color-mix\\(in oklab, var\\(--canvas-status-${s}\\)[^;]*var\\(--canvas-text\\)`),
      );
    }
  });

  it("never paints text with the bare tone", () => {
    const dir = resolve(process.cwd(), "src/styles/canvas");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".css"))) {
      const css = read(file);
      for (const [decl] of css.matchAll(/(?<![-\w])(?:color|--cc-mem-[a-z]+)\s*:[^;]*;/g)) {
        if (/--canvas-status-[a-z]+(?!-ink)[,)\s]/.test(decl.replace(/--canvas-status-[a-z]+-ink/g, ""))) {
          offenders.push(`${file}: ${decl}`);
        }
      }
    }
    expect(offenders, "use var(--canvas-status-<state>-ink) for text").toEqual([]);
  });
});
