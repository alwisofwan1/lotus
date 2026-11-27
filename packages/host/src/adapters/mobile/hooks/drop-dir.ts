import { readdirSync, statSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { parseDropPayload, type DropPayload } from "./payload.js";

/**
 * The drop directory the hook script writes and this host consumes. Port of
 * `agent_hooks/drop_dir.rs` + `processor.rs` (slice 1b.3); filesystem access is injected so
 * the REFUSAL branches are testable.
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
 * One read-retry: a create event can precede the producer's `.tmp` rename, so the first read
 * may be partial. Never a loop: still broken means corrupt, and it is unlinked.
 */
const READ_RETRY_MS = 50;

/**
 * Processes one drop file: read, parse, hand to `onPayload`, unlink.
 *
 * Unlinking is the protocol (`drop-file-schema.md`): a file left behind is emitted again.
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
 * Start-up sweep: anything past the TTL is unlinked **unread**, so yesterday's approvals never
 * wake a phone. Fresh files use the same `processDropFile` as live events.
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
