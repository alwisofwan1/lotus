// The Workbench Changes drawer (#281, mockup `lotus-chat.fig` page "05a Changes", board B). Pure:
// what the drawer ticks, what Undo offers, and a unified diff as rows. Git and the snapshots that
// tell whose edit is whose live in the Rust runtime (src-tauri/src/chat_runtime/changes.rs).

import type { ThreadState } from "./thread-state";

export interface ChangedFile {
  /** Relative to the repository root. */
  path: string;
  status: "added" | "modified" | "deleted";
  /** null for a binary file. */
  added: number | null;
  removed: number | null;
  /** The chat's agent changed it. */
  agent: boolean;
  /** It already differed from the last commit before the agent's first edit. */
  yoursBefore: boolean;
  /** It changed after the turn that last edited it ended; undo would lose that. */
  yoursAfter: boolean;
  /** Lotus still has the file as it was before the agent's first edit, and the agent named it in an edit step. */
  undoable: boolean;
}

export interface Changes {
  /** null when the folder is not in a git repository. */
  branch: string | null;
  /** The chat's folder inside the repository, "" or ending in "/"; `files` paths start with it. */
  prefix: string;
  files: ChangedFile[];
  /** Set for a delegated chat in its own worktree: what its branch would bring to the lead. */
  delegated?: Delegated | null;
}

export interface Delegated {
  /** The child's worktree branch. */
  branch: string;
  /** The lead's current branch, which a merge goes into. */
  into: string;
  /** "<short sha> <subject>" for each commit the lead lacks, newest first. */
  commits: string[];
  /** Files not committed in the worktree; a merge would leave them behind. */
  uncommitted: number;
}

export interface Totals {
  files: number;
  added: number;
  removed: number;
}

export function totals(files: readonly ChangedFile[]): Totals {
  return files.reduce((t, f) => ({ files: t.files + 1, added: t.added + (f.added ?? 0), removed: t.removed + (f.removed ?? 0) }), {
    files: 0,
    added: 0,
    removed: 0,
  });
}

export const agentFiles = (changes: Changes | null) => changes?.files.filter((f) => f.agent) ?? [];

/** The agent's files go into the commit by default; the user's own stay out until ticked. */
export const defaultPicks = (files: readonly ChangedFile[]) => new Set(files.filter((f) => f.agent).map((f) => f.path));

/** What Undo ticks first: never a file it cannot restore, nor one whose later edits it would lose. */
export const undoCandidates = (files: readonly ChangedFile[]) => files.filter((f) => f.agent);
export const undoDefault = (f: ChangedFile) => f.undoable && !f.yoursAfter;

/** Five squares, green then red, in proportion — the diffstat bar of the mockup. */
export function diffstatSquares({ added, removed }: Totals, count = 5): ("add" | "del" | "none")[] {
  const total = added + removed;
  if (total === 0) return Array<"none">(count).fill("none");
  let adds = Math.round((added / total) * count);
  if (removed > 0) adds = Math.min(adds, count - 1);
  if (added > 0) adds = Math.max(adds, 1);
  return Array.from({ length: count }, (_, i) => (i < adds ? "add" : "del"));
}

/** How many file edits the agent made in this thread. */
export function fileEdits(state: ThreadState | null): number {
  let edits = 0;
  for (const turn of state?.turns ?? []) for (const { item } of turn.items) if (item.kind === "fileChange") edits++;
  return edits;
}

/** Changes worth re-reading git for: turns starting or ending, and each file the agent touches. */
export function changesRefreshKey(state: ThreadState | null): string {
  if (!state) return "";
  const running = state.turns.some((t) => t.status === "running");
  return `${state.turns.length}:${fileEdits(state)}:${running}`;
}

export interface DiffRow {
  kind: "hunk" | "context" | "add" | "del";
  /** Line number in the file: the old one for a deletion, the new one otherwise. */
  line: number | null;
  /** A context line's number in the old file, for the left side of a split diff. */
  old?: number;
  text: string;
}

/** `git diff` output for one file, as rows; the file headers are dropped. */
export function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: "hunk", line: null, text: raw });
    } else if (!inHunk || raw.startsWith("\\")) {
      continue;
    } else if (raw.startsWith("+")) {
      rows.push({ kind: "add", line: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "del", line: oldNo++, text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      rows.push({ kind: "context", line: newNo++, old: oldNo++, text: raw.slice(1) });
    } else if (raw.startsWith("diff --git")) {
      inHunk = false;
    }
  }
  return rows;
}

/**
 * What a file's diff is "at", for Viewed: a file marked viewed shows as changed again once this moves.
 * shortcut: built from the counts and status, so an edit that keeps both counts goes unnoticed; key on a hash of the diff if that bites.
 */
export function fileRevision(file: Pick<ChangedFile, "added" | "removed" | "status">): string {
  return `${file.added}:${file.removed}:${file.status}`;
}

/** Files whose path contains `query`, case-insensitively; all of them for an empty query. */
export function filterChangedFiles<T extends { path: string }>(files: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : [...files];
}

export type SplitRow = { kind: "hunk"; text: string } | { kind: "pair"; left: DiffRow | null; right: DiffRow | null };

/**
 * Unified rows as side-by-side pairs: context on both sides, a run of deletions beside the run of
 * additions that follows it, the shorter side padded with blanks.
 */
export function splitRows(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: DiffRow[] = [];
  let adds: DiffRow[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ kind: "pair", left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === "del") {
      if (adds.length) flush();
      dels.push(row);
    } else if (row.kind === "add") adds.push(row);
    else {
      flush();
      out.push(row.kind === "hunk" ? { kind: "hunk", text: row.text } : { kind: "pair", left: row, right: row });
    }
  }
  flush();
  return out;
}
