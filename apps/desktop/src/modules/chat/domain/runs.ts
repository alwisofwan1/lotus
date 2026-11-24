// The Workbench Runs pane (#283, mockup `lotus-chat.fig` page "05c Runs"). Pure: which commands
// the agent ran are checks (tests, lint, types, build), and what their output says.
//
// The command item has no exit code or duration. A failed Bash call arrives as status "failed"
// with output starting "Exit code N" (seen in real transcripts). The counts are read from the
// output text, and they win over the status: `vitest …; echo $?` exits 0 with a failing test.

import type { ItemStatus, ThreadItem } from "./thread-event";
import type { ThreadState } from "./thread-state";

export type RunKind = "tests" | "lint" | "types" | "build";

export const RUN_LABEL: Record<RunKind, string> = { tests: "Tests", lint: "Lint", types: "Types", build: "Build" };

// Each command in a line (`cd x && bun run test | tail`) is checked from its first word, with
// quoted text blanked, so `grep "vitest" package.json` is not a test run. The first kind that
// matches wins, so `cargo test` is tests even though `cargo` also builds.
const SCRIPT = String.raw`^(?:npm|pnpm|yarn|bun|bunx|npx)\s+(?:run\s+)?`;
const KINDS: [RunKind, RegExp][] = [
  ["tests", new RegExp(String.raw`${SCRIPT}[\w:.-]*test|^(?:vitest|jest|pytest|mocha)\b|^(?:cargo|go|flutter|dart|deno|swift)\s+test\b|^playwright\s+test\b`)],
  ["lint", new RegExp(String.raw`${SCRIPT}[\w:.-]*lint|^(?:eslint|ruff|biome|golangci-lint|swiftlint)\b|^cargo\s+clippy\b|^(?:flutter|dart)\s+analyze\b`)],
  ["types", new RegExp(String.raw`${SCRIPT}[\w:.-]*(?:typecheck|type-check|types|tsc)\b|^(?:tsc|mypy|pyright)\b|^cargo\s+check\b`)],
  ["build", new RegExp(String.raw`${SCRIPT}[\w:.-]*build|^(?:cargo|go|swift)\s+build\b|^(?:next|vite|tauri)\s+build\b|^make\b`)],
];

function commands(line: string): string[] {
  const bare = line.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
  return bare
    .split(/&&|\|\||[;|\n(){}]/)
    .map((c) => c.trim().replace(/^(?:\w+=\S*\s+)+/, "").replace(/^(?:time|exec|env|timeout\s+\d+)\s+/, ""));
}

/** The kind of check a shell command runs; null for everything else (`ls`, `git status`, …). */
export function runKind(command: string): RunKind | null {
  const parts = commands(command);
  for (const [kind, re] of KINDS) if (parts.some((c) => re.test(c))) return kind;
  return null;
}

/**
 * The files a check was pointed at, sorted; "" when it ran the whole suite. Redirects, pipes and
 * `; echo $?` are not part of it, so `vitest run a.test.ts 2>&1 | tail` is the same run again.
 */
export function runScope(command: string, kind: RunKind): string {
  const re = KINDS.find(([k]) => k === kind)?.[1];
  const check = commands(command).find((c) => re?.test(c)) ?? "";
  const files = check
    .replace(/\d?>&\d|\d?>>?\s*\S+/g, "")
    .split(/\s+/)
    .filter((t) => !t.startsWith("-") && (t.includes("/") || /\.[A-Za-z]\w*$/.test(t)));
  return files.sort().join(" ");
}

export interface RunResult {
  /** Card headline after the kind: "18 passed · 1 failed", "No problems", "Failed". */
  summary: string;
  failed: boolean;
  /** On a failure: the failing test's name, or the first error line. */
  error: string | null;
  /** The few lines after it (expected vs received), for the open card. */
  excerpt: string[];
  /** The first `file:line` near the failure, for a link. */
  ref: string | null;
  exitCode: number | null;
  /** Output without colour codes or the "Exit code" line. */
  lines: string[];
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const EXCERPT_LINES = 6;

function counts(kind: RunKind, lines: string[]): { summary: string; bad: boolean } | null {
  const text = lines.join("\n");
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (kind === "tests") {
    let passed: number | null = null;
    let failed: number | null = null;
    // cargo prints one "test result:" per crate; sum them.
    const cargo = lines.filter((l) => /^test result:/.test(l.trim()));
    if (cargo.length > 0) {
      passed = failed = 0;
      for (const l of cargo) {
        passed += Number(/(\d+) passed/.exec(l)?.[1] ?? 0);
        failed += Number(/(\d+) failed/.exec(l)?.[1] ?? 0);
      }
    } else {
      // vitest "Tests  18 passed | 1 failed", jest "Tests: 1 failed, 18 passed", pytest "1 failed, 18 passed in".
      const line = [...lines].reverse().find((l) => /\d+ (?:passed|failed)/.test(l));
      const flutter = [...lines].reverse().map((l) => /\+(\d+)(?: ~\d+)?(?: -(\d+))?: /.exec(l)).find(Boolean);
      if (line) {
        passed = Number(/(\d+) passed/.exec(line)?.[1] ?? 0);
        failed = Number(/(\d+) failed/.exec(line)?.[1] ?? 0);
      } else if (flutter) {
        passed = Number(flutter[1]);
        failed = Number(flutter[2] ?? 0);
      }
    }
    if (passed === null || failed === null) return null;
    const summary = [passed > 0 || failed === 0 ? `${passed} passed` : null, failed > 0 ? `${failed} failed` : null].filter(Boolean).join(" · ");
    return { summary, bad: failed > 0 };
  }
  if (kind === "build") return null;
  const ok = (summary: string) => ({ summary, bad: false });
  const errorCount = (n: number) => ({ summary: plural(n, "error"), bad: n > 0 });
  // eslint "✖ 3 problems (2 errors, 1 warning)", tsc "Found 3 errors in 2 files", ruff "Found 3 errors", flutter "3 issues found".
  if (/No (?:issues|problems|errors) found|Found 0 errors/i.test(text)) return ok(kind === "types" ? "No errors" : "No problems");
  const errors = num(/(\d+) errors?\b/);
  const warnings = num(/(\d+) warnings?\b/);
  const issues = num(/(\d+) (?:problems?|issues?) found|(?:✖|x) (\d+) problems?/);
  if (errors !== null || warnings !== null) {
    const summary = [errors ? plural(errors, "error") : null, warnings ? plural(warnings, "warning") : null].filter(Boolean).join(" · ");
    return { summary: summary || "No problems", bad: !!errors };
  }
  if (issues !== null) return issues === 0 ? ok("No problems") : { summary: plural(issues, "problem"), bad: true };
  // tsc prints nothing on success and one "error TS…" line per error otherwise.
  const ts = lines.filter((l) => /error TS\d+/.test(l)).length;
  return ts > 0 ? errorCount(ts) : null;
}

// Where a failure is told, best first: a runner's detail block beats its one-line listing. Each
// gives the failing test's name.
const FAILURES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^\s*FAIL\s+(.+)$/, (m) => last(m[1], " > ")], // vitest: FAIL  file > suite > name
  [/^\s*●\s+(?:.* › )?(.+)$/, (m) => m[1].trim()], // jest: ● Suite › name
  [/^---- (\S+) stdout ----/, (m) => m[1]], // cargo
  [/^FAILED\s+\S*::(\S+)/, (m) => m[1]], // pytest
  [/^\s*(?:✗|×|✕)\s+(.+?)(?:\s+\d+ms)?$/, (m) => last(m[1], " > ")], // vitest/jest listing
  [/^test (\S+) \.\.\. FAILED/, (m) => m[1]], // cargo listing
];
function last(text: string, sep: string): string {
  return text.split(sep).at(-1)?.trim() ?? text;
}
const ERROR_LINE = /\berror\b|\bfailed\b|\bpanicked\b|Error:|✖/i;

function failure(lines: string[]): { error: string; at: number } | null {
  for (const [re, name] of FAILURES) {
    for (let at = 0; at < lines.length; at++) {
      const m = re.exec(lines[at]);
      if (m) return { error: name(m), at };
    }
  }
  const at = lines.findIndex((l) => ERROR_LINE.test(l));
  const first = at >= 0 ? at : lines.findIndex((l) => l.trim() !== "");
  return first >= 0 ? { error: lines[first].trim(), at: first } : null;
}

/** What a finished (or running) check says. */
export function runResult(kind: RunKind, status: ItemStatus, output: string | null): RunResult {
  let lines = (output ?? "").replace(ANSI, "").split("\n");
  const exit = /^Exit code (\d+)/.exec(lines[0] ?? "");
  if (exit) lines = lines.slice(1);
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  const read = status === "running" ? null : counts(kind, lines);
  const failed = read ? read.bad : status === "failed";
  const summary =
    status === "running"
      ? "Running…"
      : (read?.summary ?? (failed ? "Failed" : status === "completed" ? (kind === "build" ? "Built" : "Passed") : status === "interrupted" ? "Stopped" : "Not run"));
  const where = failed ? failure(lines) : null;
  const after = where ? lines.slice(where.at + 1).filter((l) => l.trim() !== "" && !/^\s*⎯+/.test(l)).slice(0, EXCERPT_LINES) : [];
  return {
    summary,
    failed,
    error: where?.error ?? null,
    excerpt: after.map((l) => l.trimEnd()),
    ref: where ? firstFileRef([lines[where.at], ...after]) : null,
    exitCode: exit ? Number(exit[1]) : null,
    lines,
  };
}

/** The first `path.ext:line` in some output, for a link to the failing line. */
export function firstFileRef(lines: readonly string[]): string | null {
  for (const l of lines) {
    const m = /((?:[\w@~.+-]+\/)*[\w@~.+-]+\.[A-Za-z]\w{0,9}):(\d+)/.exec(l);
    if (m && !/^https?:/.test(m[1])) return `${m[1]}:${m[2]}`;
  }
  return null;
}

export interface Run extends RunResult {
  /** The command item's id, for a step's chip to open its card. */
  id: string;
  kind: RunKind;
  command: string;
  status: ItemStatus;
  startedAt: number;
  /** A newer run of the same kind covers this one (same files, or the whole suite): "Earlier". */
  superseded: boolean;
  /** Superseded by a run that passed: a failure here is fixed. */
  passedLater: boolean;
}

// Items are replaced, never mutated, so a parsed result is kept per item object: the state
// changes on every streamed token, the outputs (up to 32 KB each) do not.
const parsed = new WeakMap<object, (RunResult & { kind: RunKind }) | null>();

/** The check a timeline item ran, or null when it is not one. */
export function itemRun(item: ThreadItem): (RunResult & { kind: RunKind }) | null {
  if (item.kind !== "command") return null;
  let run = parsed.get(item);
  if (run === undefined) {
    const kind = runKind(item.command);
    run = kind && { kind, ...runResult(kind, item.status, item.output) };
    parsed.set(item, run);
  }
  return run;
}

/** Every check in the thread, newest first. */
export function threadRuns(state: ThreadState | null): Run[] {
  const runs: Run[] = [];
  for (const turn of state?.turns ?? []) {
    for (const { item, startedAt } of turn.items) {
      const run = itemRun(item);
      if (run && item.kind === "command") {
        runs.push({ ...run, id: item.id, command: item.command, status: item.status, startedAt, superseded: false, passedLater: false });
      }
    }
  }
  runs.reverse();
  const scopes = runs.map((r) => runScope(r.command, r.kind));
  runs.forEach((run, i) => {
    // runs is newest first: the nearest newer run of the same kind that covers this one.
    let later: Run | undefined;
    for (let j = i - 1; j >= 0 && !later; j--) {
      if (runs[j].kind === run.kind && (scopes[j] === "" || scopes[j] === scopes[i])) later = runs[j];
    }
    run.superseded = !!later;
    run.passedLater = !!later && later.status === "completed" && !later.failed;
  });
  return runs;
}
