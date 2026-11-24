import { describe, expect, it } from "vitest";

import { outsideReadRules, userContent } from "../claude-session";

const image = { kind: "image" as const, path: "/a/shot.png", name: "shot.png", mimeType: "image/png", sizeBytes: 3 };
const file = { kind: "file" as const, path: "/a/notes.pdf", name: "notes.pdf", mimeType: null, sizeBytes: 12 };

describe("userContent", () => {
  it("stays a plain string without attachments", () => {
    expect(userContent("hi", [])).toBe("hi");
  });

  it("sends images as pictures, other files by path, and the text last", () => {
    const blocks = userContent("what is this?", [image, file], () => Buffer.from("png"));
    expect(blocks).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "cG5n" } },
      { type: "text", text: "[Attached file notes.pdf (12 bytes). It is on disk at /a/notes.pdf — use the Read tool to view it.]" },
      { type: "text", text: "what is this?" },
    ]);
  });

  it("sends attachments alone when there is no text", () => {
    expect(userContent("  ", [file], () => Buffer.from(""))).toHaveLength(1);
  });
});

describe("outsideReadRules", () => {
  const isDir = (path: string) => ({ "/x/notes.pdf": false, "/x/docs": true, "/a/notes.pdf": false })[path] ?? null;

  it("allows reading what the message names outside the folder: a file alone, a folder whole", () => {
    expect(outsideReadRules("see `/x/notes.pdf` and `/x/docs/`", [], "/w/repo", isDir)).toEqual(["Read(//x/notes.pdf)", "Read(//x/docs/**)"]);
    expect(outsideReadRules("", [file, image], "/w/repo", isDir)).toEqual(["Read(//a/notes.pdf)"]);
  });

  it("leaves paths inside the folder, missing paths, and rule-breaking characters alone", () => {
    expect(outsideReadRules("`/w/repo/a.ts` `/w/repo` `/gone.txt` `/x/(odd)` `src/a.ts`", [], "/w/repo/", isDir)).toEqual([]);
    expect(outsideReadRules("`/w/repo-other/x`", [], "/w/repo", () => false)).toEqual(["Read(//w/repo-other/x)"]);
  });
});
