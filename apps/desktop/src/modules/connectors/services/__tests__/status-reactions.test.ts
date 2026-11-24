import { describe, expect, it } from "vitest";

import type { SlackEmojiView } from "../connectors-api";
import { buildCatalog } from "../emoji-catalog";
import { cleanNames, emojiName, emojiPreview, lookupEmoji, namesText, parseNames, sameReactions } from "../status-reactions";

const base = {
  taken: "eyes",
  queued: "",
  running: "",
  done: "",
  failed: "",
  asked: "",
  skipped: "",
  sent: { looksGood: [], questions: [], changesNeeded: [] },
};

const catalog = buildCatalog({
  categories: ["Smileys & Emotion", "People & Body"],
  emoji: [
    ["1F440", ["eyes"], 0],
    ["1F44D", ["+1", "thumbsup"], 1],
    ["1F468-200D-1F4BB", ["man_technologist"], 1],
  ],
});
const custom: SlackEmojiView = {
  state: "ok",
  emoji: [
    { name: "shipit", url: "https://emoji.slack-edge.com/T1/shipit/a.png", aliasOf: null },
    { name: "thumb", url: null, aliasOf: "thumbsup" },
  ],
};

describe("status reactions", () => {
  it("writes a name the way Slack does", () => {
    expect(emojiName("  :White_Check_Mark: ")).toBe("white_check_mark");
  });

  it("builds glyphs from code points, for every short name", () => {
    expect(catalog.glyphs.get("thumbsup")).toBe("👍");
    expect(catalog.glyphs.get("+1")).toBe("👍");
    expect(catalog.glyphs.get("man_technologist")).toBe("👨‍💻");
  });

  it("previews a standard name as its glyph, any other as :name:, and nothing as empty", () => {
    expect(emojiPreview(":eyes:", catalog)).toBe("👀");
    expect(emojiPreview("party-parrot", catalog, custom)).toBe(":party-parrot:");
    expect(emojiPreview("  ", catalog)).toBe("");
  });

  it("finds a custom emoji's image, and an alias of a standard one as that glyph", () => {
    expect(lookupEmoji("shipit", catalog, custom)).toEqual({ url: custom.emoji[0].url, known: true });
    expect(lookupEmoji("thumb", catalog, custom)).toEqual({ glyph: "👍", known: true });
  });

  it("accepts a skin tone on a standard name", () => {
    expect(lookupEmoji("thumbsup::skin-tone-2", catalog, custom)).toEqual({ glyph: "👍", known: true });
  });

  it("calls a name unknown only when both lists are known and it is in neither", () => {
    expect(lookupEmoji("tada2", catalog, custom).known).toBe(false);
    expect(lookupEmoji("tada2", null, custom).known).toBeNull();
    expect(lookupEmoji("tada2", catalog, null).known).toBeNull();
    // Without emoji:read the workspace's emoji are hidden, so a non-standard name may still be right.
    expect(lookupEmoji("tada2", catalog, { state: "missing_scope", emoji: [] }).known).toBeNull();
  });

  it("compares names the way they will be saved", () => {
    expect(sameReactions(base, { ...base, taken: ":Eyes:" })).toBe(true);
    expect(sameReactions(base, { ...base, done: "tada" })).toBe(false);
  });

  it("compares a verdict's emoji cleaned, without blanks or repeats", () => {
    const withSent = (changesNeeded: string[]) => ({ ...base, sent: { ...base.sent, changesNeeded } });
    expect(sameReactions(withSent(["man-bowing"]), withSent([":Man-Bowing:", "man-bowing", ""]))).toBe(true);
    expect(sameReactions(base, withSent(["man-bowing"]))).toBe(false);
  });

  it("keeps a typed space so the next name can follow", () => {
    expect(parseNames("eyes ")).toEqual(["eyes", ""]);
    expect(namesText(parseNames("eyes "))).toBe("eyes ");
    expect(parseNames("eyes, man-bowing")).toEqual(["eyes", "man-bowing"]);
    expect(parseNames("")).toEqual([]);
    expect(cleanNames(["eyes", "", ":Eyes:", "man-bowing"])).toEqual(["eyes", "man-bowing"]);
  });
});
