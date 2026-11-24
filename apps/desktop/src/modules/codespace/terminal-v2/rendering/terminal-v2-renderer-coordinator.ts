import { TerminalV2RendererAdapter } from "./terminal-v2-renderer-adapter";
import {
  TerminalV2RendererPool,
  type TerminalV2RendererBindRequest,
  type TerminalV2RendererEviction,
  type TerminalV2RendererSignals,
  type TerminalV2RendererReleasePlan,
} from "./terminal-v2-renderer-pool";
import { reportRenderSlot } from "./terminal-v2-render-probe";
import {
  TerminalV2XtermRendererHost,
  type TerminalV2PaneSearchApi,
  type TerminalV2RendererSlotHealth,
  type TerminalV2XtermRendererSlot,
} from "./terminal-v2-xterm-renderer-host";

export type TerminalV2RendererCoordinatorOptions = {
  host: TerminalV2XtermRendererHost;
  capacity: number;
  now?: () => number;
  captureSnapshot?: (paneId: string) => string | null;
  resetOnBind?: boolean;
  allowHostCreatedSlots?: boolean;
};

export type TerminalV2RendererCoordinatorResult =
  | { kind: "waiting-for-slot"; paneId: string }
  | { kind: "bound" | "reused"; paneId: string; slotId: string }
  | { kind: "released"; paneId: string; slotId: string; snapshot: string | null }
  | { kind: "noop"; paneId: string };

export type TerminalV2RendererLeaseDebug = {
  paneId: string;
  slotId: string;
  signals: TerminalV2RendererSignals;
  health: TerminalV2RendererSlotHealth | null;
};

export type TerminalV2RendererDebugSnapshot = {
  leases: TerminalV2RendererLeaseDebug[];
  registeredSlots: string[];
  waitingPanes: string[];
  fallbackPanes: string[];
};

export class TerminalV2RendererCoordinator {
  private readonly host: TerminalV2XtermRendererHost;
  private readonly adapter: TerminalV2RendererAdapter;
  private readonly pool: TerminalV2RendererPool;
  private readonly resetOnBind: boolean;
  private allowHostCreatedSlots: boolean;
  private readonly paneSlots = new Map<string, TerminalV2XtermRendererSlot>();
  private readonly desired = new Map<string, TerminalV2RendererBindRequest>();
  private readonly leaseSlots = new Map<string, string>();
  private readonly externalOutputPanes = new Set<string>();
  private readonly hostCreatedLeasePanes = new Set<string>();
  private readonly hostCreatedFallbackPanes = new Set<string>();
  private readonly slotRegistrations = new Map<string, () => void>();
  private backgroundPanes = new Set<string>();

  constructor(options: TerminalV2RendererCoordinatorOptions) {
    this.host = options.host;
    this.adapter = new TerminalV2RendererAdapter(options.host);
    this.resetOnBind = options.resetOnBind ?? true;
    this.allowHostCreatedSlots = options.allowHostCreatedSlots ?? false;
    this.pool = new TerminalV2RendererPool({
      capacity: options.capacity,
      now: options.now,
      captureSnapshot: options.captureSnapshot ?? ((paneId) => this.capturePaneSnapshot(paneId)),
      isBackground: (paneId) => this.backgroundPanes.has(paneId),
    });
  }

  registerPaneSlot(paneId: string, slot: TerminalV2XtermRendererSlot): () => void {
    this.paneSlots.set(paneId, slot);
    const desired = this.desired.get(paneId);
    reportRenderSlot(paneId, "register", Boolean(desired?.visible));
    if (desired?.visible) {
      this.bindVisiblePane(desired);
    }

    return () => {
      if (this.paneSlots.get(paneId) !== slot) return;
      /*
        Losing the element is not changing your mind.

        This used to delete `desired` as well, which made the next `registerPaneSlot` a no-op —
        it binds only `if (desired?.visible)`. So a pane whose slot was unregistered and
        registered again (React re-creating the xterm handles, a focus-mode branch remounting the
        subtree) came back with no lease, no desired state and nobody left to ask: the visibility
        effect does not re-run when its inputs did not change. The pane stayed blank until it was
        hidden and shown again.

        Measured in the native window on 2026-09-21: `SLOT unregister wanted=true` followed by
        `waiting-for-slot`, with the pane dark — while the same pane rendered correctly in the
        grid, where no remount happens.

        Only `updatePane({visible:false})` and `forgetPane` change intent now. Releasing the lease
        stays: there is genuinely nothing to draw into until a slot comes back.
      */
      reportRenderSlot(paneId, "unregister", Boolean(this.desired.get(paneId)?.visible));
      this.paneSlots.delete(paneId);
      this.releasePane(paneId);
    };
  }

  updatePane(request: TerminalV2RendererBindRequest): TerminalV2RendererCoordinatorResult {
    this.desired.set(request.paneId, request);
    if (!request.visible) {
      this.desired.delete(request.paneId);
      return this.releasePane(request.paneId);
    }
    if (!this.paneSlots.has(request.paneId) && !this.shouldUseHostCreatedSlot(request.paneId)) {
      return { kind: "waiting-for-slot", paneId: request.paneId };
    }
    return this.bindVisiblePane(request);
  }

  /**
   * Which panes are attached but off screen (a hidden Code workspace).
   *
   * Hiding a workspace no longer releases its panes — that rebuild is what made switching slow
   * and could leave a pane blank. Their `visible` stays true, so the pool needs this to evict
   * them before anything on screen. A pane leaving the background that lost its slot meanwhile
   * is rebound here: its visibility never changed, so nothing else would ask again.
   */
  /** A pooled lease can be acquired before React registers its pane DOM container. */
  attachWaitingPane(paneId: string): void {
    const desired = this.desired.get(paneId);
    const slotId = this.leaseSlots.get(paneId);
    if (!desired?.visible || !slotId || !this.hostCreatedLeasePanes.has(paneId)) return;
    if (this.host.getSlotHealth(slotId, paneId)?.attachedPaneId !== null) return;
    // The initial attach had nowhere to mount. Preserve any output already written to the
    // parked slot via the ordinary release/snapshot path, then bind into the now-real container.
    this.releasePane(paneId);
    this.bindVisiblePane(desired);
  }

  setBackgroundPanes(paneIds: Iterable<string>): TerminalV2RendererCoordinatorResult[] {
    const previous = this.backgroundPanes;
    this.backgroundPanes = new Set(paneIds);
    const results: TerminalV2RendererCoordinatorResult[] = [];
    for (const paneId of previous) {
      if (this.backgroundPanes.has(paneId) || this.leaseSlots.has(paneId)) continue;
      const desired = this.desired.get(paneId);
      if (!desired?.visible) continue;
      results.push(this.bindVisiblePane(desired));
    }
    return results;
  }

  releasePane(paneId: string): TerminalV2RendererCoordinatorResult {
    const plan = this.pool.release(paneId);
    if (!plan) return { kind: "noop", paneId };
    this.applyRelease(plan);
    return { kind: "released", ...plan };
  }

  forgetPane(paneId: string): TerminalV2RendererCoordinatorResult {
    this.desired.delete(paneId);
    this.hostCreatedFallbackPanes.delete(paneId);
    return this.releasePane(paneId);
  }

  setHostCreatedSlotsEnabled(enabled: boolean): TerminalV2RendererCoordinatorResult[] {
    this.allowHostCreatedSlots = enabled;
    if (!enabled) {
      // Those slots are about to be disposed. Release their leases (keeping each pane's desired
      // visibility) and forget them, so the next factory binds the panes to slots of its own.
      const released = Array.from(this.hostCreatedLeasePanes, (paneId) => this.releasePane(paneId));
      this.host.forgetCreatedSlots();
      return released;
    }
    return Array.from(this.desired.values())
      .filter((request) => request.visible && !this.paneSlots.has(request.paneId))
      .map((request) => this.bindVisiblePane(request));
  }

  writeToPane(paneId: string, data: string): boolean {
    if (this.isPaneOutputExternallyOwned(paneId)) return true;
    const slotId = this.leaseSlots.get(paneId);
    if (!slotId) return false;
    this.host.writeToSlot(slotId, data);
    return true;
  }

  /**
   * Where live output for this pane belongs right now: a leased renderer slot, the pane's own
   * renderer ("external", so mirrored output is dropped), or nowhere yet — in which case the caller
   * keeps it in the pane backlog until a renderer is bound.
   */
  getPaneWriteTarget(paneId: string): "slot" | "external" | "none" {
    if (this.externalOutputPanes.has(paneId)) return "external";
    return this.leaseSlots.has(paneId) ? "slot" : "none";
  }

  isPaneOutputExternallyOwned(paneId: string): boolean {
    return this.externalOutputPanes.has(paneId);
  }

  /**
   * True while a host-created (pooled) slot is the renderer the user sees for this pane. Callers
   * that own a second, registered renderer for the same pane use this to stop feeding it live
   * output — the pooled slot is authoritative until the pane falls back or goes hidden.
   */
  isPaneServedByHostCreatedSlot(paneId: string): boolean {
    return this.hostCreatedLeasePanes.has(paneId);
  }

  /** True once a pane has been handed back from a host-created slot to its own registered slot. */
  isPaneOnRegisteredSlotFallback(paneId: string): boolean {
    return this.hostCreatedFallbackPanes.has(paneId);
  }

  fallbackPaneToRegisteredSlot(paneId: string): TerminalV2RendererCoordinatorResult {
    if (!this.paneSlots.has(paneId)) return { kind: "waiting-for-slot", paneId };
    this.hostCreatedFallbackPanes.add(paneId);
    this.releasePane(paneId);
    const desired = this.desired.get(paneId);
    if (!desired?.visible) return { kind: "noop", paneId };
    return this.bindVisiblePane(desired);
  }

  getLeases() {
    return this.pool.getLeases();
  }

  getPaneSearchApi(paneId: string): TerminalV2PaneSearchApi | null {
    const slotId = this.leaseSlots.get(paneId);
    if (!slotId) return null;
    return this.host.getSlotSearchApi(slotId, paneId);
  }

  getPaneHelperTextarea(paneId: string): HTMLTextAreaElement | null {
    const slotId = this.leaseSlots.get(paneId);
    if (!slotId) return null;
    return this.host.getSlotHelperTextarea(slotId, paneId);
  }

  focusPane(paneId: string): boolean {
    const slotId = this.leaseSlots.get(paneId);
    if (!slotId) return false;
    return this.host.focusSlot(slotId, paneId);
  }

  blurPane(paneId: string): boolean {
    const slotId = this.leaseSlots.get(paneId);
    if (!slotId) return false;
    return this.host.blurSlot(slotId, paneId);
  }

  getDebugSnapshot(): TerminalV2RendererDebugSnapshot {
    const registeredSlots = Array.from(this.paneSlots.keys()).sort();
    const waitingPanes = Array.from(this.desired.values())
      .filter((request) => request.visible && !this.paneSlots.has(request.paneId) && !this.shouldUseHostCreatedSlot(request.paneId))
      .map((request) => request.paneId)
      .sort();
    const leases = this.pool.getLeases().map((lease) => ({
      paneId: lease.paneId,
      slotId: lease.slotId,
      signals: lease.signals,
      health: this.host.getSlotHealth(lease.slotId, lease.paneId),
    }));
    return {
      leases,
      registeredSlots,
      waitingPanes,
      fallbackPanes: Array.from(this.hostCreatedFallbackPanes).sort(),
    };
  }

  private bindVisiblePane(request: TerminalV2RendererBindRequest): TerminalV2RendererCoordinatorResult {
    const useHostCreatedSlot = this.shouldUseHostCreatedSlot(request.paneId);
    const slot = useHostCreatedSlot ? undefined : this.paneSlots.get(request.paneId);
    if (!slot && !useHostCreatedSlot) return { kind: "waiting-for-slot", paneId: request.paneId };

    const plan = this.pool.bind(request);
    if (plan.evicted) {
      this.applyEviction(plan.evicted);
    }

    if (slot) {
      this.registerLeaseSlot(request.paneId, plan.slotId, slot);
    }
    const servedByHostCreatedSlot = useHostCreatedSlot && !slot;
    const outputExternallyOwned = slot?.liveOutputMode === "external";
    // A pane handed back to its registered slot after a pooled slot rendered it has a cold
    // renderer: the owner parked its output in the pane backlog instead of writing it. Replay that
    // backlog even though the slot normally owns its own live output, or the fallback shows nothing.
    const replayBacklogIntoOwnRenderer = outputExternallyOwned
      && this.hostCreatedFallbackPanes.has(request.paneId);
    const shouldRestoreOnBind = !outputExternallyOwned && (this.resetOnBind || servedByHostCreatedSlot);
    const liveResizeActive = Boolean(request.liveResizeActive);
    this.host.setSlotLiveResizeActive(plan.slotId, request.paneId, liveResizeActive);
    // A reused lease is already mounted. Focus/activity updates only change pool priority;
    // reattaching it would re-observe, fit and repaint a live TUI for no visibility change.
    // Real geometry changes are handled by the slot's ResizeObserver (or drag-commit hook).
    if (plan.kind === "reused") return { kind: "reused", paneId: plan.paneId, slotId: plan.slotId };
    this.adapter.applyBindPlan({
      ...plan,
      kind: shouldRestoreOnBind ? plan.kind : "reused",
      restore: {
        ...plan.restore,
        snapshot: shouldRestoreOnBind ? plan.restore.snapshot : null,
        drainOutput: outputExternallyOwned ? replayBacklogIntoOwnRenderer : plan.restore.drainOutput,
        fit: liveResizeActive ? false : plan.restore.fit,
      },
      evicted: undefined,
    });
    this.leaseSlots.set(request.paneId, plan.slotId);
    if (servedByHostCreatedSlot) {
      this.hostCreatedLeasePanes.add(request.paneId);
    } else {
      this.hostCreatedLeasePanes.delete(request.paneId);
    }
    if (outputExternallyOwned) {
      this.externalOutputPanes.add(request.paneId);
    } else {
      this.externalOutputPanes.delete(request.paneId);
    }
    return { kind: plan.kind, paneId: plan.paneId, slotId: plan.slotId };
  }

  private applyEviction(evicted: TerminalV2RendererEviction): void {
    this.applyRelease(evicted);
  }

  private capturePaneSnapshot(paneId: string): string | null {
    const slotId = this.leaseSlots.get(paneId);
    if (!slotId) return null;
    return this.host.captureSlotSnapshot(slotId, paneId);
  }

  private shouldUseHostCreatedSlot(paneId: string): boolean {
    return this.allowHostCreatedSlots && !this.hostCreatedFallbackPanes.has(paneId);
  }

  private applyRelease(plan: TerminalV2RendererReleasePlan): void {
    this.adapter.applyReleasePlan(plan);
    this.unregisterLeaseSlot(plan.paneId);
  }

  private registerLeaseSlot(paneId: string, slotId: string, slot: TerminalV2XtermRendererSlot): void {
    const currentSlotId = this.leaseSlots.get(paneId);
    if (currentSlotId === slotId && this.slotRegistrations.has(paneId)) return;
    this.unregisterLeaseSlot(paneId);
    this.slotRegistrations.set(paneId, this.host.registerSlot(slotId, slot));
  }

  private unregisterLeaseSlot(paneId: string): void {
    this.slotRegistrations.get(paneId)?.();
    this.slotRegistrations.delete(paneId);
    this.leaseSlots.delete(paneId);
    this.externalOutputPanes.delete(paneId);
    this.hostCreatedLeasePanes.delete(paneId);
  }
}
