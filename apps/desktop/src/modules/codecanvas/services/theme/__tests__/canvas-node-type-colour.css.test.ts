import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Node-type identity colour has exactly one table, and three places have to agree with it.
 *
 * The Fleet panel used to draw every row icon in a single muted grey, so the list said what a row
 * was only in words while the board said it in colour. The icons now take their node type's colour
 * — which is only true as long as the Fleet, the node shell and the token table stay in step.
 *
 * That is the failure this guards. Three copies of "agent is this colour" is not a style question;
 * it is the same bug shape as the two `--canvas-sheet-ground` literals ("two literals are one edit
 * away from disagreeing"), and it goes wrong silently — a node and its row simply stop matching,
 * which no one notices until they are side by side.
 */

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const THEME = stripComments(read("src/styles/canvas/theme.css"));
const NODE_SHELL = stripComments(read("src/styles/canvas/node-shell.css"));
const FLEET = stripComments(read("src/styles/canvas/agent-node-graph.css"));
const PANEL = read("src/modules/codecanvas/components/CanvasFleetPanel.tsx");

/**
 * Every type the Fleet can render a row for, taken from TYPE_ICON in CanvasFleetPanel.tsx.
 * Read from the source rather than hardcoded, so adding a node type fails here instead of
 * shipping a row with no colour.
 */
function fleetRowTypes(): string[] {
  const block = PANEL.match(/const TYPE_ICON[\s\S]*?\n\};/)?.[0] ?? "";
  expect(block, "TYPE_ICON not found in CanvasFleetPanel.tsx").not.toBe("");
  return Array.from(block.matchAll(/^\s*"?([a-z-]+)"?:\s*</gm)).map((m) => m[1]);
}

describe("node-type identity colour", () => {
  const types = fleetRowTypes();

  it("finds the Fleet's row types", () => {
    // Guards the regex above: a silent empty list would make every assertion below vacuous.
    expect(types.length).toBeGreaterThanOrEqual(10);
    expect(types).toContain("agent");
    expect(types).toContain("terminal");
  });

  for (const type of types) {
    it(`declares --canvas-type-${type} in the canonical table`, () => {
      expect(
        new RegExp(`--canvas-type-${type}:`).test(THEME),
        `theme.css has no --canvas-type-${type}; the Fleet row for "${type}" would fall back to grey`,
      ).toBe(true);
    });

    it(`paints the Fleet's "${type}" mark from that token`, () => {
      const rule = FLEET.match(
        new RegExp(`\\.canvas-fleet-row\\[data-type="${type}"\\][^{]*\\{[^}]*\\}`),
      )?.[0];
      expect(rule, `no Fleet mark rule for type "${type}"`).toBeTruthy();
      expect(rule).toContain(`var(--canvas-type-${type})`);
    });
  }

  it("gives the Fleet row its data-type, or every rule above matches nothing", () => {
    expect(PANEL).toMatch(/data-type=\{row\.type\}/);
  });

  it("drives node accents from the same table, so a node and its row cannot disagree", () => {
    // Only the PRIMARY accent is asserted. --node-accent-soft / -line still carry their own
    // alphas per node type, which predates this table; re-deriving those is a design change,
    // not a de-duplication, and is deliberately out of scope here.
    const accents = Array.from(NODE_SHELL.matchAll(/\.canvas-([a-z-]+)-node\s*\{[^}]*?--node-accent:\s*([^;]+);/g));
    expect(accents.length).toBeGreaterThanOrEqual(10);
    for (const [, node, value] of accents) {
      expect(
        value,
        `.canvas-${node}-node sets --node-accent to "${value.trim()}" instead of a --canvas-type-* token — ` +
          `it will drift from the Fleet row that shares its type`,
      ).toContain("var(--canvas-type-");
    }
  });
});
