/**
 * The standard emoji the Slack reaction picker offers, loaded on first use so the ~16 KB (gzip) list
 * is not part of the Connectors page. Data: `emoji-datasource` by Cal Henderson (iamcal), MIT license,
 * trimmed by `scripts/build-emoji-data.mjs`. Glyphs are the platform's own; no vendor images ship.
 */

export type StandardEmoji = {
  /** What Lotus saves: the first of Slack's short names. */
  name: string;
  /** Every short name Slack accepts for it (`+1`, `thumbsup`). */
  names: string[];
  glyph: string;
  category: number;
};

export type EmojiCatalog = {
  categories: string[];
  emoji: StandardEmoji[];
  /** Any short name → its glyph. */
  glyphs: Map<string, string>;
};

type EmojiData = { categories: string[]; emoji: [string, string[], number][] };

/** `1F468-200D-1F4BB` → the glyph those code points spell. */
function glyphOf(unified: string): string {
  return String.fromCodePoint(...unified.split("-").map((hex) => parseInt(hex, 16)));
}

export function buildCatalog(data: EmojiData): EmojiCatalog {
  const emoji = data.emoji.map(([unified, names, category]) => ({
    name: names[0],
    names,
    glyph: glyphOf(unified),
    category,
  }));
  const glyphs = new Map<string, string>();
  for (const e of emoji) for (const name of e.names) glyphs.set(name, e.glyph);
  return { categories: data.categories, emoji, glyphs };
}

let loading: Promise<EmojiCatalog> | null = null;

export function loadEmojiCatalog(): Promise<EmojiCatalog> {
  loading ??= import("../data/emoji-data.json").then((m) => buildCatalog(m.default as EmojiData));
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
