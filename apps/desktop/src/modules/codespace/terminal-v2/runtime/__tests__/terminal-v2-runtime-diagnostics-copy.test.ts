import { describe, expect, it } from "vitest";
import { createTerminalV2RuntimeDiagnosticsCopyText } from "../terminal-v2-runtime-diagnostics-copy";
import type { TerminalV2RuntimeDiagnosticsSnapshot } from "../terminal-v2-runtime";

const snapshot: TerminalV2RuntimeDiagnosticsSnapshot = {
  renderer: {
    leases: [{
      paneId: "pane-secret-token-123",
      slotId: "renderer-1",
      signals: { visible: true, focused: true, agentActive: false, busy: false, altScreen: false },
      health: null,
    }],
    registeredSlots: ["pane-secret-token-123"],
    waitingPanes: [],
    fallbackPanes: ["pane-2"],
  },
  sessions: { total: 2, byStatus: { running: 1, detached: 1 }, byWorkspace: { "workspace-secret-token": 2 } },
  counters: {
    rendererVisibilityUpdates: 7,
    rendererOutputBytes: 128,
    paneInputWrites: 3,
    paneResizeRequests: 4,
    pooledInputWrites: 2,
  },
  knownPaneCount: 5,
  startedAt: 123,
};

describe("createTerminalV2RuntimeDiagnosticsCopyText", () => {
  it("creates a stable redacted JSON payload for support copies", () => {
    const text = createTerminalV2RuntimeDiagnosticsCopyText({
      snapshot,
      generatedAt: 456,
      environment: "development",
    });
    const payload = JSON.parse(text);

    expect(payload).toEqual({
      schemaVersion: 1,
      generatedAt: 456,
      environment: "development",
      terminalV2: {
        renderer: {
          leaseCount: 1,
          registeredSlotCount: 1,
          waitingPaneCount: 0,
          fallbackPaneCount: 1,
          leases: [{ paneHash: expect.stringMatching(/^pane-[a-f0-9]{8}$/), slotId: "renderer-1", visible: true, focused: true }],
        },
        sessions: {
          total: 2,
          byStatus: { running: 1, detached: 1 },
          byWorkspace: [{ workspaceHash: expect.stringMatching(/^workspace-[a-f0-9]{8}$/), count: 2 }],
        },
        counters: snapshot.counters,
        knownPaneCount: 5,
        uptimeMs: 333,
      },
    });
    expect(text).not.toContain("pane-secret-token-123");
    expect(text).not.toContain("workspace-secret-token");
  });
});
