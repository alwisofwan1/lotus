/**
 * What the pooled renderer is actually doing, written where it can be read.
 *
 * The report was "with focus mode and several agents open, switching panes in the rail is slow and
 * sometimes the terminal comes up blank". Everything about that happens inside the renderer pool —
 * binds, evictions, waiting panes, the health check's fallback — and none of it is observable from
 * outside. Guessing between those would be three rounds of blind fixes; one round of measurement
 * names the mechanism.
 *
 * `console.warn` with ONE string argument, deliberately: that is what the forwarder carrying the
 * webview console into the `tauri dev` terminal was observed to pass through. An `info`, or a
 * second object argument, produces nothing at all.
 *
 * Development only, and easy to delete — it is one call at one choke point.
 */

export const RENDER_PROBE_ENABLED = process.env.NODE_ENV !== "production";

/*
  A marker when the module loads, which is what separates "the console forwarder is dead" from
  "the code never ran". Without it those two look identical, and telling them apart cost a whole
  round of measurement the last time (see `mode-switch-metric.ts`).
*/
if (RENDER_PROBE_ENABLED && typeof window !== "undefined") {
  console.warn("[pane-render] probe ready");
}

/** Pane ids are UUIDs; the first segment is enough to follow one pane across a dozen lines. */
function shortId(paneId: string): string {
  return paneId.slice(0, 8);
}

/** Just enough of the coordinator to read its state; keeps the probe free of a circular import. */
export interface RenderProbeCoordinator {
  getLeases(): { paneId: string }[];
  getDebugSnapshot(): { leases: { paneId: string }[]; waitingPanes: string[] };
}

/**
 * Wraps one `updatePane` call: call before, call the returned function with the result kind.
 *
 * It lives here rather than inline in the runtime so the measurement can be deleted in one file,
 * and so the runtime stays inside its maintenance line budget.
 */
export function beginRenderProbe(
  request: { paneId: string; visible?: boolean },
  coordinator: RenderProbeCoordinator,
  capacity: number,
): (result: string) => void {
  if (!RENDER_PROBE_ENABLED) return () => undefined;
  const startedAt = performance.now();
  const before = coordinator.getLeases().map((lease) => lease.paneId);
  return (result: string) => {
    const snapshot = coordinator.getDebugSnapshot();
    const after = new Set(snapshot.leases.map((lease) => lease.paneId));
    reportRenderProbe({
      paneId: request.paneId,
      visible: Boolean(request.visible),
      result,
      ms: performance.now() - startedAt,
      leases: snapshot.leases.length,
      capacity,
      waiting: snapshot.waitingPanes.length,
      // An eviction is a pane that held a slot before this call and does not after it, other than
      // the one being released on purpose.
      evicted: before.filter((paneId) => !after.has(paneId) && paneId !== request.paneId),
    });
  };
}

export interface RenderProbeSample {
  paneId: string;
  visible: boolean;
  /** What `updatePane` answered: bound, reused, released, waiting-for-slot, noop. */
  result: string;
  ms: number;
  leases: number;
  capacity: number;
  waiting: number;
  /** Panes the pool evicted to make room for this one, if any. */
  evicted?: string[];
}

export function reportRenderProbe(sample: RenderProbeSample): void {
  if (!RENDER_PROBE_ENABLED) return;
  const evicted = sample.evicted?.length ? ` evicted=${sample.evicted.map(shortId).join(",")}` : "";
  console.warn(
    `[pane-render] ${shortId(sample.paneId)} visible=${sample.visible} ${sample.result} ` +
      `ms=${sample.ms.toFixed(1)} leases=${sample.leases}/${sample.capacity} waiting=${sample.waiting}${evicted}`,
  );
}

/** The health check handing a pane back to its own renderer — a known way to end up blank. */
export function reportRenderFallback(paneId: string, reason: string): void {
  if (!RENDER_PROBE_ENABLED) return;
  console.warn(`[pane-render] ${shortId(paneId)} FALLBACK ${reason}`);
}

/**
 * A pane's own renderer slot arriving or going away.
 *
 * Unregistering takes the lease and the pane's desired visibility with it, without a matching
 * `updatePane` — so a pane can go dark with nothing in the visibility log to explain it.
 */
export function reportRenderSlot(paneId: string, event: "register" | "unregister", wanted: boolean): void {
  if (!RENDER_PROBE_ENABLED) return;
  console.warn(`[pane-render] ${shortId(paneId)} SLOT ${event} wanted=${wanted}`);
}

/**
 * A reattached pane asking its agent to repaint.
 *
 * `nudge` means the size was unchanged, so a one-row step was sent to force the redraw; `resized`
 * means the reattach geometry differed and the ordinary resize already did it. `skip-restore`
 * means something else resized the pane during the step, so the step-back was dropped.
 */
export function reportRenderRedraw(
  paneId: string,
  event: "nudge" | "resized" | "skip-restore",
  cols: number,
  rows: number,
): void {
  if (!RENDER_PROBE_ENABLED) return;
  console.warn(`[pane-render] ${shortId(paneId)} REDRAW ${event} cols=${cols} rows=${rows}`);
}

/** The shell's focus-mode veil covering a pane (`on`) and lifting (`out`, with how long it covered). */
export function reportPaneVeil(paneId: string, phase: "on" | "out", coveredMs?: number): void {
  if (!RENDER_PROBE_ENABLED) return;
  const covered = coveredMs === undefined ? "" : ` covered=${coveredMs.toFixed(0)}ms`;
  console.warn(`[pane-render] ${shortId(paneId)} VEIL ${phase}${covered}`);
}
