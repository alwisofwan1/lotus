import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalV2RendererDiagnostics } from "../TerminalV2RendererDiagnostics";

const snapshot = {
  leases: [{
    paneId: "pane-1",
    slotId: "renderer-1",
    signals: { visible: true, focused: true, agentActive: false, busy: false, altScreen: false },
    health: null,
  }],
  registeredSlots: ["pane-1"],
  waitingPanes: ["pane-2"],
  fallbackPanes: ["pane-3"],
};

describe("TerminalV2RendererDiagnostics", () => {
  it("stays hidden in production even when enabled", () => {
    render(
      <TerminalV2RendererDiagnostics
        enabled
        environment="production"
        snapshot={snapshot}
      />,
    );

    expect(screen.queryByLabelText("Terminal V2 renderer diagnostics")).not.toBeInTheDocument();
  });

  it("renders renderer leases, registered slots, and waiting panes when enabled in development", () => {
    render(
      <TerminalV2RendererDiagnostics
        enabled
        environment="development"
        snapshot={snapshot}
      />,
    );

    expect(screen.getByText("Terminal V2 Renderer")).toBeInTheDocument();
    expect(screen.getByText("pane-1 → renderer-1")).toBeInTheDocument();
    expect(screen.getByText("registered: pane-1")).toBeInTheDocument();
    expect(screen.getByText("waiting: pane-2")).toBeInTheDocument();
    expect(screen.getByText("fallback: pane-3")).toBeInTheDocument();
  });

  it("renders runtime counters when a runtime diagnostics snapshot is provided", () => {
    render(
      <TerminalV2RendererDiagnostics
        enabled
        environment="development"
        snapshot={snapshot}
        runtimeSnapshot={{
          renderer: snapshot,
          sessions: { total: 2, byStatus: { running: 1, detached: 1 }, byWorkspace: { "workspace-a": 2 } },
          counters: {
            rendererVisibilityUpdates: 7,
            rendererOutputBytes: 128,
            paneInputWrites: 3,
            paneResizeRequests: 4,
            pooledInputWrites: 2,
          },
          knownPaneCount: 5,
          startedAt: 123,
        }}
      />,
    );

    expect(screen.getByText("sessions: 2")).toBeInTheDocument();
    expect(screen.getByText("workspace sessions: workspace-a=2")).toBeInTheDocument();
    expect(screen.getByText("known panes: 5")).toBeInTheDocument();
    expect(screen.getByText("updates: 7 · resize: 4")).toBeInTheDocument();
    expect(screen.getByText("output bytes: 128 · input: 3")).toBeInTheDocument();
  });

  it("copies the redacted runtime diagnostics payload", () => {
    const copyText = vi.fn();
    render(
      <TerminalV2RendererDiagnostics
        enabled
        environment="development"
        snapshot={snapshot}
        copyText={copyText}
        runtimeSnapshot={{
          renderer: snapshot,
          sessions: { total: 2, byStatus: { running: 1, detached: 1 }, byWorkspace: { "workspace-a": 2 } },
          counters: {
            rendererVisibilityUpdates: 7,
            rendererOutputBytes: 128,
            paneInputWrites: 3,
            paneResizeRequests: 4,
            pooledInputWrites: 2,
          },
          knownPaneCount: 5,
          startedAt: 123,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy Terminal V2 diagnostics" }));

    expect(copyText).toHaveBeenCalledOnce();
    expect(copyText.mock.calls[0][0]).toContain('"schemaVersion": 1');
    expect(copyText.mock.calls[0][0]).not.toContain("pane-1");
    expect(copyText.mock.calls[0][0]).not.toContain("workspace-a");
  });
});
