import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Route guard for the removed CodeSwarm surface.
 *
 * `/swarm` no longer exists. A link to it is a string, not an import, so TypeScript cannot catch it —
 * it fails only at runtime, as a 404 in the static export. This guard is the only thing standing
 * between a stray `href="/swarm"` and a dead menu entry, so it scans source text rather than types.
 *
 * Deliberately narrow: it matches the route literal, not the word "swarm", so prose in comments and
 * unrelated identifiers stay legal.
 */

// Repo root: this file lives at <root>/src/modules/shell/__tests__/.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SRC_DIR = path.resolve(REPO_ROOT, "src");

/** `"/swarm"`, `'/swarm?…'`, `` `/swarm/…` `` — the route as a string literal, in any quote style. */
const SWARM_ROUTE_RE = /["'`]\/swarm(["'`?/])/;

function toRepoRelative(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

function isTestPath(relPath: string): boolean {
  return /(^|\/)__tests__(\/|$)/.test(relPath) || /\.test\.[cm]?tsx?$/.test(relPath);
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const rel = toRepoRelative(abs);
    if (statSync(abs).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      collectSourceFiles(abs, out);
      continue;
    }
    if (!/\.[cm]?tsx?$/.test(entry)) continue;
    if (isTestPath(rel)) continue;
    out.push(abs);
  }
  return out;
}

function findOffenders(): string[] {
  return collectSourceFiles(SRC_DIR)
    .filter((abs) => SWARM_ROUTE_RE.test(readFileSync(abs, "utf8")))
    .map(toRepoRelative)
    .sort();
}

describe("removed CodeSwarm surface", () => {
  it("has no source file routing to /swarm", () => {
    expect(
      findOffenders(),
      `link(s) to the removed /swarm route detected. The CodeSwarm surface was deleted; a string ` +
        `route to it compiles fine and 404s at runtime. Point the navigation somewhere that exists ` +
        `(or drop it) instead of reviving the route.`,
    ).toEqual([]);
  });
});
