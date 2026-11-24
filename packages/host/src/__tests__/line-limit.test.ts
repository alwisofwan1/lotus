import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = existsSync(join(process.cwd(), "lotus-remote/src"))
  ? join(process.cwd(), "lotus-remote/src")
  : join(process.cwd(), "src");
const MAX_LINES = 300;

/** Counts lines of text, ignoring a single trailing newline. */
export function countLines(content: string): number {
  if (content === "") return 0;
  return content.replace(/\n$/, "").split("\n").length;
}

/** All `.ts` source files under src/, excluding `__tests__` directories. */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      collectSourceFiles(full, acc);
    } else if (entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

describe("countLines", () => {
  it("ignores a single trailing newline", () => {
    expect(countLines("a\nb\nc\n")).toBe(3);
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("")).toBe(0);
  });
});

describe("300-line limit (CLAUDE.md non-negotiable)", () => {
  it("no source file under src/ exceeds 300 lines", () => {
    const offenders = collectSourceFiles(SRC_ROOT)
      .map((path) => ({ path: path.slice(SRC_ROOT.length), lines: countLines(readFileSync(path, "utf8")) }))
      .filter(({ lines }) => lines > MAX_LINES)
      .sort((a, b) => b.lines - a.lines);

    expect(offenders, `Files over ${MAX_LINES} lines:\n${offenders.map((o) => `  ${o.lines}  ${o.path}`).join("\n")}`).toEqual([]);
  });
});
