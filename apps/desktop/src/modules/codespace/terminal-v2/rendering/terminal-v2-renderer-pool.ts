export type TerminalV2RendererSignals = {
  visible?: boolean;
  focused?: boolean;
  agentActive?: boolean;
  busy?: boolean;
  altScreen?: boolean;
  liveResizeActive?: boolean;
};

export type TerminalV2RendererLease = {
  paneId: string;
  slotId: string;
  leasedAt: number;
  lastUsedAt: number;
  signals: TerminalV2RendererSignals;
};

export type TerminalV2RendererEviction = {
  paneId: string;
  slotId: string;
  snapshot: string | null;
};

export type TerminalV2RendererBindPlan = {
  kind: "bound" | "reused";
  paneId: string;
  slotId: string;
  restore: {
    snapshot: string | null;
    drainOutput: boolean;
    fit: boolean;
    repaint: boolean;
  };
  evicted?: TerminalV2RendererEviction;
};

export type TerminalV2RendererReleasePlan = {
  paneId: string;
  slotId: string;
  snapshot: string | null;
};

export type TerminalV2RendererPoolOptions = {
  capacity: number;
  now?: () => number;
  captureSnapshot?: (paneId: string) => string | null;
  /**
   * A pane that is attached but not on screen — a hidden Code workspace. It is always the first
   * eviction victim, whatever its signals: those describe the pane, not whether anyone sees it.
   */
  isBackground?: (paneId: string) => boolean;
};

export type TerminalV2RendererBindRequest = TerminalV2RendererSignals & {
  paneId: string;
};

export class TerminalV2RendererPool {
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly captureSnapshot: (paneId: string) => string | null;
  private readonly isBackground: (paneId: string) => boolean;
  private readonly leases = new Map<string, TerminalV2RendererLease>();
  private readonly snapshots = new Map<string, string | null>();
  private readonly freeSlots: string[] = [];
  private nextSlot = 1;

  constructor(options: TerminalV2RendererPoolOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity <= 0) {
      throw new Error("TerminalV2RendererPool capacity must be a positive integer");
    }
    this.capacity = options.capacity;
    this.now = options.now ?? (() => Date.now());
    this.captureSnapshot = options.captureSnapshot ?? (() => null);
    this.isBackground = options.isBackground ?? (() => false);
  }

  bind(request: TerminalV2RendererBindRequest): TerminalV2RendererBindPlan {
    const existing = this.leases.get(request.paneId);
    if (existing) {
      existing.signals = signalsFromRequest(request);
      existing.lastUsedAt = this.now();
      return this.bindPlan("reused", existing, undefined);
    }

    const evicted = this.evictIfNeeded();
    const lease: TerminalV2RendererLease = {
      paneId: request.paneId,
      slotId: evicted?.slotId ?? this.claimSlotId(),
      leasedAt: this.now(),
      lastUsedAt: this.now(),
      signals: signalsFromRequest(request),
    };
    this.leases.set(request.paneId, lease);
    return this.bindPlan("bound", lease, evicted);
  }

  release(paneId: string): TerminalV2RendererReleasePlan | null {
    const lease = this.leases.get(paneId);
    if (!lease) return null;
    const snapshot = this.captureSnapshot(paneId);
    this.leases.delete(paneId);
    this.snapshots.set(paneId, snapshot);
    this.freeSlots.push(lease.slotId);
    this.freeSlots.sort();
    return { paneId, slotId: lease.slotId, snapshot };
  }

  getLeases(): TerminalV2RendererLease[] {
    return Array.from(this.leases.values()).sort((a, b) => a.slotId.localeCompare(b.slotId));
  }

  private bindPlan(
    kind: TerminalV2RendererBindPlan["kind"],
    lease: TerminalV2RendererLease,
    evicted: TerminalV2RendererEviction | undefined,
  ): TerminalV2RendererBindPlan {
    const snapshot = this.snapshots.get(lease.paneId) ?? null;
    this.snapshots.delete(lease.paneId);
    return {
      kind,
      paneId: lease.paneId,
      slotId: lease.slotId,
      restore: {
        snapshot,
        drainOutput: true,
        fit: true,
        repaint: true,
      },
      ...(evicted ? { evicted } : {}),
    };
  }

  private evictIfNeeded(): TerminalV2RendererEviction | undefined {
    if (this.leases.size < this.capacity) return undefined;
    const victim = this.chooseVictim();
    if (!victim) return undefined;
    const snapshot = this.captureSnapshot(victim.paneId);
    this.leases.delete(victim.paneId);
    this.snapshots.set(victim.paneId, snapshot);
    return { paneId: victim.paneId, slotId: victim.slotId, snapshot };
  }

  private chooseVictim(): TerminalV2RendererLease | null {
    return this.getLeases().sort((a, b) => {
      const backgroundDelta = Number(this.isBackground(b.paneId)) - Number(this.isBackground(a.paneId));
      if (backgroundDelta !== 0) return backgroundDelta;
      const scoreDelta = score(a.signals) - score(b.signals);
      if (scoreDelta !== 0) return scoreDelta;
      return a.lastUsedAt - b.lastUsedAt;
    })[0] ?? null;
  }

  private claimSlotId(): string {
    return this.freeSlots.shift() ?? `renderer-${this.nextSlot++}`;
  }
}

function signalsFromRequest(request: TerminalV2RendererBindRequest): TerminalV2RendererSignals {
  return {
    visible: Boolean(request.visible),
    focused: Boolean(request.focused),
    agentActive: Boolean(request.agentActive),
    busy: Boolean(request.busy),
    altScreen: Boolean(request.altScreen),
    liveResizeActive: Boolean(request.liveResizeActive),
  };
}

function score(signals: TerminalV2RendererSignals): number {
  return (signals.visible ? 1_000 : 0)
    + (signals.altScreen ? 120 : 0)
    + (signals.agentActive ? 100 : 0)
    + (signals.busy ? 70 : 0)
    + (signals.focused ? 20 : 0);
}
