import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CSS-only guards for the Skills browser node. jsdom applies no stylesheet, so the component
 * tests happily pass against classes that have no rule at all — which is exactly how an
 * unstyled panel ships. Same rationale as canvas-command-sheet.css.test.ts.
 */
const css = readFileSync(resolve(process.cwd(), "src/styles/canvas/skills-node.css"), "utf8");
const index = readFileSync(resolve(process.cwd(), "src/styles/canvas/index.css"), "utf8");

/** The rule for EXACTLY this selector — line-anchored so a descendant rule cannot match. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match, `no rule for ${selector}`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("skills node CSS", () => {
  it("is imported by the canvas stylesheet entry", () => {
    expect(index).toContain("skills-node.css");
  });

  it("lays the body out as a master-detail split", () => {
    const split = rule(".canvas-skills-split");
    expect(split).toContain("display: grid");
    expect(split).toContain("grid-template-columns");
  });

  it("collapses the reader on a narrow NODE, not a narrow window", () => {
    // A media query here would key off the browser window and never fire — the node is
    // resized by the user inside a fixed-size app window.
    expect(rule(".canvas-skills-node-body")).toContain("container-type: inline-size");
    expect(css).toMatch(/@container[^{]*\{[\s\S]*?\.canvas-skills-detail\s*\{\s*display:\s*none/);
  });

  it("keeps the search bar and the reader header from scrolling away", () => {
    expect(rule(".canvas-skills-searchbar")).toContain("flex-shrink: 0");
    expect(rule(".canvas-skills-detail-head")).toContain("flex-shrink: 0");
  });

  it("scrolls the list column rather than growing the node", () => {
    const list = rule(".canvas-skills-node-list");
    expect(list).toContain("overflow-y: auto");
    expect(list).toContain("min-height: 0");
  });

  it("clips the list column instead of letting a long row paint over the reader", () => {
    // A grid item defaults to min-width:auto — without both of these a long description
    // widened the track and spilled across the reader pane. Seen in a rendered proof.
    const list = rule(".canvas-skills-node-list");
    expect(list).toContain("min-width: 0");
    expect(list).toContain("overflow-x: hidden");
  });

  it("keeps rows to a single dense line", () => {
    // The old row was a two-line column (~44px). Baseline-aligned flex halves that.
    const row = rule(".canvas-skill-row");
    expect(row).toContain("align-items: baseline");
    expect(row).not.toContain("flex-direction: column");
  });

  it("wraps the description onto its own line in search mode only", () => {
    // Measured in a rendered proof: inline, it got ~80px of a 256px column.
    expect(rule(".canvas-skill-row--detailed")).toContain("flex-wrap: wrap");
    expect(css).toContain(".canvas-skill-row--detailed .canvas-skill-desc");
  });

  it("truncates a long skill name instead of running it into the row's trailing marker", () => {
    // `flex: 0 1 auto` does not shrink a nowrap span without min-width: 0. Seen in a proof:
    // `$remotion-best-practices` collided with the applied marker.
    const name = rule(".canvas-skill-name");
    expect(name).toContain("min-width: 0");
    expect(name).toContain("text-overflow: ellipsis");
    expect(name).toContain("overflow: hidden");
  });

  it("does not dim an applied row — it is still usable, not disabled", () => {
    // The old rule put the whole row at opacity 0.55, which read as unavailable; only the name
    // is tinted now, and nothing about an applied row is switched off.
    expect(css).not.toContain(".canvas-skill-row-wrap--applied");
    expect(css).toContain('.canvas-skill-row-wrap[data-applied="true"] .canvas-skill-name');
  });

  it("keeps the applied marker quieter than the skill name it annotates", () => {
    const marker = rule(".canvas-skill-applied");
    expect(marker).not.toContain("text-transform: uppercase");
    expect(marker).not.toContain("font-weight: 700");
    expect(marker).toContain("cursor: pointer");
  });

  it("shows the applied marker whether or not the row is hovered", () => {
    // It is state, not an action affordance, so it must stay out of the hidden-until-hover set
    // that the grip and the apply button belong to.
    const hidden = rule(".canvas-skill-grip,\n.canvas-skill-apply");
    expect(hidden).toContain("opacity: 0");
    expect(hidden).not.toContain("canvas-skill-applied");
  });

  it("marks the active row so keyboard navigation is visible", () => {
    expect(css).toContain('.canvas-skill-row-wrap[data-active="true"]');
  });

  it("gives the drag grip its own cursor, separate from the row's", () => {
    // One element for click AND drag is what made a 5px slip apply a skill by accident.
    expect(rule(".canvas-skill-grip")).toContain("cursor: grab");
    expect(rule(".canvas-skill-row")).toContain("cursor: pointer");
  });

  it("reveals the row actions on hover or selection instead of leaving them always-on", () => {
    expect(css).toMatch(/\.canvas-skill-row-wrap:hover \.canvas-skill-apply/);
    expect(css).toMatch(/\.canvas-skill-row-wrap\[data-active="true"\] \.canvas-skill-apply/);
  });

  it("styles the filter chips' pressed state — the only cue that a filter is on", () => {
    expect(css).toContain('.canvas-skills-filter[aria-pressed="true"]');
  });

  it("shares the SKILL.md reader surface with the standalone skill node", () => {
    expect(css).toContain(".canvas-skills-detail-body .wbmd-scroll");
    expect(css).toContain(".canvas-skills-detail-body .wbmd-article");
  });
});
