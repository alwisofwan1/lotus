import type { CanvasFleetContext } from "./canvas-fleet";
import { pushCanvasFleet } from "./canvas-fleet";
import type { AgentStatusSnapshot } from "./agent-status-registry";
import { agentHeadlineStore } from "./agent-headline-store";

/**
 * Coordinates pushing the canvas fleet snapshot to the Lotus MCP IPC state, with two
 * hardening properties the naive "push on change, clear on unmount" hook lacked (RC3/F3):
 *
 *   1. Pushes are debounced so a burst of registry changes collapses to one push.
 *   2. The unmount clear is DEFERRED behind a grace window and cancelled by a subsequent
 *      mount. React StrictMode double-invokes, route toggles, and HMR all remount within
 *      that window, so they no longer transiently blank the fleet (which stranded every
 *      agent→agent dispatch until the next 200 ms re-push). Only a genuine teardown — no
 *      remount within the grace window — clears the slice.
 *
 * State lives on the instance, so the hook must share ONE scheduler across mounts (see
 * [`getCanvasFleetPushScheduler`]); a fresh instance per mount could not cancel the prior
 * unmount's pending clear.
 */
export interface FleetPushSchedulerDeps {
  push: (list: AgentStatusSnapshot[], ctx: CanvasFleetContext) => void;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  debounceMs: number;
  clearGraceMs: number;
  /**
   * A counter over everything the pushed payload depends on that `(list, ctx)` cannot see.
   *
   * Exists because the dedup below is justified by "identical arguments always yield an identical
   * payload", and that stopped being true the moment the payload started carrying the headline:
   * headlines live in their own store. An agent handed a brand-new instruction while its status
   * stayed `running` produced a byte-identical key, so the push was skipped and `lotus_list_fleet`
   * kept serving the previous ask.
   *
   * A revision rather than the headlines themselves, so the scheduler need not know what the
   * payload is made of — anything added later just has to advance this.
   */
  payloadRevision: () => number;
}

export class CanvasFleetPushScheduler {
  private debounceTimer: number | null = null;
  private pendingClearTimer: number | null = null;
  /** Signature of the last snapshot actually pushed, so a routine re-push of byte-identical
   *  state is skipped (6.3). Only the debounced path dedupes; forcePush/critical always push. */
  private lastSignature: string | null = null;

  constructor(private readonly deps: FleetPushSchedulerDeps) {}

  /** Serialize everything that determines the pushed fleet payload — the arguments, plus a revision
   *  standing for the stores they do not cover. A superset key: an identical signature always yields
   *  an identical payload, so skipping is safe (never misses a real change); a payload-irrelevant
   *  difference at worst causes one redundant push, never a dropped update.
   *
   *  Keep that first sentence true. It is the whole warrant for skipping a push, and adding a payload
   *  field sourced from outside these inputs silently invalidates it. */
  private signatureOf(list: AgentStatusSnapshot[], ctx: CanvasFleetContext): string {
    return JSON.stringify({ list, ctx, revision: this.deps.payloadRevision() });
  }

  /** Push and record the signature so the debounced path can skip a later identical snapshot. */
  private emit(list: AgentStatusSnapshot[], ctx: CanvasFleetContext): void {
    this.lastSignature = this.signatureOf(list, ctx);
    this.deps.push(list, ctx);
  }

  /** A canvas mounted. Cancel any deferred clear from a prior unmount so a remount never
   *  transiently blanks the fleet. */
  handleMount(): void {
    if (this.pendingClearTimer !== null) {
      this.deps.clearTimer(this.pendingClearTimer);
      this.pendingClearTimer = null;
    }
  }

  /** The agent registry changed. Debounce, then push the latest snapshot. */
  handleSnapshot(list: AgentStatusSnapshot[], ctx: CanvasFleetContext): void {
    if (this.debounceTimer !== null) {
      this.deps.clearTimer(this.debounceTimer);
    }
    this.debounceTimer = this.deps.setTimer(() => {
      this.debounceTimer = null;
      // 6.3: skip a byte-identical re-push (routine path only) — nothing changed since last push.
      if (this.signatureOf(list, ctx) === this.lastSignature) return;
      this.emit(list, ctx);
    }, this.deps.debounceMs);
  }

  /** Push the latest snapshot immediately, bypassing the debounce and cancelling any pending
   *  debounced push. Used by the pull-on-miss refresh (F4): when Lotus can't resolve a dispatch
   *  target it asks the UI to re-push NOW, so a single missed push self-heals instead of 404ing. */
  forcePush(list: AgentStatusSnapshot[], ctx: CanvasFleetContext): void {
    if (this.debounceTimer !== null) {
      this.deps.clearTimer(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Always push — Rust asked precisely because it believes its snapshot is stale — and refresh
    // the dedup baseline so a following identical debounced push is skipped.
    this.emit(list, ctx);
  }

  /** Critical status changes (error, completed, stalled) bypass debounce entirely — push
   *  immediately so the fleet snapshot reflects the truth within milliseconds. Used when an
   *  agent transitions to a terminal or non-responsive state, so subsequent dispatches don't
   *  hit a stale "running" snapshot that would 404 or queue messages into a dead agent. */
  handleCriticalSnapshot(list: AgentStatusSnapshot[], ctx: CanvasFleetContext): void {
    if (this.debounceTimer !== null) {
      this.deps.clearTimer(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Critical transitions always push (freshness beats dedup) and refresh the baseline.
    this.emit(list, ctx);
  }

  /** The canvas unmounted. Cancel a pending push and schedule a DEFERRED clear that a
   *  subsequent [`handleMount`] cancels — only a genuine teardown clears the slice. */
  handleUnmount(ctx: CanvasFleetContext): void {
    if (this.debounceTimer !== null) {
      this.deps.clearTimer(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pendingClearTimer !== null) {
      this.deps.clearTimer(this.pendingClearTimer);
    }
    this.pendingClearTimer = this.deps.setTimer(() => {
      this.pendingClearTimer = null;
      this.emit([], ctx);
    }, this.deps.clearGraceMs);
  }
}

/** Default debounce for coalescing registry-change bursts. */
export const FLEET_PUSH_DEBOUNCE_MS = 200;
/** Grace window before an unmount clear fires — long enough to absorb StrictMode/route/HMR
 *  remounts, short enough that a real teardown clears promptly. */
export const FLEET_UNMOUNT_CLEAR_GRACE_MS = 1_500;

let sharedScheduler: CanvasFleetPushScheduler | null = null;

/** Process-wide (per-webview) scheduler shared by every `useCanvasFleetPush` mount so the
 *  cancel-on-remount contract holds across mount/unmount cycles. */
export function getCanvasFleetPushScheduler(): CanvasFleetPushScheduler {
  if (!sharedScheduler) {
    sharedScheduler = new CanvasFleetPushScheduler({
      push: (list, ctx) => {
        void pushCanvasFleet(list, ctx);
      },
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimer: (handle) => clearTimeout(handle),
      // The headline store bumps its version only when a DISPLAYED line actually changes — it
      // returns early on an unchanged key — so this never causes a redundant push.
      payloadRevision: () => agentHeadlineStore.version(),
      debounceMs: FLEET_PUSH_DEBOUNCE_MS,
      clearGraceMs: FLEET_UNMOUNT_CLEAR_GRACE_MS,
    });
  }
  return sharedScheduler;
}
