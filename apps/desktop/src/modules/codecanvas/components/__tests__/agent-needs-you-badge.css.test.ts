import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const personaCss = readFileSync(
  resolve(process.cwd(), "src/styles/canvas/agent-node-persona-nl.css"),
  "utf8",
);

/** `oklch(L C H)` → L, as a 0..1 number. */
function lightnessOf(declaration: string): number {
  const match = declaration.match(/oklch\(\s*([0-9.]+)/);
  if (!match) throw new Error(`not an oklch colour: ${declaration}`);
  return Number(match[1]);
}

function badgeColour(state: string): string {
  const pattern = new RegExp(
    `\\.canvas-persona-badge\\[data-s="${state}"\\]\\s*\\{[^}]*--badge-status:\\s*([^;]+);`,
  );
  const match = personaCss.match(pattern);
  if (!match) throw new Error(`no --badge-status rule for data-s="${state}"`);
  return match[1].trim();
}

describe("the needs-you badge", () => {
  it("has its own colour rather than borrowing another state's", () => {
    // `toneToStatus` maps `needs-you` to `ask`. Without a rule the badge falls through the
    // `--badge-status` chain to the idle grey, and a blocked agent would look like a resting one.
    expect(() => badgeColour("ask")).not.toThrow();
  });

  it("does not reuse the running or booting colour", () => {
    // It must not read as progress. `run` is white and `boot` is amber; sharing either would put
    // "waiting for you" in the visual language of "working".
    const ask = badgeColour("ask");
    expect(ask).not.toBe(badgeColour("run"));
    expect(ask).not.toBe(badgeColour("boot"));
  });

  it("is light enough to stay legible on the video-backed glass themes", () => {
    // The card sits over photographic backdrops (builtin-themes.ts:350) as well as flat dark ones,
    // so the badge cannot rely on a known background. Following the WCAG-assertion habit already
    // established in theme/note-paper-contrast.test.ts and theme/__tests__/terminal-floor.test.ts,
    // the reference is an independent one: the dimmest ATTENTION-bearing colour this surface
    // already ships as legible, which is the `fail` red. `idle` is excluded on purpose — being
    // recessive is that state's whole job, so it sets no floor for a badge that must be noticed.
    expect(lightnessOf(badgeColour("ask"))).toBeGreaterThanOrEqual(lightnessOf(badgeColour("fail")));
  });

  it("is clearly lighter than the resting state, so it cannot read as idle", () => {
    // The failure this guards is subtle and silent: a violet dark enough to sit near the idle grey
    // would leave a blocked agent looking exactly like a resting one on a busy board.
    expect(lightnessOf(badgeColour("ask")) - lightnessOf(badgeColour("idle"))).toBeGreaterThan(0.2);
  });

  it("never animates — a spinner over \"answer me\" is the lie being fixed", () => {
    const askBlock = personaCss.match(/\.canvas-persona-badge\[data-s="ask"\][^}]*\}/)?.[0] ?? "";
    expect(askBlock).not.toMatch(/animation|transition/);
  });
});
