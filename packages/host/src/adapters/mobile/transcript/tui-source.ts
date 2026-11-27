import type { TranscriptEntry, TranscriptResponse } from "../../../types/transcript.js";
import type { CliHookSource } from "../hooks/cli-payload.js";
import { readClaudeTranscript } from "./claude-transcript.js";

/**
 * A TUI cell's Chat page from the runner's transcript (slice 3.3). Three silences stay distinct
 * (`contract/README.md`): `hostSupports: false`, `transcriptOutlook: "never"`, and `entries: []`
 * (nothing **yet**). `undefined` means *ask the desktop*: not a pane this host runs.
 */

/**
 * Runners whose transcript format this host can read (Codex/Cursor are gaps). Exported for
 * `spawn-tuning.ts` (`chatInTerminal`).
 */
export const READABLE_TRANSCRIPTS = new Set(["claude"]);
const READABLE = READABLE_TRANSCRIPTS;

/** Entries per page when a client does not say. Matches the desktop's own default. */
const DEFAULT_LIMIT = 60;

export interface TuiTranscriptDeps {
  /** What the pane's hooks reported about where its CLI keeps history (`CliSources`). */
  sourceOf(paneId: string): CliHookSource | undefined;
  /** The runner behind a pane, or `undefined` when this host does not run it. */
  providerOf(paneId: string): string | undefined;
  /**
   * Reads the file. `missing` and `unreadable` are kept apart deliberately — see
   * [`readTuiTranscript`]. Injected so both branches are testable without a filesystem.
   */
  readFile(path: string): FileRead;
}

/** What came of trying to read the runner's file. */
export type FileRead =
  | { ok: true; text: string }
  /** The path is right and nothing is there **yet** — the CLI writes it lazily. */
  | { ok: false; missing: true }
  /** It should be there and could not be read: permissions, a deleted directory, IO. */
  | { ok: false; missing: false };

export interface TranscriptPageQuery {
  before?: number;
  limit?: number;
}

export function readTuiTranscript(
  paneId: string,
  query: TranscriptPageQuery,
  deps: TuiTranscriptDeps,
): TranscriptResponse | undefined {
  const provider = deps.providerOf(paneId);
  if (provider === undefined) return undefined;

  // No reader for this runner's file: `"never"`, not `hostSupports: false`, which the phone
  // renders as "check Lotus on that desktop" — wrong advice on a host with no desktop.
  if (!READABLE.has(provider)) return { paneId, total: 0, entries: [], transcriptOutlook: "never" };

  const source = deps.sourceOf(paneId);
  // No hook has spoken for this pane yet. The pipeline is healthy — this host installs the hook
  // itself — so this is the honest empty, not a fault.
  if (source === undefined) return { paneId, total: 0, entries: [] };

  const read = deps.readFile(source.transcriptPath);
  if (!read.ok) {
    // **Missing is not broken.** Claude reports `transcript_path` from its very first hook, on
    // `SessionStart`, and writes the file only once there is something to write. Measured on
    // devbox-vps 2026-09-06: for the first seconds of every cell the path exists and the file
    // does not, and calling that `hostSupports: false` tells the operator their host is faulty
    // at the exact moment a healthy cell is starting up.
    if (read.missing) return { paneId, total: 0, entries: [], transcriptPath: source.transcriptPath };
    // Knowing where a file should be is not reading it.
    return cannotKnow(paneId, source.transcriptPath);
  }

  return page(paneId, readClaudeTranscript(read.text), query, source.transcriptPath);
}

/** The path comes along when we know it: it is what an operator needs to see why. */
function cannotKnow(paneId: string, transcriptPath?: string): TranscriptResponse {
  return {
    paneId,
    total: 0,
    entries: [],
    hostSupports: false,
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
  };
}

/**
 * One page ending just before `before`, newest first. The cursor is an **index, not a
 * timestamp**: files are append-only, and hook timestamps can collide within a millisecond.
 */
function page(
  paneId: string,
  all: TranscriptEntry[],
  query: TranscriptPageQuery,
  transcriptPath: string,
): TranscriptResponse {
  const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT);
  const end = Math.min(query.before ?? all.length, all.length);
  const start = Math.max(0, end - limit);
  const entries = all.slice(start, end);

  return {
    paneId,
    // `total` has always meant "in this response"; `totalEver` is what the file holds.
    total: entries.length,
    entries,
    source: "file",
    transcriptPath,
    hasMore: start > 0,
    totalEver: all.length,
    ...(entries.length === 0 ? {} : { oldestCursor: start }),
  };
}
