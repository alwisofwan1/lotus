/**
 * The release notes in src/releases are read by three things: this site's changelog, the
 * GitHub Release body and the update feed (apps/desktop/scripts/release-notes.mjs). A bad
 * file breaks the changelog build or ships "TODO" to users, so check the shape here.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const DIR = `${import.meta.dirname}/../src/releases`;
const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));

describe("release notes", () => {
  it("exist", () => expect(files.length).toBeGreaterThan(0));

  it.each(files)("%s has version, date and a written title", (f) => {
    const text = readFileSync(`${DIR}/${f}`, "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    expect(fm).toMatch(new RegExp(`^version: ${f.replace(/\.md$/, "").replace(/\./g, "\\.")}$`, "m"));
    expect(fm).toMatch(/^date: \d{4}-\d{2}-\d{2}$/m);
    expect(fm).toMatch(/^title: .+$/m);
    expect(fm).not.toMatch(/TODO/);
    expect(text.slice(fm.length)).toMatch(/^### (New|Improved|Fixed)$/m);
  });
});
