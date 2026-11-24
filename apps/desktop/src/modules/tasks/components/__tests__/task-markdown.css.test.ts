import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A checklist item must stay in normal inline flow.
 *
 * `display: flex` (or grid) on `li.task-list-item` turns every text run, `<strong>` and `<code>`
 * inside it into its own column. That shipped once and shredded real vault tickets — `/plans`
 * rendered one letter per line. jsdom does no layout, so the only way to hold the line is to read
 * the stylesheet.
 */
describe("tasks.css — checklist items", () => {
  const css = readFileSync(join(__dirname, "../../../../styles/tasks.css"), "utf8");

  it("never lays a task-list item out as flex or grid", () => {
    const blocks = [...css.matchAll(/([^{}]*li\.task-list-item[^{}]*)\{([^}]*)\}/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, selector, body] of blocks) {
      // Rules aimed at the checkbox itself are not the item's layout.
      if (/input/.test(selector)) continue;
      expect(body, selector.trim()).not.toMatch(/display\s*:\s*(inline-)?(flex|grid)/);
    }
  });
});
