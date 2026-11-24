import type { TerminalV2RuntimeDiagnosticsSnapshot } from "./terminal-v2-runtime";

export type TerminalV2RuntimeDiagnosticsCopyInput = {
  snapshot: TerminalV2RuntimeDiagnosticsSnapshot;
  generatedAt?: number;
  environment?: string;
};

export function createTerminalV2RuntimeDiagnosticsCopyText({
  snapshot,
  generatedAt = Date.now(),
  environment = process.env.NODE_ENV ?? "unknown",
}: TerminalV2RuntimeDiagnosticsCopyInput): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt,
    environment,
    terminalV2: {
      renderer: {
        leaseCount: snapshot.renderer.leases.length,
        registeredSlotCount: snapshot.renderer.registeredSlots.length,
        waitingPaneCount: snapshot.renderer.waitingPanes.length,
        fallbackPaneCount: snapshot.renderer.fallbackPanes.length,
        leases: snapshot.renderer.leases.map((lease) => ({
          paneHash: hashId("pane", lease.paneId),
          slotId: lease.slotId,
          visible: lease.signals.visible,
          focused: lease.signals.focused,
        })),
      },
      sessions: {
        total: snapshot.sessions.total,
        byStatus: snapshot.sessions.byStatus,
        byWorkspace: Object.entries(snapshot.sessions.byWorkspace)
          .map(([workspaceId, count]) => ({ workspaceHash: hashId("workspace", workspaceId), count }))
          .sort((left, right) => left.workspaceHash.localeCompare(right.workspaceHash)),
      },
      counters: snapshot.counters,
      knownPaneCount: snapshot.knownPaneCount,
      uptimeMs: Math.max(0, generatedAt - snapshot.startedAt),
    },
  }, null, 2);
}

function hashId(prefix: string, value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
