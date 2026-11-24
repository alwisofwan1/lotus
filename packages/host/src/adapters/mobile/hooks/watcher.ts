import { watch, mkdirSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

import { resolveStateDir } from "../../../core/state-dir.js";
import type { Logger } from "../../../core/logger.js";
import { drainPending, processDropFile, realDropDirDeps, type ProcessDeps } from "./drop-dir.js";
import type { DropPayload } from "./payload.js";

/**
 * Watches the drop directory and feeds every hook event to a sink.
 *
 * Deliberately thin, like the Rust watcher it ports: everything that decides anything lives in
 * `drop-dir.ts` and `turns.ts`, where it is tested without a filesystem. What is left here is the
 * part only a real directory can exercise, and it is kept small for exactly that reason.
 */

/** `<state dir>/agent-hooks/global` — the path the hook script writes to. */
export function defaultDropDir(env: NodeJS.ProcessEnv = process.env, home = ""): string {
  // The state dir, never a hardcoded `~/.lotus`: it is what separates dev from release, and
  // hardcoding once made both profiles watch one directory and race for every event.
  return join(resolveStateDir(env, home || env["HOME"] || ""), "agent-hooks", "global");
}

/**
 * How often the directory is swept regardless of what the watcher heard.
 *
 * `fs.watch` is not a guarantee. It misses events under load — observed as a 1-in-4 flake in this
 * package's own suite — and on some filesystems it does not fire at all. A missed event here is a
 * permission that never reaches the phone, which is the failure this whole slice exists to remove,
 * so the sweep is what makes the watcher self-healing rather than an optimisation.
 */
export const SWEEP_MS = 2000;

export interface DropWatcherOptions {
  dir: string;
  onPayload: (payload: DropPayload) => void;
  logger?: Logger;
  /** Injected by tests; production uses the real filesystem. */
  deps?: ProcessDeps;
  /** Sweep interval; tests shorten it. */
  sweepMs?: number;
}

export class DropWatcher {
  private watcher: FSWatcher | null = null;
  private sweep: NodeJS.Timeout | null = null;
  private readonly deps: ProcessDeps;

  constructor(private readonly opts: DropWatcherOptions) {
    this.deps = opts.deps ?? realDropDirDeps;
  }

  /**
   * Drains what landed while this host was down, then watches for more.
   *
   * Draining first is not an optimisation: an agent that asked for permission while the host was
   * restarting is still waiting, and the file is the only record that it asked.
   */
  start(): void {
    try {
      mkdirSync(this.opts.dir, { recursive: true });
    } catch (error) {
      // A blocked path is unrecoverable and worth saying, but it must not stop the host: every
      // other route still works, and hooks are one capability rather than the product.
      this.opts.logger?.warn("hooks.dir_unavailable", { dir: this.opts.dir, error: String(error) });
      return;
    }

    const outcomes = drainPending(this.opts.dir, this.deps, this.opts.onPayload);
    const emitted = outcomes.filter((o) => o === "emitted").length;
    const stale = outcomes.filter((o) => o === "stale").length;
    if (emitted > 0 || stale > 0) {
      this.opts.logger?.info("hooks.drained", { emitted, stale });
    }

    try {
      this.watcher = watch(this.opts.dir, (_event, name) => {
        if (name === null) return;
        processDropFile(join(this.opts.dir, name.toString()), this.deps, this.opts.onPayload);
      });
    } catch (error) {
      // Not fatal, and not the end of the story: the sweep below is what actually guarantees
      // delivery, so a filesystem with no usable watch degrades to polling rather than to nothing.
      this.opts.logger?.warn("hooks.watch_failed", { dir: this.opts.dir, error: String(error) });
    }

    this.sweep = setInterval(() => {
      drainPending(this.opts.dir, this.deps, this.opts.onPayload);
    }, this.opts.sweepMs ?? SWEEP_MS);
    // Never hold the process open for a sweep: this is upkeep, not work.
    this.sweep.unref?.();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.sweep !== null) clearInterval(this.sweep);
    this.sweep = null;
  }
}
