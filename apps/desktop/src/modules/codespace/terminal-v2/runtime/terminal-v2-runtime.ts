import type { TerminalInputMetadata } from "@/modules/codespace/services/terminal-input-events";
import { normalizeTerminalV2InputData } from "../input/terminal-v2-input-event-adapter";
import type { TerminalV2PooledDomSlotFactory } from "../rendering/terminal-v2-pooled-dom-slot-factory";
import {
  TerminalV2RendererCoordinator,
  type TerminalV2RendererCoordinatorResult,
  type TerminalV2RendererDebugSnapshot,
} from "../rendering/terminal-v2-renderer-coordinator";
import type { TerminalV2RendererBindRequest } from "../rendering/terminal-v2-renderer-pool";
import {
  TerminalV2XtermRendererHost,
  type TerminalV2PaneSearchApi,
  type TerminalV2XtermRendererSlot,
} from "../rendering/terminal-v2-xterm-renderer-host";
import { createCodeSpaceTerminalMetadataRepository } from "../session/codespace-terminal-metadata-repository";
import type { TerminalMetadataRepository } from "../session/terminal-metadata-repository";
import {
  TerminalV2SessionManager,
  type TerminalV2SessionController,
} from "./terminal-v2-session-manager";
import { TerminalV2PaneBacklogs } from "./terminal-v2-pane-backlogs";
import { TerminalV2RendererWritePump } from "./terminal-v2-renderer-write-pump";
import { TerminalV2SessionStarter } from "./terminal-v2-session-starter";
import { beginRenderProbe, reportRenderFallback } from "../rendering/terminal-v2-render-probe";
/** Panes that may hold a live renderer at once; the probe prints leases against it. */
const RENDERER_POOL_CAPACITY = 8;

export type TerminalV2RuntimeOptions = {
  metadataRepository?: TerminalMetadataRepository;
  sessionControllerFactory?: () => TerminalV2SessionController;
  pooledDomSlotFactory?: TerminalV2PooledDomSlotFactory;
  captureRendererSnapshot?: (paneId: string) => string | null;
  restoreRendererSnapshots?: boolean;
  rendererHealthCheckMs?: number;
  /** Frame scheduling seam for renderer write batching; defaults to requestAnimationFrame. */
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
};

export type TerminalV2RuntimeDiagnosticsSnapshot = {
  renderer: TerminalV2RendererDebugSnapshot;
  sessions: {
    total: number;
    byStatus: Record<string, number>;
    byWorkspace: Record<string, number>;
  };
  counters: {
    rendererVisibilityUpdates: number;
    rendererOutputBytes: number;
    paneInputWrites: number;
    paneResizeRequests: number;
    pooledInputWrites: number;
  };
  knownPaneCount: number;
  startedAt: number;
};

export class TerminalV2Runtime {
  readonly metadataRepository: TerminalMetadataRepository;
  readonly sessionManager: TerminalV2SessionManager;
  readonly sessionStarter: TerminalV2SessionStarter;
  readonly rendererHost: TerminalV2XtermRendererHost;
  readonly rendererCoordinator: TerminalV2RendererCoordinator;
  readonly backlogs: TerminalV2PaneBacklogs;
  readonly startedAt: number;
  private pooledDomSlotFactory: TerminalV2PooledDomSlotFactory | null;
  private readonly pooledPaneContainers = new Map<string, HTMLElement>();
  private readonly rendererWritePump: TerminalV2RendererWritePump;
  private readonly paneInputHandlers = new Map<string, (data: string) => void>();
  private readonly rendererHealthTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly rendererHealthCheckMs: number;
  private readonly diagnosticsCounters = {
    rendererVisibilityUpdates: 0,
    rendererOutputBytes: 0,
    paneInputWrites: 0,
    paneResizeRequests: 0,
    pooledInputWrites: 0,
  };
  private disposed = false;

  constructor(options: TerminalV2RuntimeOptions = {}) {
    this.metadataRepository = options.metadataRepository ?? createCodeSpaceTerminalMetadataRepository();
    this.sessionManager = new TerminalV2SessionManager({
      controllerFactory: options.sessionControllerFactory,
    });
    this.sessionStarter = new TerminalV2SessionStarter(this.sessionManager);
    this.pooledDomSlotFactory = options.pooledDomSlotFactory ?? null;
    this.rendererHealthCheckMs = options.rendererHealthCheckMs ?? 600;
    this.rendererWritePump = new TerminalV2RendererWritePump({
      writeToPane: (paneId, data) => this.rendererCoordinator.writeToPane(paneId, data),
      appendBacklog: (paneId, data) => this.backlogs.appendMissedOutput(paneId, data),
      ...(options.requestFrame ? { requestFrame: options.requestFrame } : {}),
      ...(options.cancelFrame ? { cancelFrame: options.cancelFrame } : {}),
    });
    this.backlogs = new TerminalV2PaneBacklogs({
      isPaneOnRegisteredSlotFallback: (paneId) => this.rendererCoordinator.isPaneOnRegisteredSlotFallback(paneId),
    });
    this.rendererHost = new TerminalV2XtermRendererHost({
      createSlot: (slotId) => {
        const pooledSlot = this.pooledDomSlotFactory?.getSlot(slotId);
        if (pooledSlot) return pooledSlot;
        throw new Error(`Terminal V2 renderer slot ${slotId} has not been registered`);
      },
      drainPaneOutput: (paneId, write) => this.backlogs.drainForPane(paneId, write),
      onFitGeometry: (paneId, cols, rows) => this.resizePaneSession(paneId, cols, rows),
    });
    this.rendererCoordinator = new TerminalV2RendererCoordinator({
      host: this.rendererHost,
      capacity: RENDERER_POOL_CAPACITY,
      resetOnBind: options.restoreRendererSnapshots ?? false,
      allowHostCreatedSlots: options.pooledDomSlotFactory?.policy.enabled ?? false,
      captureSnapshot: options.captureRendererSnapshot,
    });
    this.startedAt = options.now?.() ?? Date.now();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  registerLegacyRendererSlot(paneId: string, slot: TerminalV2XtermRendererSlot): () => void {
    return this.rendererCoordinator.registerPaneSlot(paneId, slot);
  }

  installPooledDomSlotFactory(factory: TerminalV2PooledDomSlotFactory): () => void {
    if (!factory.policy.enabled) return () => undefined;
    this.pooledDomSlotFactory = factory;
    this.rendererCoordinator.setHostCreatedSlotsEnabled(true);
    return () => {
      if (this.pooledDomSlotFactory !== factory) return;
      this.pooledDomSlotFactory = null;
      this.rendererCoordinator.setHostCreatedSlotsEnabled(false);
    };
  }

  registerPooledRendererPaneContainer(paneId: string, container: HTMLElement): () => void {
    this.pooledPaneContainers.set(paneId, container);
    this.rendererWritePump.flush(paneId);
    this.rendererCoordinator.attachWaitingPane(paneId);
    return () => {
      if (this.pooledPaneContainers.get(paneId) === container) {
        this.pooledPaneContainers.delete(paneId);
      }
    };
  }

  getPooledRendererPaneContainer(paneId: string): HTMLElement | null {
    return this.pooledPaneContainers.get(paneId) ?? null;
  }

  updateRendererPane(request: TerminalV2RendererBindRequest): TerminalV2RendererCoordinatorResult {
    this.diagnosticsCounters.rendererVisibilityUpdates += 1;
    this.rendererWritePump.flush(request.paneId);
    const probe = beginRenderProbe(request, this.rendererCoordinator, RENDERER_POOL_CAPACITY);
    const result = this.rendererCoordinator.updatePane(request);
    probe(result.kind);
    if (request.visible) {
      this.scheduleRendererHealthCheck(request.paneId);
    } else {
      this.cancelRendererHealthCheck(request.paneId);
    }
    return result;
  }

  markPooledRendererPaneUnhealthy(paneId: string): TerminalV2RendererCoordinatorResult {
    this.cancelRendererHealthCheck(paneId);
    this.rendererWritePump.flush(paneId);
    return this.rendererCoordinator.fallbackPaneToRegisteredSlot(paneId);
  }

  /**
   * True while a pooled slot is the renderer the user sees for this pane. The pane's own xterm uses
   * this to stay a cold standby instead of parsing the same PTY bytes a second time.
   */
  isPaneRendererServedByPooledSlot(paneId: string): boolean {
    return this.rendererCoordinator.isPaneServedByHostCreatedSlot(paneId);
  }

  subscribePaneOutput(paneId: string, listener: (data: string) => void): () => void {
    return this.sessionManager.subscribeOutput(paneId, listener);
  }

  writeRendererPaneOutput(paneId: string, data: string): void {
    this.diagnosticsCounters.rendererOutputBytes += data.length;
    const target = this.rendererCoordinator.getPaneWriteTarget(paneId);
    // "external": the pane's own renderer is live, so mirrored output would double-write.
    if (target === "external") return;
    if (target === "none") {
      this.backlogs.appendMissedOutput(paneId, data);
      return;
    }
    // Bursty PTY output is coalesced to one xterm write per frame. Pending bytes are flushed
    // whenever the pane's renderer lease changes, so no batch can land in another pane's slot.
    this.rendererWritePump.push(paneId, data);
  }

  writePaneInput(paneId: string, data: string, metadata: Partial<TerminalInputMetadata> = {}): void {
    this.diagnosticsCounters.paneInputWrites += 1;
    this.sessionManager.writeSession(paneId, data, metadata);
  }

  /**
   * Lets a pane publish the input pipeline that owns inline suggestions, submitted-command
   * detection, activity tracking, and cwd probing. Pooled renderer keystrokes are routed through it
   * so a pane served by a pooled slot behaves exactly like one rendering its own xterm.
   */
  registerPaneInputHandler(paneId: string, handler: (data: string) => void): () => void {
    this.paneInputHandlers.set(paneId, handler);
    return () => {
      if (this.paneInputHandlers.get(paneId) === handler) {
        this.paneInputHandlers.delete(paneId);
      }
    };
  }

  writePooledRendererInput(paneId: string, data: string): void {
    this.diagnosticsCounters.pooledInputWrites += 1;
    const handler = this.paneInputHandlers.get(paneId);
    if (handler) {
      try {
        handler(data);
      } catch (error) {
        // This runs inside the pooled renderer's onData callback; a throw would take out every
        // later keystroke in the pane. The keystroke is not re-sent because the pipeline may
        // already have written it, and a duplicate is worse than a dropped one here.
        console.error("[terminal-v2] pane input pipeline failed:", error);
      }
      return;
    }
    // No pane pipeline yet (renderer bound before its owner mounted): keep the keystroke rather
    // than dropping it, at the cost of the richer metadata the pipeline would have derived.
    this.writePaneInput(paneId, normalizeTerminalV2InputData(data), {
      origin: "human",
      intent: "unknown",
      submitted: false,
    });
  }

  getPaneRendererHelperTextarea(paneId: string): HTMLTextAreaElement | null {
    return this.rendererCoordinator.getPaneHelperTextarea(paneId);
  }

  focusPaneRenderer(paneId: string): boolean {
    return this.rendererCoordinator.focusPane(paneId);
  }

  blurPaneRenderer(paneId: string): boolean {
    return this.rendererCoordinator.blurPane(paneId);
  }

  createPaneSearchApi(paneId: string, fallbackApi?: TerminalV2PaneSearchApi | null): TerminalV2PaneSearchApi {
    const resolveSearchApi = () => this.rendererCoordinator.getPaneSearchApi(paneId) ?? fallbackApi ?? null;
    return {
      findNext: (query, mode) => resolveSearchApi()?.findNext(query, mode) ?? false,
      findPrevious: (query) => resolveSearchApi()?.findPrevious(query) ?? false,
      clearSearch: () => resolveSearchApi()?.clearSearch(),
    };
  }

  detachPaneSession(paneId: string): void {
    this.sessionManager.detachSession(paneId);
  }

  closeSession(paneId: string): void {
    this.sessionManager.closeSession(paneId);
    this.cleanupPaneRuntimeState(paneId);
  }

  closeWorkspaceSessions(workspaceId: string): void {
    const paneIds = this.sessionManager.getAllSessions()
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => session.paneId);
    this.sessionManager.closeWorkspaceSessions(workspaceId);
    for (const paneId of paneIds) this.cleanupPaneRuntimeState(paneId);
  }

  closeAllSessions(): void {
    const paneIds = this.sessionManager.getAllSessions().map((session) => session.paneId);
    this.sessionManager.closeAllSessions();
    for (const paneId of paneIds) this.cleanupPaneRuntimeState(paneId);
  }

  resizePaneSession(paneId: string, cols: number, rows: number): void {
    this.diagnosticsCounters.paneResizeRequests += 1;
    this.sessionManager.resizeSession(paneId, cols, rows);
  }

  appendRendererBacklog(paneId: string, data: string): void {
    this.backlogs.appendMissedOutput(paneId, data);
  }

  /** Parks output for a pane's own renderer while a pooled slot is the one rendering that pane. */
  appendRendererStandbyBacklog(paneId: string, data: string): void {
    this.backlogs.appendStandbyOutput(paneId, data);
  }

  /**
   * Drops standby output for a pane whose own renderer went away (hidden pane, unmount). The next
   * renderer starts empty, so replaying into it would show history it never had.
   */
  clearRendererStandbyBacklog(paneId: string): void {
    this.backlogs.clearStandbyOutput(paneId);
  }

  getRendererDebugSnapshot(): TerminalV2RendererDebugSnapshot {
    return this.rendererCoordinator.getDebugSnapshot();
  }

  getRuntimeDiagnosticsSnapshot(): TerminalV2RuntimeDiagnosticsSnapshot {
    const sessions = this.sessionManager.getAllSessions();
    return {
      renderer: this.getRendererDebugSnapshot(),
      sessions: {
        total: sessions.length,
        byStatus: sessions.reduce<Record<string, number>>((counts, session) => {
          counts[session.status] = (counts[session.status] ?? 0) + 1;
          return counts;
        }, {}),
        byWorkspace: sessions.reduce<Record<string, number>>((counts, session) => {
          counts[session.workspaceId] = (counts[session.workspaceId] ?? 0) + 1;
          return counts;
        }, {}),
      },
      counters: { ...this.diagnosticsCounters },
      knownPaneCount: this.getKnownPaneIds().size,
      startedAt: this.startedAt,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const paneIds = this.getKnownPaneIds();
    this.sessionManager.dispose();
    for (const paneId of paneIds) {
      this.cleanupPaneRuntimeState(paneId);
    }
    for (const paneId of Array.from(this.rendererHealthTimers.keys())) {
      this.cancelRendererHealthCheck(paneId);
    }
    this.rendererWritePump.disposeAll();
    this.pooledDomSlotFactory?.disposeAll();
    this.pooledDomSlotFactory = null;
    this.rendererCoordinator.setHostCreatedSlotsEnabled(false);
  }

  private getKnownPaneIds(): Set<string> {
    const snapshot = this.getRendererDebugSnapshot();
    return new Set([
      ...this.sessionManager.getAllSessions().map((session) => session.paneId),
      ...snapshot.leases.map((lease) => lease.paneId),
      ...snapshot.waitingPanes,
      ...snapshot.registeredSlots,
      ...snapshot.fallbackPanes,
      ...this.pooledPaneContainers.keys(),
      ...this.rendererHealthTimers.keys(),
    ]);
  }

  private cleanupPaneRuntimeState(paneId: string): void {
    this.cancelRendererHealthCheck(paneId);
    this.rendererWritePump.dispose(paneId);
    this.paneInputHandlers.delete(paneId);
    this.rendererCoordinator.forgetPane(paneId);
    this.pooledPaneContainers.delete(paneId);
    this.backlogs.clearPane(paneId);
  }

  private scheduleRendererHealthCheck(paneId: string): void {
    this.cancelRendererHealthCheck(paneId);
    const timer = setTimeout(() => {
      this.rendererHealthTimers.delete(paneId);
      this.verifyRendererHealth(paneId);
    }, this.rendererHealthCheckMs);
    this.rendererHealthTimers.set(paneId, timer);
  }

  private cancelRendererHealthCheck(paneId: string): void {
    const timer = this.rendererHealthTimers.get(paneId);
    if (!timer) return;
    clearTimeout(timer);
    this.rendererHealthTimers.delete(paneId);
  }

  private verifyRendererHealth(paneId: string): void {
    const lease = this.getRendererDebugSnapshot().leases.find((candidate) => candidate.paneId === paneId);
    const health = lease?.health;
    if (!lease || !health?.renderObserverAttached) return;
    if (health.attachedPaneId !== paneId) return;
    if (health.lastRenderAt >= health.lastAttachedAt) return;
    reportRenderFallback(paneId, "no paint since attach");
    this.rendererCoordinator.fallbackPaneToRegisteredSlot(paneId);
  }
}

export function createTerminalV2Runtime(options?: TerminalV2RuntimeOptions): TerminalV2Runtime {
  return new TerminalV2Runtime(options);
}
