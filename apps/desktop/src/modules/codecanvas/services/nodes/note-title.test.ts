import { describe, expect, it } from "vitest";
import { deriveNoteTitle, formatNoteEditedAt, noteTaskProgress } from "./note-title";

describe("deriveNoteTitle", () => {
  it("takes the first non-empty line and strips heading markers", () => {
    expect(deriveNoteTitle("# To-Do List — Day 72 Stream\n\nDate: Day 72")).toBe("To-Do List — Day 72 Stream");
    expect(deriveNoteTitle("## Heading two")).toBe("Heading two");
  });

  it("strips list, task, and quote markers so the title reads as prose", () => {
    expect(deriveNoteTitle("- [ ] first task")).toBe("first task");
    expect(deriveNoteTitle("* [x] done task")).toBe("done task");
    expect(deriveNoteTitle("- bullet line")).toBe("bullet line");
    expect(deriveNoteTitle("> quoted line")).toBe("quoted line");
  });

  it("strips inline emphasis and code marks", () => {
    expect(deriveNoteTitle("**bold title**")).toBe("bold title");
    expect(deriveNoteTitle("_italic title_")).toBe("italic title");
    expect(deriveNoteTitle("`code` title")).toBe("code title");
  });

  it("skips leading blank lines", () => {
    expect(deriveNoteTitle("\n\n   Real first line\nsecond")).toBe("Real first line");
  });

  it("falls back to the persisted note number when there is no usable text", () => {
    expect(deriveNoteTitle("", 4)).toBe("Note 4");
    expect(deriveNoteTitle("   \n\n  ", 4)).toBe("Note 4");
    expect(deriveNoteTitle("###", 4)).toBe("Note 4");
    expect(deriveNoteTitle("")).toBe("Note");
  });

  it("caps pathological single-line notes so the header never carries a paragraph", () => {
    const title = deriveNoteTitle("x".repeat(400));
    expect(title.length).toBeLessThanOrEqual(120);
  });

  it("reads only the first line of a large note", () => {
    // A 200k-char note must not cost a full split()/scan just to label the header.
    const content = `# Title\n${"body line\n".repeat(20_000)}`;
    expect(deriveNoteTitle(content)).toBe("Title");
  });
});

describe("noteTaskProgress", () => {
  it("counts done and total checklist items", () => {
    expect(noteTaskProgress("- [x] a\n- [ ] b\n- [ ] c")).toEqual({ done: 1, total: 3 });
    expect(noteTaskProgress("* [X] upper case marker")).toEqual({ done: 1, total: 1 });
    expect(noteTaskProgress("Some prose here\n- [ ] a task")).toEqual({ done: 0, total: 1 });
  });

  it("reports zero for a note without a checklist", () => {
    expect(noteTaskProgress("hello world")).toEqual({ done: 0, total: 0 });
    expect(noteTaskProgress("")).toEqual({ done: 0, total: 0 });
  });
});

describe("formatNoteEditedAt", () => {
  const now = new Date(2026, 8, 30, 21, 30).getTime();

  it("says today or yesterday with the time", () => {
    expect(formatNoteEditedAt(new Date(2026, 8, 30, 9, 12).getTime(), now)).toMatch(/^Edited today at /);
    expect(formatNoteEditedAt(new Date(2026, 8, 29, 23, 59).getTime(), now)).toMatch(/^Edited yesterday at /);
  });

  it("names the agent when an agent wrote the change", () => {
    expect(formatNoteEditedAt(new Date(2026, 8, 30, 9, 12).getTime(), now, "Ivo")).toMatch(/^Edited by Ivo · today at /);
    expect(formatNoteEditedAt(new Date(2026, 8, 30, 9, 12).getTime(), now, "  ")).toMatch(/^Edited today at /);
  });

  it("falls back to the date, with the year only when it differs", () => {
    const earlier = formatNoteEditedAt(new Date(2026, 8, 2).getTime(), now);
    expect(earlier).toMatch(/^Edited /);
    expect(earlier).not.toContain("2026");
    expect(formatNoteEditedAt(new Date(2025, 0, 5).getTime(), now)).toContain("2025");
  });
});
