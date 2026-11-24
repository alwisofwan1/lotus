import { describe, expect, it } from "vitest";
import {
  classifyIntake,
  isEditableTarget,
  isNoteEditorTarget,
  isTerminalFocusTarget,
  resolveIntakeImages,
  resolveIntakePayload,
  type IntakeSource,
} from "../canvas-intake";

function source(partial: Partial<IntakeSource> & { strings?: Record<string, string> }): IntakeSource {
  const strings = partial.strings ?? {};
  return {
    types: partial.types ?? [],
    files: partial.files ?? [],
    paths: partial.paths,
    getString: (type: string) => strings[type] ?? "",
  };
}

describe("isNoteEditorTarget", () => {
  it("is true for an element inside a Note rich editor (image paste should embed there)", () => {
    const editor = document.createElement("div");
    editor.className = "canvas-note-editor";
    const child = document.createElement("span");
    editor.appendChild(child);
    expect(isNoteEditorTarget(editor)).toBe(true);
    expect(isNoteEditorTarget(child)).toBe(true);
  });

  it("is false for a terminal's xterm textarea or a bare element (image paste becomes a shape)", () => {
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    expect(isNoteEditorTarget(ta)).toBe(false);
    expect(isNoteEditorTarget(document.createElement("div"))).toBe(false);
    expect(isNoteEditorTarget(null)).toBe(false);
  });
});

describe("isTerminalFocusTarget", () => {
  it("is true for the focused xterm textarea (a paste should go to the terminal, not a shape)", () => {
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    xterm.appendChild(ta);
    expect(isTerminalFocusTarget(ta)).toBe(true);
    expect(isTerminalFocusTarget(xterm)).toBe(true);
  });

  it("is false for a note editor or a bare element (paste there becomes a shape)", () => {
    const note = document.createElement("div");
    note.className = "canvas-note-editor";
    expect(isTerminalFocusTarget(note)).toBe(false);
    expect(isTerminalFocusTarget(document.createElement("div"))).toBe(false);
    expect(isTerminalFocusTarget(null)).toBe(false);
  });
});

describe("classifyIntake", () => {
  it("classifies an OS-dropped image path as image-paths", () => {
    expect(classifyIntake(source({ paths: ["/Users/a/shot.PNG"] }))).toEqual({
      kind: "image-paths",
      paths: ["/Users/a/shot.PNG"],
    });
  });

  it("classifies an OS-dropped non-image path as file-paths", () => {
    expect(classifyIntake(source({ paths: ["/Users/a/data.csv"] }))).toEqual({
      kind: "file-paths",
      paths: ["/Users/a/data.csv"],
    });
  });

  it("keeps only image paths when a drop mixes images and other files", () => {
    expect(classifyIntake(source({ paths: ["/a/x.png", "/a/y.txt"] }))).toEqual({
      kind: "image-paths",
      paths: ["/a/x.png"],
    });
  });

  it("classifies pasted image File handles as image-files (bytes unread)", () => {
    const png = new File(["x"], "screenshot.png", { type: "image/png" });
    const result = classifyIntake(source({ files: [png] }));
    expect(result.kind).toBe("image-files");
    expect(result.kind === "image-files" && result.files[0].name).toBe("screenshot.png");
  });

  it("reads a URL from text/uri-list, ignoring comment lines", () => {
    expect(
      classifyIntake(source({ types: ["text/uri-list"], strings: { "text/uri-list": "# comment\nhttps://example.com\n" } })),
    ).toEqual({ kind: "url", url: "https://example.com" });
  });

  it("treats URL-looking plain text as a url, other text as text", () => {
    expect(classifyIntake(source({ strings: { "text/plain": "https://x.dev/path" } }))).toEqual({
      kind: "url",
      url: "https://x.dev/path",
    });
    expect(classifyIntake(source({ strings: { "text/plain": "just some notes" } }))).toEqual({
      kind: "text",
      text: "just some notes",
    });
  });

  it("returns none when nothing recognizable is present", () => {
    expect(classifyIntake(source({}))).toEqual({ kind: "none" });
  });
});

describe("isEditableTarget", () => {
  it("is true for textarea/input and false otherwise", () => {
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("resolveIntakeImages", () => {
  it("reads File handles into base64 bytes refs", async () => {
    const file = new File(["abc"], "a.png", { type: "image/png" });
    const refs = await resolveIntakeImages([file]);
    expect(refs[0]).toEqual({ kind: "bytes", name: "a.png", mime: "image/png", base64: "YWJj" });
  });
});

describe("resolveIntakePayload", () => {
  it("maps image-paths to path image refs", async () => {
    expect(await resolveIntakePayload({ kind: "image-paths", paths: ["/a/x.png"] })).toEqual({
      kind: "image",
      images: [{ kind: "path", path: "/a/x.png" }],
    });
  });

  it("maps file-paths, url, text, and none straight through", async () => {
    expect(await resolveIntakePayload({ kind: "file-paths", paths: ["/a/y.csv"] })).toEqual({ kind: "file", paths: ["/a/y.csv"] });
    expect(await resolveIntakePayload({ kind: "url", url: "https://z" })).toEqual({ kind: "url", url: "https://z" });
    expect(await resolveIntakePayload({ kind: "text", text: "hi" })).toEqual({ kind: "text", text: "hi" });
    expect(await resolveIntakePayload({ kind: "none" })).toEqual({ kind: "none" });
  });
});
