#!/usr/bin/env node
// Release notes and version bumps, from Conventional Commits since the last release.
//
//   bun scripts/release-notes.mjs draft [x.y.z]     write apps/web/src/releases/<v>.md from git log
//
// One Markdown file per version is the single source for the website changelog, the GitHub
// Release body and the update feed's `notes`. `bun run release` (scripts/release.mjs) does the
// whole flow; this file holds its pure parts so they are tested without git.
//
// Release anchors are the `chore(release): Lotus x.y.z` commits; this repo carries no tags.
// The files live in apps/web so a push of a new note redeploys the site through the web
// workflow's existing path filter.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Not `new URL(rel, import.meta.url)`: under vitest jsdom, URL is jsdom's and fileURLToPath rejects it.
const here = fileURLToPath(import.meta.url);

export const notesDir = resolve(here, "../../../web/src/releases");
export const notesPath = (version) => join(notesDir, `${version}.md`);
export const confPath = resolve(here, "../../src-tauri/tauri.conf.json");
export const TODO_TITLE = "TODO: one line a user reads";

/** Commit scopes that never reach the desktop app's users: they neither bump nor appear. */
const SKIP_SCOPES = new Set(["web", "pocket", "ci", "host-ci", "docs", "release", "plans"]);
const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

/**
 * Commits → what the app's users get, and how big a bump that is (SemVer from Conventional
 * Commits): a breaking change is major, feat minor, fix/perf/refactor patch. Anything else
 * (chore, docs, test, style, build, ci) is not a release on its own.
 * Before 1.0 a breaking change bumps minor: 1.0.0 is a decision, made with `release major`.
 */
export function classify(commits) {
  const added = [];
  const improved = [];
  const fixed = [];
  let bump = null;
  const rank = { patch: 1, minor: 2, major: 3 };
  const raise = (b) => (bump = !bump || rank[b] > rank[bump] ? b : bump);
  for (const { subject, body = "" } of commits) {
    const m = HEADER.exec(subject.trim());
    if (!m || SKIP_SCOPES.has(m[2] ?? "")) continue;
    const [, type, , bang, text] = m;
    const breaking = Boolean(bang) || /^BREAKING[ -]CHANGE:/m.test(body);
    const line = text.replace(/\s*\(#\d+\)$/, "");
    const item = line[0].toUpperCase() + line.slice(1);
    if (type === "feat") added.push(item), raise("minor");
    else if (type === "fix") fixed.push(item), raise("patch");
    else if (type === "perf") improved.push(item), raise("patch");
    else if (type === "refactor") raise("patch");
    else continue;
    if (breaking) raise("major");
  }
  return { added, improved, fixed, bump };
}

/** The bump the commits ask for, held below 1.0.0 unless someone typed `release major`. */
export const autoBump = (current, bump) => (bump === "major" && current.startsWith("0.") ? "minor" : bump);

/** `level` is major|minor|patch or an explicit x.y.z. */
export function nextVersion(current, level) {
  if (/^\d+\.\d+\.\d+$/.test(level)) return level;
  const [maj, min, pat] = current.split(".").map(Number);
  if (level === "major") return `${maj + 1}.0.0`;
  if (level === "minor") return `${maj}.${min + 1}.0`;
  if (level === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`unknown bump: ${level}`);
}

export function isNewer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

export function draftText(version, date, { added, improved = [], fixed }, title = TODO_TITLE) {
  const list = (items) => items.map((i) => `- ${i}`).join("\n");
  const section = (name, items) => (items.length ? [`### ${name}`, "", list(items), ""] : []);
  const body = [...section("New", added), ...section("Improved", improved), ...section("Fixed", fixed)];
  return [
    "---",
    `version: ${version}`,
    `date: ${date}`,
    `title: ${JSON.stringify(title)}`,
    "---",
    "",
    ...(body.length ? body : ["### Improved", "", "- Under-the-hood work, nothing you need to do.", ""]),
  ].join("\n");
}

/** Parses note text; throws with the reason a release must not go out with it. */
export function parseNotes(text, version, where = `${version}.md`) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${where}: missing --- frontmatter ---`);
  const meta = Object.fromEntries(
    m[1].split("\n").map((l) => {
      const at = l.indexOf(":");
      return [l.slice(0, at).trim(), l.slice(at + 1).trim().replace(/^"(.*)"$/, "$1")];
    }),
  );
  if (meta.version !== version) throw new Error(`${where}: version is ${meta.version}, expected ${version}`);
  if (!meta.title || meta.title === TODO_TITLE) throw new Error(`${where}: write the title first`);
  if (!/^### (New|Improved|Fixed)$/m.test(m[2])) throw new Error(`${where}: needs a ### New, Improved or Fixed section`);
  return { version, date: meta.date, title: meta.title, body: m[2].trim() };
}

export function readNotes(version) {
  const path = notesPath(version);
  if (!existsSync(path)) throw new Error(`no release notes: ${path} (run: bun run release:notes draft ${version})`);
  return parseNotes(readFileSync(path, "utf8"), version, path);
}

export function git(args, opts = {}) {
  const r = spawnSync("git", args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Commits since the last `chore(release): Lotus` commit, oldest first. */
export function commitsSinceRelease() {
  const anchor = git(["log", "-1", "--format=%H", "--extended-regexp", "--grep=^chore\\(release\\): Lotus "]);
  const raw = git(["log", "--reverse", "--format=%s%x1f%b%x1e", `${anchor}..HEAD`]);
  return raw
    .split("\x1e")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [subject, body = ""] = c.split("\x1f");
      return { subject, body };
    });
}

export const currentVersion = () => JSON.parse(readFileSync(confPath, "utf8")).version;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, wanted] = process.argv.slice(2);
  if (cmd !== "draft") {
    console.error("usage: release-notes.mjs draft [x.y.z]");
    process.exit(1);
  }
  const commits = commitsSinceRelease();
  const c = classify(commits);
  const version = wanted ?? (c.bump ? nextVersion(currentVersion(), autoBump(currentVersion(), c.bump)) : null);
  if (!version) {
    console.error("[notes] no app-facing feat/fix/perf/refactor since the last release");
    process.exit(1);
  }
  const path = notesPath(version);
  if (existsSync(path)) {
    console.error(`[notes] ${path} exists; edit it instead`);
    process.exit(1);
  }
  writeFileSync(path, draftText(version, new Date().toISOString().slice(0, 10), c));
  console.log(`[notes] drafted ${path} from ${commits.length} commits. Edit it, set the title.`);
}
