import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/canvas/note-node.css"), "utf8");

describe("Rich Markdown Note styles", () => {
  it("makes bullet and checklist markers visible inside the editor", () => {
    expect(css).toMatch(/\.canvas-note-editor ul:not\(\[data-type="taskList"\]\)\s*\{[\s\S]*?list-style:\s*disc;/);
    expect(css).toMatch(/\.canvas-note-editor ul\[data-type="taskList"\],[\s\S]*?\.canvas-note-editor \.canvas-note-task-list\s*\{[\s\S]*?list-style:\s*none;/);
  });

  it("aligns task checkboxes with their text and uses a custom checked state", () => {
    expect(css).toMatch(/\.canvas-note-editor \.canvas-note-task-list > li,[\s\S]*?ul\[data-type="taskList"\] > li\s*\{[\s\S]*?display:\s*grid;/);
    expect(css).toMatch(/grid-template-columns:\s*1\.25rem minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.canvas-note-editor \.canvas-note-task-list > li > label input,[\s\S]*?ul\[data-type="taskList"\] > li > label input\s*\{[\s\S]*?appearance:\s*none;/);
    expect(css).toMatch(/\.canvas-note-editor \.canvas-note-task-list > li > label input:checked::after/);
  });
});
