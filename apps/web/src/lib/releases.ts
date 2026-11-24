/**
 * The desktop releases, newest first, from `src/releases/<version>.md`.
 *
 * Those files are the single source for a release's notes: `release:mac` puts the same file
 * in the GitHub Release and the update feed (apps/desktop/scripts/release-notes.mjs), and a
 * push of a new one redeploys this site through the web workflow's path filter.
 */
import type { MarkdownInstance } from "astro";

/** YAML reads an unquoted `date: 2026-11-07` as a Date, so it is normalised below. */
type Meta = { version: string; date: string | Date; title: string };

const files = import.meta.glob<MarkdownInstance<Meta>>("../releases/*.md", { eager: true });

const key = (v: string) => v.split(".").map(Number);
const newer = (a: string, b: string) => {
  const [pa, pb] = [key(a), key(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
};

export const releases = Object.values(files)
  .map((f) => ({
    ...f.frontmatter,
    date: new Date(f.frontmatter.date).toISOString().slice(0, 10),
    Content: f.Content,
    html: f.compiledContent,
  }))
  .sort((a, b) => newer(a.version, b.version));

export const releaseUrl = (version: string) => `https://github.com/alwisofwan1/lotus/releases/tag/v${version}`;
