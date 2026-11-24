import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CSS-only guards for the ⌘K sheet. Component tests cannot see these: jsdom applies no
 * stylesheet, so a class rendered without a matching rule passes every DOM assertion and ships
 * an unstyled panel — which is exactly what a stale Turbopack CSS bundle looked like when this
 * sheet was first run in the app. Same rationale as canvas-fleet-rail.css.test.ts.
 */
const css = readFileSync(resolve(process.cwd(), "src/styles/canvas/canvas-command-sheet.css"), "utf8");
const index = readFileSync(resolve(process.cwd(), "src/styles/canvas/index.css"), "utf8");

/**
 * The rule for EXACTLY this selector. The `\s*\{` anchor is load-bearing: a loose match let
 * `.canvas-sheet-row[data-group="send"]` find the descendant rule
 * `.canvas-sheet-row[data-group="send"] .canvas-sheet-row-tag` instead, so the assertions ran
 * against the wrong block and reported a missing property that was in fact present.
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match, `no rule for ${selector}`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("command sheet CSS", () => {
  it("is imported by the canvas stylesheet entry, or the whole sheet renders unstyled", () => {
    // The failure this catches has no other symptom: every test passes and the panel arrives in
    // the app as raw HTML with a browser-default yellow <mark>.
    expect(index).toMatch(/@import\s+"\.\/canvas-command-sheet\.css";/);
  });

  it("has a rule for every class the component renders", () => {
    const tsx = readFileSync(
      resolve(process.cwd(), "src/modules/codecanvas/components/CanvasCommandSheet.tsx"),
      "utf8",
    );
    const used = new Set(
      Array.from(tsx.matchAll(/className="(canvas-sheet[a-z-]*)"/g)).map((m) => m[1]),
    );
    expect(used.size).toBeGreaterThan(4);
    for (const cls of used) {
      expect(css, `.${cls} is rendered but has no CSS rule`).toContain(`.${cls}`);
    }
  });

  it("pins the send row so the NL escape hatch is never below the fold", () => {
    // With a full result list the send row scrolled out of sight — the one row that must always be
    // reachable is the one that bypasses the catalog entirely.
    const send = rule('.canvas-sheet-row[data-group="send"]');
    expect(send).toMatch(/position:\s*sticky/);
    expect(send).toMatch(/bottom:/);
    // It must carry its own OPAQUE ground, or the rows scrolling beneath it read through.
    expect(send).toMatch(/background-color:\s*var\(--canvas-sheet-ground/);
  });

  it("declares the ground token on the sheet itself, so both layers agree", () => {
    // Was a literal hex, and the opacity floor it guarded still holds — by contract now rather
    // than by literal. --node-floor-solid is resolveTerminalFloor's output, which is formatted
    // `rgb(r, g, b)` and can carry no alpha; note-paper-contrast.test.ts asserts exactly that
    // shape for every built-in ("resolves an opaque floor"). The fallback stays an opaque hex,
    // so an unthemed shell is covered too.
    //
    // It had to stop being a literal: the PINNED send row paints this ground with no tint over
    // it, so on a light theme the literal #16151d rendered a near-black bar with dark red text
    // under a cream sheet. The panel never showed the bug because its 88% surface tint covered
    // the literal almost completely.
    expect(rule(".canvas-sheet")).toMatch(
      /--canvas-sheet-ground:\s*var\(--node-floor-solid,\s*#[0-9a-fA-F]{6}\s*\)/,
    );
  });

  it("layers an active pinned row's tint over that ground instead of replacing it", () => {
    // `background:` shorthand on a sticky row would drop the opaque colour — a subtle bug that
    // only appears once the list is long enough to scroll under it.
    const active = css.match(
      /\.canvas-sheet-row\[data-group="send"\]:hover,[\s\S]*?\{[\s\S]*?\}/,
    )?.[0] ?? "";
    expect(active).toMatch(/background-image:/);
    expect(active).not.toMatch(/background:\s/);
  });

  it("caps its own height so a long catalog scrolls instead of growing off-screen", () => {
    expect(rule(".canvas-sheet")).toMatch(/max-height:\s*min\(/);
    expect(rule(".canvas-sheet-list")).toMatch(/overflow-y:\s*auto/);
  });

  it("neutralises the browser-default mark highlight", () => {
    // An unstyled <mark> is the loudest tell of a missing stylesheet; the styled one is an accent
    // colour on transparent, never a yellow block.
    expect(rule(".canvas-sheet-row-title mark")).toMatch(/background:\s*transparent/);
  });
});

describe("command sheet density (ultra-minimal revamp, 2026-08-28)", () => {
  it("sets the title and detail on ONE baseline, not stacked", () => {
    // The row was two stacked lines at ~44px; the second line is where the weight went. A flex row
    // on a shared baseline is what makes the detail read as a suffix rather than a paragraph.
    const body = rule(".canvas-sheet-row-body");
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/align-items:\s*baseline/);
    expect(body).not.toMatch(/display:\s*grid/);
  });

  it("lets the detail surrender its width before the title does", () => {
    // The title is the row's identity; on a narrow bar the detail must be the thing that truncates.
    expect(rule(".canvas-sheet-row-title")).toMatch(/flex:\s*0 1 auto/);
    expect(rule(".canvas-sheet-row-detail")).toMatch(/flex:\s*1 1 auto/);
  });

  it("keeps the category tag the quietest thing on a row, and only lifts it when active", () => {
    // GO / GO / GO down a column of project switches is repetition, not information.
    const tag = rule(".canvas-sheet-row-tag");
    expect(tag).toMatch(/--canvas-text-muted\)?\s*38%/);
    expect(css).toMatch(/\[data-active="true"\] \.canvas-sheet-row-tag \{[\s\S]*?--canvas-accent/);
  });

  it("fades the foot of the browse list instead of slicing a row in half", () => {
    // A hard cap cut the last visible row mid-height, which reads as broken rather than scrollable.
    expect(css).toMatch(/\.canvas-sheet\[data-mode="browse"\] \.canvas-sheet-list \{[\s\S]*?mask-image/);
  });

  it("does NOT fade the search list, where the last row is the pinned send row", () => {
    // Fading it would dim the one row that must always stay legible.
    const fade = css.match(/mask-image[^;]*;/g) ?? [];
    expect(fade).toHaveLength(1);
    // Anchored at line start: an unanchored `.canvas-sheet-list {` also matches the tail of the
    // browse-scoped selector above, so the check would pass on the very rule it means to exclude.
    expect(css).not.toMatch(/^\.canvas-sheet-list\s*\{[^}]*mask-image/m);
  });

  it("follows the theme's body face rather than inheriting the bar's serif voice", () => {
    // The bar's italic serif is for the user's own words; UI rows are not the user's words.
    expect(rule(".canvas-sheet")).toMatch(/font-family:\s*var\(--canvas-font-body/);
  });
});
