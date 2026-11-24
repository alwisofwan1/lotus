"use client";
import { parsePtySessionEnd } from "./pty-session-end";
import type { PtySessionController } from "./pty-session-controller";
import { createTerminalModeTracker, type TerminalModeTracker } from "./terminal-mode-state";

/**
 * Persistent PTY session pool — keeps a live agent's PTY (and its controller) alive across
 * React unmount/remount so switching CodeCanvas projects does NOT kill a running agent.
 *
 * Terminal nodes already survive a project switch (the terminal-session-registry keeps their
 * controller in a module Map and swaps the output sink on detach/attach). Agent nodes use the
 * data-only `usePtySession` hook, which spawns a fresh controller per mount and `abort()`s it on
 * unmount — so a project switch killed the agent process. This pool gives the agent path the same
 * survive-unmount contract:
 *
 *   mount   → acquire: reuse a live entry (reattach) or register a new one (fresh spawn)
 *   unmount → detach : null the sink, keep the controller + PTY alive, keep mirroring output
 *   remount → attach : replay the transcript into the fresh sink, then resume live output
 *   close   → destroy: abort the controller (kills the PTY) and drop the entry
 *
 * `scope` groups entries by canvas project (`canvas:{projectId}`) so closing a project can tear
 * down all of its agent PTYs at once — mirroring `closeWorkspaceTerminalSessions`.
 */

export type PtyPoolStatus = "connecting" | "connected" | "ended" | "error";

/** Rolling transcript mirror per session, replayed into a fresh terminal on reattach. */
const MAX_TRANSCRIPT_BYTES = 256_000;

interface PoolEntry {
  controller: PtySessionController;
  scope: string;
  status: PtyPoolStatus;
  mode: "command" | "shell" | null;
  sessionId: string | null;
  /** Current live output sink (the mounted consumer). Null while detached. */
  dataSink: ((data: string) => void) | null;
  /** Current end sink (fires once when the session ends). Null while detached. */
  endSink: ((code: number) => void) | null;
  /** Bounded mirror of everything the session has emitted, for reattach replay. */
  transcript: string;
  /**
   * DEC private-mode state across the WHOLE session (not just the transcript window). One-shot
   * enables like bracketed paste (?2004h) are emitted once at CLI startup and overflow the
   * transcript mirror; without re-arming them, a reattached xterm pastes raw newlines and the
   * runner submits instantly (the paste-auto-submit bug).
   */
  modes: TerminalModeTracker;
  ended: boolean;
  exitCode: number | null;
  /**
   * True once a runner actually came up inside this session.
   *
   * A pooled PTY is not proof that an agent is running in it. A launch that never succeeded — the
   * command was cut in transit, or the CLI exited — leaves a bare shell in the pool, and reattach
   * used to adopt that as a live agent: the pane then sat at a shell prompt forever, because adopt
   * deliberately types nothing (observed 2026-09-12,
   * `plans/codecanvas-session-refactor/issues/08`).
   */
  runnerLaunched: boolean;
}

const pool = new Map<string, PoolEntry>();

/** Record that a runner came up in this session, so a later reattach may adopt it. */
export function markRunnerLaunched(key: string): void {
  const entry = pool.get(key);
  if (entry) entry.runnerLaunched = true;
}

/** Whether a runner is known to have come up in this session. False for anything unproven. */
export function hasRunnerLaunched(key: string): boolean {
  return pool.get(key)?.runnerLaunched === true;
}

export function hasPersistentPty(key: string): boolean {
  return pool.has(key);
}

export function getPersistentPtyController(key: string): PtySessionController | null {
  return pool.get(key)?.controller ?? null;
}

export interface PersistentPtySnapshot {
  status: PtyPoolStatus;
  mode: "command" | "shell" | null;
  sessionId: string | null;
  ended: boolean;
  exitCode: number | null;
}

export function getPersistentPtySnapshot(key: string): PersistentPtySnapshot | null {
  const entry = pool.get(key);
  if (!entry) return null;
  return {
    status: entry.status,
    mode: entry.mode,
    sessionId: entry.sessionId,
    ended: entry.ended,
    exitCode: entry.exitCode,
  };
}

/**
 * The bounded output mirror for a session, or null if no session is pooled for this key. Read-only —
 * used by voice read-back (e.g. "read me what Rowan found") to surface an agent's recent terminal
 * output without a round-trip to the Rust ring buffer. Contains raw bytes incl. ANSI; callers strip.
 */
export function getPersistentPtyTranscript(key: string): string | null {
  return pool.get(key)?.transcript ?? null;
}

/** Register a brand-new session. The caller then drives the controller's connect. */
export function createPersistentPty(key: string, scope: string, controller: PtySessionController): void {
  // If a stale entry somehow exists for this key, kill it before replacing.
  const existing = pool.get(key);
  if (existing && existing.controller !== controller) existing.controller.abort();
  pool.set(key, {
    controller,
    scope,
    status: "connecting",
    mode: null,
    sessionId: null,
    dataSink: null,
    endSink: null,
    transcript: "",
    modes: createTerminalModeTracker(),
    ended: false,
    exitCode: null,
    runnerLaunched: false,
  });
}

/** Record a successful connect so a later reattach can report the right status/mode immediately. */
export function markPersistentPtyConnected(
  key: string,
  mode: "command" | "shell",
  sessionId: string | null,
): void {
  const entry = pool.get(key);
  if (!entry || entry.ended) return;
  entry.status = "connected";
  entry.mode = mode;
  entry.sessionId = sessionId;
}

export function markPersistentPtyError(key: string): void {
  const entry = pool.get(key);
  if (!entry || entry.ended) return;
  entry.status = "error";
}

/**
 * Funnel for controller output. Detects the session-end sentinel, mirrors data into the bounded
 * transcript, and routes it to the live sink (or nowhere, when detached — the transcript preserves
 * it for the next reattach).
 */
export function dispatchPersistentPtyOutput(key: string, raw: string): void {
  const entry = pool.get(key);
  if (!entry) return;
  const exitCode = parsePtySessionEnd(raw);
  if (exitCode !== null) {
    entry.ended = true;
    entry.status = "ended";
    entry.exitCode = exitCode;
    entry.endSink?.(entry.exitCode);
    return;
  }
  entry.transcript = `${entry.transcript}${raw}`.slice(-MAX_TRANSCRIPT_BYTES);
  entry.modes.observe(raw);
  entry.dataSink?.(raw);
}

export interface AttachResult {
  status: PtyPoolStatus;
  mode: "command" | "shell" | null;
  sessionId: string | null;
}

/**
 * Bind the current consumer's sinks and replay the transcript so a freshly-mounted terminal shows
 * the running session's recent output. If the session already ended while detached, the end sink
 * fires immediately after the replay.
 */
export function attachPersistentPty(
  key: string,
  dataSink: (data: string) => void,
  endSink: (code: number) => void,
): AttachResult | null {
  const entry = pool.get(key);
  if (!entry) return null;
  entry.dataSink = dataSink;
  entry.endSink = endSink;
  // Re-arm session-lifetime terminal modes BEFORE the transcript so the fresh xterm parses the
  // replay under the same state the running CLI expects (bracketed paste, focus reporting, …).
  // This goes to the local sink only — never to the PTY; the CLI's own state is untouched.
  const modeReplay = entry.modes.replaySequence();
  if (modeReplay) dataSink(modeReplay);
  if (entry.transcript) dataSink(entry.transcript);
  if (entry.ended) endSink(entry.exitCode ?? 0);
  return { status: entry.status, mode: entry.mode, sessionId: entry.sessionId };
}

/** Unbind sinks on unmount. The controller + PTY stay alive; output keeps filling the transcript. */
export function detachPersistentPty(key: string): void {
  const entry = pool.get(key);
  if (!entry) return;
  entry.dataSink = null;
  entry.endSink = null;
}

/** Explicit close (node removed): abort the controller (kills the PTY) and drop the entry. */
export function destroyPersistentPty(key: string): void {
  const entry = pool.get(key);
  if (!entry) return;
  entry.controller.abort();
  pool.delete(key);
}

/** Keep ownership available for retry until native shutdown has acknowledged. */
export async function destroyPersistentPtyConfirmed(key: string): Promise<void> {
  const entry = pool.get(key);
  if (!entry) return;
  await entry.controller.abortConfirmed();
  if (pool.get(key) === entry) pool.delete(key);
}

/** Tear down every session in a project scope (`canvas:{projectId}`) — used on project close. */
export function destroyScopePersistentPtys(scope: string): void {
  for (const [key, entry] of pool) {
    if (entry.scope === scope) {
      entry.controller.abort();
      pool.delete(key);
    }
  }
}

/**
 * The keys of every pooled session, i.e. the pane ids that actually have a process right now.
 *
 * The renderer's pool is the honest answer to "what is running" for canvas panes: `listPtySessions`
 * speaks PTY session ids and cwds, which cannot be mapped back to a node. Used by the session-status
 * reconciliation when a canvas loads (Session Widget, Slice 08).
 */
export function listPersistentPtyKeys(): string[] {
  return Array.from(pool.keys());
}

export function clearPersistentPtyPoolForTests(): void {
  pool.clear();
}
