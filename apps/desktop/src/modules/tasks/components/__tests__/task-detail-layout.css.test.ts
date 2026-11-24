import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * In a narrow detail panel Properties stacks above the ticket, and must scroll away with it.
 *
 * A container query adds no specificity, so the narrow `.tk-props { position: static }` only wins
 * if it comes AFTER the base `.tk-props { position: sticky }`. It came before: in a narrow panel
 * Properties stayed pinned at the top and the ticket scrolled underneath it, through its 4% ground
 * — the title, summary and toolbars drawn over the property rows (2026-10-25). jsdom does no
 * cascade, so the order is checked in the stylesheet.
 */
describe("tasks.css — Properties in a narrow panel", () => {
  const css = readFileSync(join(__dirname, "../../../../styles/tasks.css"), "utf8");

  it("unpins Properties after the rule that pins it", () => {
    const sticky = css.search(/\n\.tk-props \{[^}]*position: sticky/);
    const stat = css.search(/\.tk-props \{[^}]*position: static/);
    expect(sticky).toBeGreaterThan(-1);
    expect(stat).toBeGreaterThan(-1);
    expect(stat).toBeGreaterThan(sticky);
  });
});
