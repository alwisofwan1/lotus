import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = existsSync(join(process.cwd(), "lotus-remote/src"))
  ? join(process.cwd(), "lotus-remote/src")
  : join(process.cwd(), "src");

/** File-size and comment rules, shared with apps/pocket (see CLAUDE.md). */
const MAX_CODE_LINES = 600;
const WARN_CODE_LINES = 400;
const MAX_RAW_LINES = 1000;
const MAX_LINE_CHARS = 200;
const MAX_COMMENT_BLOCK = 5;
/** Ratchet: over-long comment blocks src/ still has. Lower it when you trim; never raise it. */
const LONG_COMMENT_BLOCK_CEILING = 97;

/** Lines of text, ignoring a single trailing newline. */
export function rawLines(content: string): string[] {
  if (content === "") return [];
  return content.replace(/\n$/, "").split("\n");
}

/** A line that is only string content (prompt prose) is exempt from the width cap. */
const isProse = (l: string) => /^\s*["'`]/.test(l);

const isCommentLine = (s: string) => s.startsWith("//") || s.startsWith("/*") || s.startsWith("*");

/** Non-blank lines outside `//` and `/* *\/` comments. */
export function codeLines(lines: string[]): number {
  let count = 0;
  let inBlock = false;
  for (const raw of lines) {
    const s = raw.trim();
    if (inBlock) {
      if (s.includes("*/")) inBlock = false;
      continue;
    }
    if (s === "" || s.startsWith("//")) continue;
    if (s.startsWith("/*")) {
      inBlock = !s.includes("*/");
      continue;
    }
    count++;
  }
  return count;
}

/** Runs of consecutive comment lines longer than MAX_COMMENT_BLOCK. */
export function longCommentBlocks(lines: string[]): number {
  let blocks = 0;
  let run = 0;
  for (const raw of [...lines, ""]) {
    if (isCommentLine(raw.trim())) {
      run++;
      continue;
    }
    if (run > MAX_COMMENT_BLOCK) blocks++;
    run = 0;
  }
  return blocks;
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

const sources = () =>
  collectSourceFiles(SRC_ROOT).map((path) => ({
    path: path.slice(SRC_ROOT.length),
    lines: rawLines(readFileSync(path, "utf8")),
  }));

describe("counters", () => {
  it("rawLines ignores a single trailing newline", () => {
    expect(rawLines("a\nb\nc\n")).toHaveLength(3);
    expect(rawLines("a\nb\nc")).toHaveLength(3);
    expect(rawLines("")).toHaveLength(0);
  });

  it("codeLines skips blanks and every comment form", () => {
    expect(codeLines(["", "// a", "/** b", " * c", " */", "x;", "  y;"])).toBe(2);
  });

  it("longCommentBlocks counts only runs over the limit", () => {
    const long = ["/**", ...Array(MAX_COMMENT_BLOCK - 1).fill(" * x"), " */"];
    const short = Array(MAX_COMMENT_BLOCK).fill("// x");
    expect(longCommentBlocks([...long, "code;", ...short, "code;", ...long])).toBe(2);
  });
});

describe("file-size limit (CLAUDE.md non-negotiable)", () => {
  it(`no source file exceeds ${MAX_CODE_LINES} code / ${MAX_RAW_LINES} raw lines`, () => {
    const violations: string[] = [];
    for (const { path, lines } of sources()) {
      const code = codeLines(lines);
      if (code > MAX_CODE_LINES) violations.push(`${path}: ${code} code lines`);
      if (lines.length > MAX_RAW_LINES) violations.push(`${path}: ${lines.length} raw lines`);
      lines.forEach((l, i) => {
        if (l.length > MAX_LINE_CHARS && !isProse(l)) violations.push(`${path}:${i + 1} is ${l.length} chars`);
      });
      if (code > WARN_CODE_LINES) console.warn(`WARN ${path}: ${code} code lines, split at a seam soon`);
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("long comment blocks never grow (ratchet)", () => {
    const total = sources().reduce((sum, { lines }) => sum + longCommentBlocks(lines), 0);
    expect(
      total,
      `comment blocks over ${MAX_COMMENT_BLOCK} lines: keep one short "why"; move history to an ADR`,
    ).toBeLessThanOrEqual(LONG_COMMENT_BLOCK_CEILING);
  });
});
