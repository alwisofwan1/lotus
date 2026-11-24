import type { RunStep } from "./automation-api";

/**
 * A running run's steps as a trace (`.pen` "Automation Running now round 1", Option 1): what kind
 * of thing each step did, repeats folded into one row, and how long each took. Pure.
 */

/** What a step did, read from the words crate `lotus-automation` › `activity.rs` writes. */
export type StepKind = "github" | "notion" | "file" | "search" | "web" | "skill" | "tool" | "result" | "refused" | "command";

export function stepKind(text: string): StepKind {
  if (text.startsWith("Not allowed:")) return "refused";
  if (text.startsWith("Read GitHub")) return "github";
  if (text.startsWith("Read Notion") || text.startsWith("Read a Notion page")) return "notion";
  if (text.startsWith("Searched the web") || text.startsWith("Opened ")) return "web";
  if (/^(Searched for|Looked for files|Search |Find )/.test(text)) return "search";
  if (text.startsWith("Read ")) return "file";
  if (text.startsWith("Used the skill")) return "skill";
  if (text === "Wrote the result" || text === "Handed the result to Lotus") return "result";
  if (text.startsWith("Used ")) return "tool";
  // `Ran \`…\``, or a Bash call's own description: the only steps written in the agent's words.
  return "command";
}

/** One row of the trace: a step, or the same step done several times in a row. */
export type TraceRow = {
  text: string;
  kind: StepKind;
  times: number;
  atMs: number;
  /** Until the next row started; null for the newest row, which is still going. */
  tookMs: number | null;
};

export function traceRows(steps: RunStep[]): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const step of steps) {
    const last = rows[rows.length - 1];
    if (last && last.text === step.text) {
      last.times += 1;
      continue;
    }
    if (last) last.tookMs = step.atMs - last.atMs;
    rows.push({ text: step.text, kind: stepKind(step.text), times: 1, atMs: step.atMs, tookMs: null });
  }
  return rows;
}

/** "4s", "2m 04s", "1h 05m": a ticking clock, so whole seconds. Under a second reads "0s". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

/** A row's time, or nothing when it took under a second: the gap also holds the agent's thinking. */
export function rowTime(row: TraceRow, nowMs: number): string | null {
  const ms = row.tookMs ?? nowMs - row.atMs;
  return ms < 1000 ? null : formatElapsed(ms);
}
