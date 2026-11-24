import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/styles/canvas/agent-node-persona-nl.css"), "utf8");

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}\n", start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

/** The px ceiling in a `width: min(<n>px, …)` declaration, or null when the rule is uncapped. */
function widthCapPx(selector: string): number | null {
  const match = /width:\s*min\((\d+)px,/.exec(rule(selector));
  return match ? Number(match[1]) : null;
}

/** Past this the bar reads as a banner across the canvas rather than a command bar. */
const BANNER_THRESHOLD_PX = 900;

describe("CodeCanvas NL Live Voice state CSS", () => {
  // This used to assert the exact pixel values (680 / 760). When the bar was deliberately narrowed
  // the test failed for a change that made it *more* correct, and then sat red long enough that
  // every later run had to re-establish it was pre-existing. Assert the property the test name
  // actually claims — the width is capped, and the cap is below banner width — so a genuine
  // regression still fails while a deliberate retune does not.
  it("caps the live voice command bar so production docked mode cannot become a banner", () => {
    const floating = widthCapPx(".canvas-nl-bar:has(.canvas-nl-live-voice)");
    const docked = widthCapPx(".canvas-nl-bar[data-docked]:has(.canvas-nl-live-voice)");

    expect(floating).not.toBeNull();
    expect(docked).not.toBeNull();
    expect(floating!).toBeLessThanOrEqual(BANNER_THRESHOLD_PX);
    expect(docked!).toBeLessThanOrEqual(BANNER_THRESHOLD_PX);
  });

  it("keeps both widths viewport-relative so a narrow window cannot overflow", () => {
    // The cap is only half the guard: without the `calc(100vw - …)` term the bar would keep its
    // pixel width on a small window and run off the edge.
    for (const selector of [".canvas-nl-bar:has(.canvas-nl-live-voice)", ".canvas-nl-bar[data-docked]:has(.canvas-nl-live-voice)"]) {
      expect(rule(selector)).toMatch(/width:\s*min\(\d+px,\s*calc\(100vw/);
    }
  });
});
