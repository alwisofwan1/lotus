import { beforeEach, describe, expect, it } from "vitest";

import { DRAFTS_CHANGED, draftPreview, draftThreadIds, pruneComposerDrafts, readComposerDraft, writeComposerDraft } from "../composer-draft";

const draft = (text: string) => ({ doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }, attachments: [] });

describe("composer drafts", () => {
  beforeEach(() => localStorage.clear());

  it("removes a draft once nothing is typed, attached or picked", () => {
    writeComposerDraft("t1", draft("hi"));
    expect(readComposerDraft("t1")?.doc).toBeTruthy();
    writeComposerDraft("t1", { doc: null, attachments: [], skill: null });
    expect(localStorage.getItem("lotus.chat.draft.t1")).toBeNull();
  });

  it("prunes drafts of threads that are gone, keeping live threads, Start drafts and other keys", () => {
    writeComposerDraft("live", draft("a"));
    writeComposerDraft("gone", draft("b"));
    writeComposerDraft("start:home", draft("c"));
    localStorage.setItem("lotus.chat.new", "{}");
    pruneComposerDrafts(["live"]);
    expect(readComposerDraft("live")).not.toBeNull();
    expect(readComposerDraft("gone")).toBeNull();
    expect(readComposerDraft("start:home")).not.toBeNull();
    expect(localStorage.getItem("lotus.chat.new")).toBe("{}");
  });

  it("tells the rail only when a draft starts or stops, not on every keystroke", () => {
    let fired = 0;
    const count = () => fired++;
    window.addEventListener(DRAFTS_CHANGED, count);
    writeComposerDraft("t1", draft("h"));
    writeComposerDraft("t1", draft("hi"));
    writeComposerDraft("start:home", draft("x"));
    expect(fired).toBe(2);
    expect([...draftThreadIds()]).toEqual(["t1"]);
    writeComposerDraft("t1", { doc: null, attachments: [] });
    expect(fired).toBe(3);
    window.removeEventListener(DRAFTS_CHANGED, count);
  });

  it("previews the skill, the text with chips as labels, and the files", () => {
    const doc = { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "look at " }, { type: "mention", attrs: { kind: "file", label: "Rail.tsx", text: "/w/Rail.tsx" } }] },
      { type: "paragraph", content: [{ type: "text", text: "then   fix" }] },
    ] };
    const file = { kind: "file" as const, path: "/a", name: "a", mimeType: null, sizeBytes: 1 };
    const skill = { kind: "skill" as const, name: "tdd", description: "", argumentHint: null, source: null, path: null };
    expect(draftPreview({ doc, attachments: [file], skill })).toBe("/tdd look at Rail.tsx then fix · 1 file");
    expect(draftPreview({ doc: null, attachments: [file, file] })).toBe("2 files");
    expect(draftPreview({ doc: draft("x".repeat(80)).doc, attachments: [] })).toHaveLength(60);
  });

  it("reads a corrupt draft as none", () => {
    localStorage.setItem("lotus.chat.draft.bad", "{not json");
    expect(readComposerDraft("bad")).toBeNull();
  });
});
