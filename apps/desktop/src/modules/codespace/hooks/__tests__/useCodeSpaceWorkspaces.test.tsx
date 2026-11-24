import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetCodeSpaceWorkspaceOwnershipForTests,
  useCodeSpaceWorkspaces,
} from "@/modules/codespace/hooks/useCodeSpaceWorkspaces";
import type { GridCell, LayoutTemplate, TerminalCellData } from "@/modules/codespace/components/types";

const {
  mockCloseWindowPtySessions,
  mockReapOrphanedSessions,
  mockReconcileSessions,
  mockLoadPersistedCodeSpaceSnapshot,
  mockSavePersistedCodeSpaceSnapshot,
} = vi.hoisted(() => ({
  mockCloseWindowPtySessions: vi.fn(() => Promise.resolve()),
  mockReapOrphanedSessions: vi.fn(),
  mockReconcileSessions: vi.fn(),
  mockLoadPersistedCodeSpaceSnapshot: vi.fn(),
  mockSavePersistedCodeSpaceSnapshot: vi.fn(),
}));

vi.mock("@/lib/pty-session-controller", () => ({
  reapOrphanedSessions: mockReapOrphanedSessions,
  reconcileSessions: mockReconcileSessions,
}));

vi.mock("@/lib/tauri-api", () => ({
  closeWindowPtySessions: mockCloseWindowPtySessions,
}));

vi.mock("@/modules/codespace/services/workspace-metadata", () => ({
  loadPersistedCodeSpaceSnapshot: mockLoadPersistedCodeSpaceSnapshot,
  savePersistedCodeSpaceSnapshot: mockSavePersistedCodeSpaceSnapshot,
}));

function terminalCell(cell: GridCell | undefined): TerminalCellData {
  expect(cell?.type).toBe("terminal");
  return cell as TerminalCellData;
}

describe("useCodeSpaceWorkspaces", () => {
  beforeEach(() => {
    mockCloseWindowPtySessions.mockReset();
    mockCloseWindowPtySessions.mockResolvedValue(undefined);
    mockReapOrphanedSessions.mockReset();
    mockReconcileSessions.mockReset();
    resetCodeSpaceWorkspaceOwnershipForTests();
    mockLoadPersistedCodeSpaceSnapshot.mockReset();
    mockSavePersistedCodeSpaceSnapshot.mockReset();
    mockLoadPersistedCodeSpaceSnapshot.mockResolvedValue(null);
    mockSavePersistedCodeSpaceSnapshot.mockResolvedValue(undefined);
  });

  it("creates launched workspace cells with explicit cwd and empty runtime identity", async () => {
    const template: LayoutTemplate = {
      id: "two-up",
      name: "Two Up",
      label: "Two Up",
      description: "Two terminal panes",
      rows: 1,
      cols: 2,
      sessions: 2,
    };
    const { result } = renderHook(() => useCodeSpaceWorkspaces());

    await act(async () => {
      await result.current.launchWorkspace(template, "/tmp/project-alpha", ["claude", "codex"], "Alpha");
    });

    expect(mockReapOrphanedSessions).toHaveBeenCalledTimes(1);
    expect(result.current.workspaces).toHaveLength(1);
    expect(result.current.activeWorkspaceId).toBe(result.current.workspaces[0]?.id);
    expect(result.current.workspaces[0]).toEqual(
      expect.objectContaining({
        cwd: "/tmp/project-alpha",
        rows: 1,
        cols: 2,
      }),
    );
    expect(result.current.workspaces[0]?.cells).toEqual([
      expect.objectContaining({
        cwd: "/tmp/project-alpha",
        runtimeSessionId: null,
        agentCommand: "claude",
      }),
      expect.objectContaining({
        cwd: "/tmp/project-alpha",
        runtimeSessionId: null,
        agentCommand: "codex",
      }),
    ]);
  });

  it("preserves explicit cell identity fields when adding and splitting panes", async () => {
    const template: LayoutTemplate = {
      id: "solo",
      name: "Solo",
      label: "Solo",
      description: "Single pane",
      rows: 1,
      cols: 1,
      sessions: 1,
    };
    const { result } = renderHook(() => useCodeSpaceWorkspaces());

    await act(async () => {
      await result.current.launchWorkspace(template, "/tmp/project-beta", [""], "Beta");
    });

    const workspaceId = result.current.workspaces[0]?.id;
    expect(workspaceId).toBeTruthy();

    act(() => {
      result.current.addPane(workspaceId!, "gemini");
      result.current.splitPaneV(workspaceId!);
      result.current.splitPaneH(workspaceId!);
    });

    const workspace = result.current.workspaces[0];
    expect(workspace?.cells).toHaveLength(4);
    expect(workspace?.cells.every((cell) => cell.cwd === "/tmp/project-beta")).toBe(true);
    expect(workspace?.cells.every((cell) => terminalCell(cell).runtimeSessionId === null)).toBe(true);
    expect(workspace?.cells[1]).toEqual(
      expect.objectContaining({
        cwd: "/tmp/project-beta",
        runtimeSessionId: null,
        agentCommand: "gemini",
      }),
    );
  });

  it("restores persisted workspace metadata on startup", async () => {
    mockLoadPersistedCodeSpaceSnapshot.mockResolvedValue({
      workspaces: [
        {
          id: "workspace-restored",
          label: "Restored",
          color: "#4F8CFF",
          cwd: "/tmp/project-restored",
          rows: 1,
          cols: 1,
          rowFractions: [1],
          colFractions: [1],
          cells: [
            {
              id: "pane-restored",
              type: "terminal",
              cwd: "/tmp/project-restored",
              runtimeSessionId: null,
              runtimeStatus: "idle",
            },
          ],
        },
      ],
      activeWorkspaceId: "workspace-restored",
      focusedCellId: "pane-restored",
    });

    const { result } = renderHook(() => useCodeSpaceWorkspaces());

    await waitFor(() => {
      expect(result.current.workspaces[0]?.id).toBe("workspace-restored");
    });

    expect(result.current.activeWorkspaceId).toBe("workspace-restored");
    expect(result.current.focusedCellId).toBe("pane-restored");
  });

  it("saves workspace metadata after hydration and workspace changes", async () => {
    const template: LayoutTemplate = {
      id: "solo",
      name: "Solo",
      label: "Solo",
      description: "Single pane",
      rows: 1,
      cols: 1,
      sessions: 1,
    };
    const { result } = renderHook(() => useCodeSpaceWorkspaces());

    await waitFor(() => {
      expect(mockLoadPersistedCodeSpaceSnapshot).toHaveBeenCalledOnce();
    });

    await act(async () => {
      await result.current.launchWorkspace(template, "/tmp/project-save", ["claude"], "Save");
    });

    await waitFor(() => {
      expect(mockSavePersistedCodeSpaceSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspaces: [
            expect.objectContaining({
              cwd: "/tmp/project-save",
              label: "Save",
            }),
          ],
        }),
      );
    }, { timeout: 1200 });
  });

  describe("session daemon reconcile", () => {
    const restored = {
      workspaces: [
        {
          id: "ws-1",
          label: "One",
          color: "#4F8CFF",
          cwd: "/tmp/one",
          rows: 1,
          cols: 2,
          rowFractions: [1],
          colFractions: [0.5, 0.5],
          cells: [
            { id: "pane-a", type: "terminal", cwd: "/tmp/one", runtimeSessionId: null, runtimeStatus: "idle" },
            { id: "pane-b", type: "terminal", cwd: "/tmp/one", runtimeSessionId: null, runtimeStatus: "idle" },
          ],
        },
      ],
      activeWorkspaceId: "ws-1",
      focusedCellId: "pane-a",
    };

    it("keeps the restored panes' sessions, and only once the restore is in", async () => {
      let load!: (snapshot: typeof restored) => void;
      mockLoadPersistedCodeSpaceSnapshot.mockReturnValue(new Promise((resolve) => { load = resolve; }));
      const { result } = renderHook(() => useCodeSpaceWorkspaces());

      await waitFor(() => expect(mockLoadPersistedCodeSpaceSnapshot).toHaveBeenCalled());
      // Before the restore every pane looks gone: ending sessions now would kill them all.
      expect(mockReconcileSessions).not.toHaveBeenCalled();

      await act(async () => load(restored));
      await waitFor(() => expect(mockReconcileSessions).toHaveBeenCalledExactlyOnceWith(["pane-a", "pane-b"]));
      expect(result.current.workspaces[0]?.id).toBe("ws-1");
    });

    it("ends every pane session when nothing was saved", async () => {
      renderHook(() => useCodeSpaceWorkspaces());
      await waitFor(() => expect(mockReconcileSessions).toHaveBeenCalledExactlyOnceWith([]));
    });

    it("ends nothing when the saved workspaces could not be read", async () => {
      mockLoadPersistedCodeSpaceSnapshot.mockRejectedValue(new Error("corrupt"));
      const { result } = renderHook(() => useCodeSpaceWorkspaces());
      await waitFor(() => expect(result.current.workspaces).toEqual([]));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mockReconcileSessions).not.toHaveBeenCalled();
    });

    it("runs once per window, not once per mount", async () => {
      const first = renderHook(() => useCodeSpaceWorkspaces());
      await waitFor(() => expect(mockReconcileSessions).toHaveBeenCalledOnce());
      first.unmount();
      renderHook(() => useCodeSpaceWorkspaces());
      await waitFor(() => expect(mockLoadPersistedCodeSpaceSnapshot).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mockReconcileSessions).toHaveBeenCalledOnce();
    });
  });
});
