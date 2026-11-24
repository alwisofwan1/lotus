"use client";

import { createTerminalV2RuntimeDiagnosticsCopyText } from "../runtime/terminal-v2-runtime-diagnostics-copy";
import type { TerminalV2RendererDebugSnapshot } from "../rendering/terminal-v2-renderer-coordinator";
import type { TerminalV2RuntimeDiagnosticsSnapshot } from "../runtime/terminal-v2-runtime";

type TerminalV2RendererDiagnosticsProps = {
  enabled: boolean;
  environment?: string;
  snapshot: TerminalV2RendererDebugSnapshot | null;
  runtimeSnapshot?: TerminalV2RuntimeDiagnosticsSnapshot | null;
  copyText?: (text: string) => void | Promise<void>;
};

export function TerminalV2RendererDiagnostics({
  enabled,
  environment = process.env.NODE_ENV,
  snapshot,
  runtimeSnapshot,
  copyText = writeClipboardText,
}: TerminalV2RendererDiagnosticsProps) {
  if (!enabled || environment === "production" || !snapshot) return null;

  return (
    <aside
      aria-label="Terminal V2 renderer diagnostics"
      className="absolute bottom-2 right-2 z-50 max-w-xs rounded border border-[var(--border)] bg-[var(--bg-elevated)]/95 p-2 text-[10px] text-[var(--text-secondary)] shadow-xl"
    >
      <div className="mb-1 flex items-center justify-between gap-2 font-semibold text-[var(--text-primary)]">
        <span>Terminal V2 Renderer</span>
        {runtimeSnapshot ? (
          <button
            type="button"
            aria-label="Copy Terminal V2 diagnostics"
            className="rounded border border-[var(--border)] px-1 py-0.5 text-[9px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            onClick={() => {
              void copyText(createTerminalV2RuntimeDiagnosticsCopyText({ snapshot: runtimeSnapshot, environment }));
            }}
          >
            Copy
          </button>
        ) : null}
      </div>
      <div>{snapshot.leases.length ? snapshot.leases.map((lease) => (
        <div key={`${lease.paneId}:${lease.slotId}`}>
          {lease.paneId} → {lease.slotId}
          {lease.health?.renderObserverAttached ? ` render:${lease.health.lastRenderAt ? "seen" : "pending"}` : ""}
        </div>
      )) : "leases: none"}</div>
      <div>registered: {snapshot.registeredSlots.join(", ") || "none"}</div>
      <div>waiting: {snapshot.waitingPanes.join(", ") || "none"}</div>
      <div>fallback: {snapshot.fallbackPanes.join(", ") || "none"}</div>
      {runtimeSnapshot ? (
        <div className="mt-1 border-t border-[var(--border)] pt-1">
          <div>sessions: {runtimeSnapshot.sessions.total}</div>
          <div>workspace sessions: {formatWorkspaceSessions(runtimeSnapshot.sessions.byWorkspace)}</div>
          <div>known panes: {runtimeSnapshot.knownPaneCount}</div>
          <div>
            updates: {runtimeSnapshot.counters.rendererVisibilityUpdates} · resize: {runtimeSnapshot.counters.paneResizeRequests}
          </div>
          <div>
            output bytes: {runtimeSnapshot.counters.rendererOutputBytes} · input: {runtimeSnapshot.counters.paneInputWrites}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function formatWorkspaceSessions(byWorkspace: Record<string, number>): string {
  const entries = Object.entries(byWorkspace).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "none";
  return entries.map(([workspaceId, count]) => `${workspaceId}=${count}`).join(", ");
}

function writeClipboardText(text: string): void | Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return undefined;
  return navigator.clipboard.writeText(text);
}
