import { readdirSync, statSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { parseDropPayload, type DropPayload } from "./payload.js";

/**
 * The drop directory: what the hook script writes into, and this host consumes.
 *
 * A port of `agent_hooks/drop_dir.rs` + `processor.rs` (slice 1b.3), kept as one unit here
 * because on this side there is no Tauri event bus to decouple from — the sink is a callback.
 *
 * Everything filesystem-facing is injected, so the rules below are tested as rules rather than
 * as a directory. That matters: the interesting half of this file is what it REFUSES, and a test
 * that needs a real filesystem to reach those branches tends not to reach them.
 */

/** Maximum age of a drop file still worth emitting at start-up. Older ones are unlinked. */
export const DRAIN_TTL_MS = 5 * 60 * 1000;

/** What the drain did with one file. */
export type DrainOutcome =
  /** Parsed and handed to the sink. Unlinked. */
  | "emitted"
  /** Past the TTL. Unlinked without being read — see `drainPending`. */
  | "stale"
  /** A `.tmp` the producer has not renamed yet. Left alone; the watcher will see the rename. */
  | "in-progress"
  /** Unparseable, missing a required field, or a version this host cannot read. Unlinked so the
   * watcher cannot loop on it. */
  | "invalid"
  /** Vanished or unreadable even after the retry. Left alone; something else may own it. */
  | "read-failed"
  /** Not a drop file at all. */
  | "skipped";

export interface DropDirDeps {
  list(dir: string): string[];
  /** Modification time in ms, or undefined when it cannot be read. */
  mtimeMs(path: string): number | undefined;
  read(path: string): string | undefined;
  remove(path: string): void;
  now(): number;
}

/** Reads a file the way the schema's atomic-write protocol requires: one retry, then give up. */
export interface ProcessDeps extends DropDirDeps {
  /** Injected so a retry costs a test nothing. */
  sleep?(ms: number): void;
}

/**
 * One read-retry after a brief delay.
 *
 * Defends against the case the schema calls out: a create event can arrive before the producer
 * has finished renaming its `.tmp` into place, so the first read sees a partial file. One retry,
 * never a loop — a file that is still broken after it is corrupt, and corrupt files are unlinked.
 */
const READ_RETRY_MS = 50;

/**
 * Processes one drop file: read, parse, hand to `onPayload`, unlink.
 *
 * Unlinking is not cleanup, it is the protocol (`drop-file-schema.md`): the directory is owned by
 * the consumer, and a file left behind is a file the next pass emits again.
 */
export function processDropFile(
  path: string,
  deps: ProcessDeps,
  onPayload: (payload: DropPayload) => void,
): DrainOutcome {
  if (path.endsWith(".tmp")) return "in-progress";
  if (!path.endsWith(".json")) return "skipped";

  let raw = deps.read(path);
  if (raw === undefined) {
    deps.sleep?.(READ_RETRY_MS);
    raw = deps.read(path);
  }
  if (raw === undefined) return "read-failed";

  const result = parseDropPayload(raw);
  if (!result.ok) {
    // Unlinked rather than kept for inspection: the watcher would otherwise re-read it on every
    // event for the rest of the host's life.
    deps.remove(path);
    return "invalid";
  }

  onPayload(result.payload);
  deps.remove(path);
  return "emitted";
}

/**
 * Walks the drop directory once at start-up.
 *
 * A host that was down for a day must not wake a phone with yesterday's approvals, so anything
 * past the TTL is unlinked **without being read**. Everything fresh goes through the same
 * `processDropFile` a live event would.
 */
export function drainPending(
  dir: string,
  deps: ProcessDeps,
  onPayload: (payload: DropPayload) => void,
): DrainOutcome[] {
  const out: DrainOutcome[] = [];
  for (const name of deps.list(dir)) {
    const path = join(dir, name);
    if (name.endsWith(".tmp")) { out.push("in-progress"); continue; }
    if (!name.endsWith(".json")) { out.push("skipped"); continue; }

    // Missing metadata is treated as fresh: emitting one stale event costs a notification,
    // dropping a live one costs an agent that waits forever.
    const mtime = deps.mtimeMs(path);
    if (mtime !== undefined && deps.now() - mtime > DRAIN_TTL_MS) {
      deps.remove(path);
      out.push("stale");
      continue;
    }
    out.push(processDropFile(path, deps, onPayload));
  }
  return out;
}

/** The real filesystem, for the host to use. Every branch above is reachable without it. */
export const realDropDirDeps: DropDirDeps = {
  list: (dir) => { try { return readdirSync(dir); } catch { return []; } },
  mtimeMs: (path) => { try { return statSync(path).mtimeMs; } catch { return undefined; } },
  read: (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } },
  remove: (path) => { try { rmSync(path, { force: true }); } catch { /* next pass retries */ } },
  now: () => Date.now(),
};
