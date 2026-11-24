#!/usr/bin/env node
// One command for a Lotus release (from the repo root: `bun run release`).
//
//   bun run release                  version from the commits, notes written, you confirm, it ships
//   bun run release minor            force the bump: patch | minor | major | x.y.z
//   bun run release --dry-run        print the version and the notes, change nothing
//   bun run release --no-ai          skip the Claude rewrite; the notes are the raw commit list
//   bun run release --yes            no prompt (the notes still have to pass the checks)
//
// Version (SemVer from Conventional Commits since the last `chore(release): Lotus` commit,
// app-facing scopes only): breaking → major, feat → minor, fix/perf/refactor → patch. Before
// 1.0 a breaking change bumps minor; 1.0.0 is only ever `release major`.
//
// Steps: check the tree → pick the version → draft apps/web/src/releases/<v>.md (Claude rewrites
// it for users) → you read it: [Y]es / [e]dit / [n]o → web tests (the notes are site copy) →
// commit `chore(release): Lotus <v>` (version + notes) and push main, which redeploys the
// changelog → release-macos.mjs builds, signs, publishes and dispatches the Windows half.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  autoBump, classify, commitsSinceRelease, confPath, currentVersion, draftText, git, isNewer, nextVersion, notesPath, parseNotes,
} from "./release-notes.mjs";

const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoDir = resolve(desktopDir, "../..");
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const level = args.find((a) => !a.startsWith("--"));
const dry = flag("--dry-run");

const say = (m) => console.log(`[release] ${m}`);
const fail = (m) => {
  console.error(`[release] ERROR: ${m}`);
  process.exit(1);
};

// 1. The tree: Windows builds origin/main, so what ships must be exactly what is pushed.
git(["fetch", "-q", "origin", "main"], { cwd: repoDir });
const dirty = git(["status", "--porcelain", "--untracked-files=no"], { cwd: repoDir })
  .split("\n")
  .filter((l) => l && !l.includes("apps/web/src/releases/"));
if (dirty.length && !dry) fail(`commit or stash first:\n${dirty.join("\n")}`);
try {
  git(["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: repoDir });
} catch {
  if (dry) say("note: HEAD is behind origin/main; a real release needs a pull first");
  else fail("HEAD is behind origin/main; pull or rebase first");
}

// 2. The version.
const current = currentVersion();
const commits = commitsSinceRelease();
const found = classify(commits);
if (!level && !found.bump) fail(`no app-facing feat/fix/perf/refactor in ${commits.length} commits since ${current}`);
const version = nextVersion(current, level ?? autoBump(current, found.bump));
if (!isNewer(version, current)) fail(`${version} is not newer than ${current}`);
say(`${current} → ${version} (${level ? `asked: ${level}` : `commits say ${found.bump}`}; ${found.added.length} new, ${found.improved.length} improved, ${found.fixed.length} fixed)`);

// 3. The notes.
const path = notesPath(version);
let text = existsSync(path) ? readFileSync(path, "utf8") : null;
if (text) say(`using the notes already in ${path}`);
else {
  text = draftText(version, new Date().toISOString().slice(0, 10), found);
  if (!flag("--no-ai")) text = rewrite(text) ?? text;
}
if (dry) {
  console.log(`\n${text}`);
  say("dry run: nothing written");
  process.exit(0);
}
writeFileSync(path, text);

// 4. A person reads them.
for (;;) {
  let problem = null;
  try {
    parseNotes(readFileSync(path, "utf8"), version, path);
  } catch (e) {
    problem = e.message;
  }
  if (flag("--yes") && !problem) break;
  if (flag("--yes") || !process.stdin.isTTY) fail(problem ?? "no terminal to confirm in; pass --yes");
  console.log(`\n${readFileSync(path, "utf8")}`);
  if (problem) say(`not ready: ${problem}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(problem ? "[e]dit / [n]o? " : `Release ${version}? [Y]es / [e]dit / [n]o `)).trim().toLowerCase();
  rl.close();
  if (answer === "n") fail(`stopped; the notes stay in ${path}`);
  if (answer === "e") spawnSync(process.env.SHELL ?? "sh", ["-c", `${process.env.EDITOR ?? "vi"} "${path}"`], { stdio: "inherit" });
  else if (!problem) break;
}

// 5. The notes are site copy: the web suite checks them before anything is public.
run("bun", ["run", "test"], join(repoDir, "apps/web"), "web tests failed on the notes; fix them and re-run");

// 6. Version + notes in one commit, pushed: the site's changelog redeploys from this push.
const conf = readFileSync(confPath, "utf8");
writeFileSync(confPath, conf.replace(/"version": "[^"]*"/, `"version": "${version}"`));
git(["add", confPath, path], { cwd: repoDir });
git(["commit", "-q", "-m", `chore(release): Lotus ${version}`], { cwd: repoDir });
git(["push", "-q", "origin", "HEAD:main"], { cwd: repoDir });
say(`committed and pushed chore(release): Lotus ${version}`);

// 7. Build, sign, publish, dispatch Windows.
run("bun", ["scripts/release-macos.mjs", version, "--publish"], desktopDir, `publish failed after the push; re-run: bun run release:mac ${version} --publish`);
say(`Lotus ${version} is out → https://lotus-web.pages.dev/changelog/#v${version}`);

function run(cmd, argv, cwd, why) {
  const r = spawnSync(cmd, argv, { cwd, stdio: "inherit" });
  if (r.status !== 0) fail(why);
}

/** Claude turns the commit list into notes a user reads. Any failure keeps the raw draft. */
function rewrite(draft) {
  say("Claude is rewriting the notes for users (--no-ai to skip)…");
  const prompt = `You write release notes for Lotus, a desktop workbench for AI coding agents (canvas, terminals, chat, voice, automations).
Rewrite the draft below for the people who use the app.
- Keep the frontmatter keys and values, except: set title to one short line (under 60 characters) naming the most important change, no version number.
- Sections: ### New, ### Improved, ### Fixed, in that order; omit empty ones.
- Merge related commits into one bullet. Say what the user can now do, or what no longer goes wrong, in plain English.
- Drop what users never see: tests, refactors, tooling, ticket or round numbers, file and function names.
- No marketing words, no em dashes. Never claim anything the commits do not say.
- The app ships for macOS and Windows only: never mention Linux (Linux commits are server-side work).
Reply with the file content only, starting with ---.

${draft}`;
  const r = spawnSync("claude", ["-p", "--output-format", "text"], { input: prompt, encoding: "utf8", timeout: 300_000 });
  const out = (r.stdout ?? "").trim().replace(/^```\w*\n|\n```$/g, "");
  try {
    parseNotes(`${out}\n`, version);
    return `${out}\n`;
  } catch (e) {
    say(`kept the raw draft (${r.error?.message ?? e.message})`);
    return null;
  }
}
