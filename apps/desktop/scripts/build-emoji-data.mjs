// Builds src/modules/connectors/data/emoji-data.json, the standard emoji the Slack reaction picker
// offers: short names Slack accepts, one native glyph each (no vendor images are shipped).
//
// Source: `emoji-datasource` by Cal Henderson (iamcal), MIT license
// https://github.com/iamcal/emoji-data. Run: bun scripts/build-emoji-data.mjs <path to its emoji.json>
import { readFileSync, writeFileSync } from "node:fs";

const source = process.argv[2];
if (!source) {
  console.error("usage: bun scripts/build-emoji-data.mjs <path to emoji-datasource/emoji.json>");
  process.exit(1);
}

const all = JSON.parse(readFileSync(source, "utf8")).filter((e) => e.category !== "Component");
all.sort((a, b) => a.sort_order - b.sort_order);

const categories = [...new Set(all.map((e) => e.category))];
// [unified codepoints, short names (Slack accepts every one), category index]
const emoji = all.map((e) => [e.unified, e.short_names, categories.indexOf(e.category)]);

const out = new URL("../src/modules/connectors/data/emoji-data.json", import.meta.url);
writeFileSync(out, JSON.stringify({ categories, emoji }));
console.log(`${emoji.length} emoji, ${categories.length} categories`);
