/**
 * Assert every workflow path filter still matches something.
 *
 * WHY THIS EXISTS
 *   This repo has already lost CI to a stale path filter, silently. ADR-7's third
 *   lesson: after the meta-repo move, `lotus-remote/**` could no longer match
 *   anything, so the host suite simply stopped being tested — and nothing went red,
 *   because a filter that matches nothing fails by being quiet.
 *
 *   That failure mode is invisible by construction, so it needs a mechanism rather
 *   than a habit. This script is that mechanism, and it is cheap enough to run on
 *   every push.
 *
 * WHAT IT CHECKS
 *   1. Every glob in every workflow's `paths:` matches at least one tracked file.
 *      A glob matching nothing is the ADR-7 bug, reproduced.
 *   2. Isolation: a path-filtered workflow reaches exactly one package. This is the
 *      other half — a filter matching too much makes per-package CI pointless, which
 *      is the whole reason the meta-repo layout uses path filters at all. Opt out
 *      deliberately with `ci-filters: allow-multi-package` in the workflow.
 *
 * WHAT IT DOES NOT CHECK
 *   Full GitHub glob semantics. The converter below handles `**`, `*` and literals,
 *   which is what these workflows actually use. If a workflow starts using `?`,
 *   `[...]` or `!` negation, extend it rather than trusting it.
 *
 * Usage:  node tools/verify-ci-filters.mjs
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_DIR = ".github/workflows";

/** Package subtrees that must stay isolated from each other. */
const PACKAGES = ["apps/web", "apps/desktop", "apps/pocket", "packages/host"];

/**
 * Tracked files PLUS untracked-but-present ones.
 *
 * `git ls-files` alone was wrong here, and the guard caught itself doing it: a
 * brand-new workflow is not yet in the index, so its own self-reference looked like
 * a glob matching nothing — a false positive on the very first run. What matters is
 * what will exist after the commit, while still failing on a path that is genuinely
 * gone. `--exclude-standard` keeps ignored build output out of the picture.
 */
function candidateFiles() {
  const out = execSync("git ls-files --cached --others --exclude-standard", {
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

/** Minimal GitHub-Actions-style glob → RegExp. See "does not check" above. */
function toRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1; // `**/` also matches zero directories
      } else {
        out += "[^/]*";
      }
    } else if (".+^${}()|[]\\".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Pull the `paths:` lists out of a workflow without a YAML dependency. */
function pathFilters(yaml) {
  const globs = new Set();
  let inPaths = false;
  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const item = line.match(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/);
      if (item) {
        globs.add(item[1]);
        continue;
      }
      inPaths = false;
    }
  }
  return [...globs];
}

const files = candidateFiles();
const failures = [];

for (const name of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
  const yaml = readFileSync(join(WORKFLOW_DIR, name), "utf8");
  const globs = pathFilters(yaml);

  if (globs.length === 0) {
    console.log(`  ${name}: no path filter (runs on everything) — nothing to check`);
    continue;
  }

  // 1. Every glob must match something.
  const matched = new Map();
  for (const glob of globs) {
    const re = toRegExp(glob);
    const hits = files.filter((f) => re.test(f));
    matched.set(glob, hits.length);
    if (hits.length === 0) {
      failures.push(
        `${name}: glob "${glob}" matches ZERO files.\n` +
          `    This is the ADR-7 failure exactly: the workflow will never run and ` +
          `nothing will go red. Either the path moved, or the glob is wrong.`,
      );
    }
  }

  // 2. A path-filtered workflow must not straddle packages.
  //
  //    Do NOT infer which package a workflow "owns" from its globs — the first
  //    version of this check did, and an over-broad `apps/**` made it identify zero
  //    packages and skip itself silently. That is the same fail-quietly class this
  //    whole script exists to catch, so the condition is now measured instead of
  //    inferred: count the packages the globs actually reach.
  //
  //    A workflow that genuinely spans packages should carry no path filter at all,
  //    or say so with `ci-filters: allow-multi-package` in a comment.
  const spans = PACKAGES.filter((pkg) =>
    files.some((f) => f.startsWith(`${pkg}/`) && globs.some((g) => toRegExp(g).test(f))),
  );
  const optedOut = /ci-filters:\s*allow-multi-package/.test(yaml);

  if (spans.length > 1 && !optedOut) {
    failures.push(
      `${name}: path filter reaches ${spans.length} packages (${spans.join(", ")}).\n` +
        `    Per-package CI stops meaning anything if one workflow fires for every ` +
        `change. Narrow the glob, or declare intent with ` +
        `"ci-filters: allow-multi-package".`,
    );
  }

  const summary = [...matched].map(([g, n]) => `${g} → ${n}`).join(", ");
  console.log(`  ${name}: ${summary}`);
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log("\n✓ every path filter matches real files, and stays inside its package");
