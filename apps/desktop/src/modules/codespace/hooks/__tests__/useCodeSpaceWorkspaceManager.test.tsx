import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GridCell, LayoutTemplate, TerminalCellData } from "@/modules/codespace/components/types";
import { useCodeSpaceWorkspaceManager } from "@/modules/codespace/hooks/useCodeSpaceWorkspaceManager";
import { REMOTE_LOGIN_SHELL, quoteRemoteShellArg } from "@/modules/codespace/services/ssh-command";
import {
  createTerminalV2LayoutFromPaneIds,
  type TerminalV2LayoutNode,
} from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";

const sshResolveRemoteCwd = vi.fn(async (_target: unknown, hint?: string) => {
  const trimmed = hint?.trim();
  return trimmed && trimmed.startsWith("/") ? trimmed : "/home/alwi";
});

vi.mock("@/lib/tauri/codespace-editor-ssh", () => ({
  sshResolveRemoteCwd: (...args: unknown[]) =>
    // Forward through the spy so tests can assert on calls.
    (sshResolveRemoteCwd as unknown as (...a: unknown[]) => Promise<string>)(...args),
}));

const closeTerminalSession = vi.hoisted(() => vi.fn());

vi.mock("@/modules/codespace/services/terminal-session-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/codespace/services/terminal-session-registry")>()),
  closeTerminalSession,
}));

beforeEach(() => {
  closeTerminalSession.mockClear();
  sshResolveRemoteCwd.mockClear();
  sshResolveRemoteCwd.mockImplementation(async (_target: unknown, hint?: string) => {
    const trimmed = hint?.trim();
    return trimmed && trimmed.startsWith("/") ? trimmed : "/home/alwi";
  });
});

const template: LayoutTemplate = {
  id: "solo",
  name: "Solo",
  label: "Solo",
  description: "Single pane",
  rows: 1,
  cols: 1,
  sessions: 1,
};

const twoPaneTemplate: LayoutTemplate = {
  id: "pair",
  name: "Pair",
  label: "Pair",
  description: "Two panes",
  rows: 1,
  cols: 2,
  sessions: 2,
};

function terminalCell(cell: GridCell | undefined): TerminalCellData {
  expect(cell?.type).toBe("terminal");
  return cell as TerminalCellData;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("useCodeSpaceWorkspaceManager", () => {
  // Seen live: two panes named from snapshots a render old both got "Ivo".
  it("keeps pane names unique when two identity patches name two panes the same", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());
    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/two", ["cursor-agent", "codex"], "Two");
    });
    const workspace = result.current.workspaces[0]!;
    const [a, b] = workspace.cells;
    act(() => {
      result.current.updateTerminalAgentIdentity(workspace.id, a!.id, { agentName: "Ivo" });
      result.current.updateTerminalAgentIdentity(workspace.id, b!.id, { agentName: "Ivo" });
    });
    const names = result.current.workspaces[0]!.cells.map((c) => (c as TerminalCellData).agentName);
    expect(names[0]).toBe("Ivo");
    expect(names[1]).toBeTruthy();
    expect(names[1]).not.toBe("Ivo");
  });

  it("creates a workspace and activates its first cell", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project-manager", ["claude"], "Manager");
    });

    expect(result.current.workspaces).toHaveLength(1);
    expect(result.current.workspaces[0]).toEqual(
      expect.objectContaining({
        cwd: "/tmp/project-manager",
        label: "Manager",
      }),
    );
    expect(result.current.activeWorkspaceId).toBe(result.current.workspaces[0]?.id);
    expect(result.current.focusedCellId).toBe(result.current.workspaces[0]?.cells[0]?.id ?? null);
  });

  it("moving a direct-launch agent pane to another account rebuilds its argv with --resume", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());
    act(() => {
      result.current.createWorkspace(template, "/tmp/acct", ["claude"], "Acct");
    });
    const workspaceId = result.current.workspaces[0]!.id;
    let cellId = "";
    act(() => {
      cellId = result.current.addPane(workspaceId, "claude --dangerously-skip-permissions") ?? "";
    });
    const pane = () => result.current.workspaces[0]!.cells.find((c) => c.id === cellId) as TerminalCellData;
    expect(pane().terminalCommand?.[0]).toBe("claude");

    act(() => {
      result.current.moveTerminalToAccount(workspaceId, cellId, "mvn", "claude --dangerously-skip-permissions --resume 4f1c");
    });
    expect(pane().claudeAccount).toBe("mvn");
    expect(pane().terminalCommand).toEqual(expect.arrayContaining(["--resume", "4f1c"]));
  });

  it("relaunching a pane closes its PTY and hands the terminal a fresh copy of the same argv", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());
    act(() => {
      result.current.createWorkspace(template, "/tmp/relaunch", ["claude"], "Relaunch");
    });
    const workspaceId = result.current.workspaces[0]!.id;
    let cellId = "";
    act(() => {
      cellId = result.current.addPane(workspaceId, "claude") ?? "";
    });
    const pane = () => result.current.workspaces[0]!.cells.find((c) => c.id === cellId) as TerminalCellData;
    const before = pane().terminalCommand;
    closeTerminalSession.mockClear();

    act(() => {
      result.current.relaunchTerminal(workspaceId, cellId);
    });

    expect(closeTerminalSession).toHaveBeenCalledWith(cellId);
    expect(pane().terminalCommand).toEqual(before);
    expect(pane().terminalCommand).not.toBe(before);
    expect(pane().runtimeSessionId).toBeNull();
  });

  describe("a reopened folder keeps its workspace id", () => {
    it("reuses the id a closed workspace of the same folder had", () => {
      const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

      act(() => {
        result.current.rememberKnownWorkspaces([
          { id: "ws-lotus-old", label: "Lotus", cwd: "/work/Lotus", location: { kind: "local", cwd: "/work/Lotus" }, lastSeenAt: 1 },
        ]);
      });
      act(() => {
        result.current.createWorkspace(template, "/work/Lotus", ["claude"], "Lotus");
      });

      expect(result.current.workspaces[0]?.id).toBe("ws-lotus-old");
      expect(result.current.activeWorkspaceId).toBe("ws-lotus-old");
    });

    it("keeps the id when a folder is closed and reopened in the same session", () => {
      const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

      act(() => {
        result.current.createWorkspace(template, "/work/hr-portal", ["claude"], "hr-portal");
      });
      const first = result.current.workspaces[0]!.id;
      act(() => {
        result.current.closeWorkspace(first);
      });
      act(() => {
        result.current.createWorkspace(template, "/work/hr-portal/", ["claude"], "hr-portal");
      });

      expect(result.current.workspaces.map((w) => w.id)).toEqual([first]);
    });

    it("gives a second workspace on an open folder its own id", () => {
      const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

      act(() => {
        result.current.createWorkspace(template, "/work/Lotus", ["claude"], "Lotus");
      });
      act(() => {
        result.current.createWorkspace(template, "/work/Lotus", ["claude"], "Lotus 2");
      });

      const [a, b] = result.current.workspaces.map((w) => w.id);
      expect(a).not.toBe(b);
    });

    it("reuses the id of a closed SSH workspace on the same host, user, port and folder", async () => {
      const { result } = renderHook(() => useCodeSpaceWorkspaceManager());
      act(() => {
        result.current.rememberKnownWorkspaces([
          {
            id: "ws-vps-old",
            label: "vps",
            cwd: "/srv/app",
            location: { kind: "ssh", host: "vps", user: "alwi", port: 22, remoteCwd: "/srv/app" },
            lastSeenAt: 1,
          },
        ]);
      });

      await act(async () => {
        await result.current.createSshWorkspace({ host: "vps", user: "alwi", port: 22 }, "vps", "/srv/app");
      });

      expect(result.current.workspaces[0]?.id).toBe("ws-vps-old");
    });
  });

  it("updates Terminal V2 layout metadata independently from legacy pane layout mode", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/project-v2-layout", ["claude", "codex"], "V2 Layout");
    });

    const workspaceId = result.current.workspaces[0]!.id;
    const [pane1, pane2] = result.current.workspaces[0]!.cells.map((cell) => cell.id);

    act(() => {
      result.current.updateWorkspacePaneLayout(workspaceId, {
        mode: "grid",
        focusCellId: null,
        terminalV2Layout: {
          root: {
            kind: "split",
            direction: "horizontal",
            sizes: [50, 50],
            children: [
              { kind: "leaf", paneId: pane1! },
              { kind: "leaf", paneId: pane2! },
            ],
          },
          activePaneId: pane2!,
        },
      });
    });

    expect(result.current.workspaces[0]?.paneLayout?.terminalV2Layout?.activePaneId).toBe(pane2);

    act(() => {
      result.current.updateWorkspacePaneLayout(workspaceId, {
        ...result.current.workspaces[0]!.paneLayout!,
        terminalV2Layout: {
          ...result.current.workspaces[0]!.paneLayout!.terminalV2Layout!,
          activePaneId: pane1!,
        },
      });
    });

    expect(result.current.workspaces[0]?.paneLayout?.terminalV2Layout?.activePaneId).toBe(pane1);
  });

  it("updates Terminal V2 active pane metadata when focusing through the manager", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/project-v2-focus", ["claude", "codex"], "V2 Focus");
    });

    const workspaceId = result.current.workspaces[0]!.id;
    const [pane1, pane2] = result.current.workspaces[0]!.cells.map((cell) => cell.id);

    act(() => {
      result.current.updateWorkspacePaneLayout(workspaceId, {
        mode: "grid",
        focusCellId: null,
        terminalV2Layout: {
          root: {
            kind: "split",
            direction: "horizontal",
            sizes: [50, 50],
            children: [
              { kind: "leaf", paneId: pane1! },
              { kind: "leaf", paneId: pane2! },
            ],
          },
          activePaneId: pane1!,
        },
      });
      result.current.setFocusedCellId(pane2!);
    });

    expect(result.current.focusedCellId).toBe(pane2);
    expect(result.current.workspaces[0]?.paneLayout?.terminalV2Layout?.activePaneId).toBe(pane2);
  });

  it("focuses the newly-created pane after splitting a Terminal V2 dynamic layout pane", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project-v2-split-focus", ["claude"], "V2 Split Focus");
    });

    const workspaceId = result.current.workspaces[0]!.id;
    const pane1 = result.current.workspaces[0]!.cells[0]!.id;

    act(() => {
      result.current.updateWorkspacePaneLayout(workspaceId, {
        mode: "grid",
        focusCellId: null,
        terminalV2Layout: { root: { kind: "leaf", paneId: pane1 }, activePaneId: pane1 },
      });
      result.current.splitPaneH(workspaceId, pane1);
    });

    const pane2 = result.current.workspaces[0]!.cells[1]!.id;
    expect(result.current.focusedCellId).toBe(pane2);
    expect(result.current.workspaces[0]?.paneLayout?.terminalV2Layout?.activePaneId).toBe(pane2);
  });

  it("splits Terminal V2 dynamic layout panes through the workspace manager", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project-v2-split", ["claude"], "V2 Split");
    });

    const workspaceId = result.current.workspaces[0]!.id;
    const pane1 = result.current.workspaces[0]!.cells[0]!.id;

    act(() => {
      result.current.updateWorkspacePaneLayout(workspaceId, {
        mode: "grid",
        focusCellId: null,
        terminalV2Layout: { root: { kind: "leaf", paneId: pane1 }, activePaneId: pane1 },
      });
    });

    act(() => {
      result.current.splitPaneV(workspaceId, pane1);
    });

    const cells = result.current.workspaces[0]!.cells;
    const pane2 = cells[1]!.id;
    expect(result.current.workspaces[0]?.paneLayout?.terminalV2Layout).toEqual({
      root: {
        kind: "split",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          { kind: "leaf", paneId: pane1 },
          { kind: "leaf", paneId: pane2 },
        ],
      },
      activePaneId: pane2,
    });
  });

  it("keeps legacy grid tracks unchanged when splitting Terminal V2 dynamic layout panes", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project-v2-no-grid", ["claude"], "V2 No Grid");
    });

    const workspaceId = result.current.workspaces[0]!.id;
    const pane1 = result.current.workspaces[0]!.cells[0]!.id;
    const originalGrid = {
      rows: result.current.workspaces[0]!.rows,
      cols: result.current.workspaces[0]!.cols,
      rowFractions: result.current.workspaces[0]!.rowFractions,
      colFractions: result.current.workspaces[0]!.colFractions,
    };

    act(() => {
      result.current.updateWorkspacePaneLayout(workspaceId, {
        mode: "grid",
        focusCellId: null,
        terminalV2Layout: { root: { kind: "leaf", paneId: pane1 }, activePaneId: pane1 },
      });
      result.current.splitPaneV(workspaceId, pane1);
      result.current.splitPaneH(workspaceId, pane1);
    });

    expect(result.current.workspaces[0]).toEqual(expect.objectContaining(originalGrid));
    expect(result.current.workspaces[0]?.cells).toHaveLength(3);
  });

  it("maps Terminal V2 row splits to vertical layout splits", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project-v2-row-split", ["claude"], "V2 Row Split");
    });

    const workspaceId = result.current.workspaces[0]!.id;
    const pane1 = result.current.workspaces[0]!.cells[0]!.id;

    act(() => {
      result.current.updateWorkspacePaneLayout(workspaceId, {
        mode: "grid",
        focusCellId: null,
        terminalV2Layout: { root: { kind: "leaf", paneId: pane1 }, activePaneId: pane1 },
      });
      result.current.splitPaneH(workspaceId, pane1);
    });

    const pane2 = result.current.workspaces[0]!.cells[1]!.id;
    expect(result.current.workspaces[0]?.paneLayout?.terminalV2Layout?.root).toEqual({
      kind: "split",
      direction: "vertical",
      sizes: [50, 50],
      children: [
        { kind: "leaf", paneId: pane1 },
        { kind: "leaf", paneId: pane2 },
      ],
    });
  });

  it("keeps legacy grid tracks unchanged when removing Terminal V2 dynamic layout panes", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/project-v2-remove-no-grid", ["claude", "codex"], "V2 Remove No Grid");
    });

    const workspaceId = result.current.workspaces[0]!.id;
    const [pane1, pane2] = result.current.workspaces[0]!.cells.map((cell) => cell.id);
    const originalGrid = {
      rows: result.current.workspaces[0]!.rows,
      cols: result.current.workspaces[0]!.cols,
      rowFractions: result.current.workspaces[0]!.rowFractions,
      colFractions: result.current.workspaces[0]!.colFractions,
    };

    act(() => {
      result.current.updateWorkspacePaneLayout(workspaceId, {
        mode: "grid",
        focusCellId: null,
        terminalV2Layout: {
          root: {
            kind: "split",
            direction: "horizontal",
            sizes: [50, 50],
            children: [
              { kind: "leaf", paneId: pane1! },
              { kind: "leaf", paneId: pane2! },
            ],
          },
          activePaneId: pane2!,
        },
      });
      result.current.removePane(workspaceId, pane2!);
    });

    expect(result.current.workspaces[0]).toEqual(expect.objectContaining(originalGrid));
    expect(result.current.workspaces[0]?.cells).toHaveLength(1);
  });

  it("focuses the next visual V2 pane after closing the active pane", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace({ id: "three", sessions: 3, rows: 1, cols: 3, label: "Three" }, "/tmp/project-v2-close-focus", ["claude", "codex", "gemini"], "V2 Close Focus");
    });

    const workspaceId = result.current.workspaces[0]!.id;
    const [pane1, pane2, pane3] = result.current.workspaces[0]!.cells.map((cell) => cell.id);

    act(() => {
      result.current.updateWorkspacePaneLayout(workspaceId, {
        mode: "grid",
        focusCellId: null,
        terminalV2Layout: {
          root: {
            kind: "split",
            direction: "horizontal",
            sizes: [33.33, 33.33, 33.34],
            children: [
              { kind: "leaf", paneId: pane1! },
              { kind: "leaf", paneId: pane2! },
              { kind: "leaf", paneId: pane3! },
            ],
          },
          activePaneId: pane2!,
        },
      });
      result.current.setFocusedCellId(pane2!);
    });

    act(() => {
      result.current.removePane(workspaceId, pane2!);
    });

    expect(result.current.focusedCellId).toBe(pane3);
    expect(result.current.workspaces[0]?.paneLayout?.terminalV2Layout?.activePaneId).toBe(pane3);
  });

  it("collapses Terminal V2 dynamic layout metadata when removing a pane", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/project-v2-remove", ["claude", "codex"], "V2 Remove");
    });

    const workspaceId = result.current.workspaces[0]!.id;
    const [pane1, pane2] = result.current.workspaces[0]!.cells.map((cell) => cell.id);

    act(() => {
      result.current.updateWorkspacePaneLayout(workspaceId, {
        mode: "grid",
        focusCellId: null,
        terminalV2Layout: {
          root: {
            kind: "split",
            direction: "horizontal",
            sizes: [50, 50],
            children: [
              { kind: "leaf", paneId: pane1! },
              { kind: "leaf", paneId: pane2! },
            ],
          },
          activePaneId: pane2!,
        },
      });
      result.current.removePane(workspaceId, pane2!);
    });

    expect(result.current.workspaces[0]?.paneLayout?.terminalV2Layout).toEqual({
      root: { kind: "leaf", paneId: pane1 },
      activePaneId: pane1,
    });
  });

  it("creates mixed cell workspaces without assigning terminal runtime fields to non-terminal cells", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(
        twoPaneTemplate,
        "/tmp/project-mixed",
        ["claude", "codex"],
        "Mixed",
        ["terminal", "workbench"],
      );
    });

    expect(result.current.workspaces[0]?.cells[0]).toEqual(
      expect.objectContaining({
        type: "terminal",
        agentCommand: "claude",
        runtimeStatus: "idle",
      }),
    );
    expect(result.current.workspaces[0]?.cells[1]).toEqual(
      expect.objectContaining({
        type: "workbench",
        rootDir: "/tmp/project-mixed",
        tabs: [],
        activeTabId: null,
      }),
    );
    expect(result.current.workspaces[0]?.cells[1]).not.toHaveProperty("agentCommand");
  });

  it("creates an SSH workspace backed by an ssh command session", async () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    await act(async () => {
      await result.current.createSshWorkspace(
        { host: "devbox-vps", user: "alwi", port: 2222 },
        "Devbox VPS",
        "/home/alwi/workspace/acme-main",
      );
    });

    expect(sshResolveRemoteCwd).not.toHaveBeenCalled();
    expect(result.current.workspaces).toHaveLength(1);
    expect(result.current.workspaces[0]).toEqual(
      expect.objectContaining({
        cwd: "/home/alwi/workspace/acme-main",
        label: "Devbox VPS",
        location: {
          kind: "ssh",
          host: "devbox-vps",
          user: "alwi",
          port: 2222,
          remoteCwd: "/home/alwi/workspace/acme-main",
          label: "Devbox VPS",
        },
      }),
    );
    expect(terminalCell(result.current.workspaces[0]?.cells[0]).terminalCommand).toEqual([
      "ssh",
      "-t",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-p",
      "2222",
      "alwi@devbox-vps",
      `cd '/home/alwi/workspace/acme-main' && ${REMOTE_LOGIN_SHELL}`,
    ]);
    expect(result.current.activeWorkspaceId).toBe(result.current.workspaces[0]?.id);
    expect(result.current.focusedCellId).toBe(result.current.workspaces[0]?.cells[0]?.id);
  });

  it("creates an SSH workspace with a layout: one ssh login per pane, the agent as its first command", async () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());
    const quad = { id: "4", label: "4", sessions: 4, rows: 2, cols: 2 };

    await act(async () => {
      await result.current.createSshWorkspace({ host: "devbox-vps", user: "alwi" }, "VPS", "/srv/app", quad, ["claude", "codex", "", ""]);
    });

    const ws = result.current.workspaces[0]!;
    expect(ws).toEqual(expect.objectContaining({ rows: 2, cols: 2, location: expect.objectContaining({ kind: "ssh", remoteCwd: "/srv/app" }) }));
    expect(ws.cells).toHaveLength(4);
    const cmds = ws.cells.map(c => terminalCell(c).terminalCommand?.at(-1));
    expect(cmds[0]).toContain("claude");
    expect(cmds[1]).toContain("codex");
    expect(cmds[2]).toBe(`cd '/srv/app' && ${REMOTE_LOGIN_SHELL}`);
    expect(terminalCell(ws.cells[0]).agentCommand).toBe("claude");
    expect(terminalCell(ws.cells[2]).agentCommand).toBeUndefined();
  });

  it("launches new SSH panes in the requested remote cwd", async () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    await act(async () => {
      await result.current.createSshWorkspace(
        { host: "devbox-vps", user: "alwi", port: 2222 },
        "Devbox VPS",
        "/home/alwi/workspace/app",
      );
    });

    const workspaceId = result.current.workspaces[0]?.id;
    expect(workspaceId).toBeTruthy();

    act(() => {
      result.current.addPane(workspaceId!, "lazygit", "/home/alwi/workspace");
    });

    expect(result.current.workspaces[0]?.cells[1]).toEqual(
      expect.objectContaining({
        cwd: "/home/alwi/workspace",
        terminalCommand: [
          "ssh",
          "-t",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=3",
          "-p",
          "2222",
          "alwi@devbox-vps",
          `cd '/home/alwi/workspace' && exec \${SHELL:-bash} -lic ${quoteRemoteShellArg(`lazygit; printf "\\033]133;D\\007"; ${REMOTE_LOGIN_SHELL}`)}`,
        ],
      }),
    );
  });

  it("an SSH agent that exits to its remote prompt leaves a bare ssh login; a dead one is left alone", async () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());
    await act(async () => {
      await result.current.createSshWorkspace({ host: "devbox-vps", user: "alwi" }, "VPS", "/home/alwi/app");
    });
    const workspaceId = result.current.workspaces[0]!.id;
    let paneId = "";
    act(() => {
      paneId = result.current.addPane(workspaceId, "claude", "/home/alwi/app");
    });

    act(() => result.current.fallBackToShell(workspaceId, paneId));
    expect(result.current.workspaces[0]?.cells[1]).toEqual(expect.objectContaining({ agentCommand: "claude" }));

    act(() => result.current.fallBackToShell(workspaceId, paneId, true));
    expect(result.current.workspaces[0]?.cells[1]).toEqual(
      expect.objectContaining({
        agentCommand: undefined,
        terminalCommand: ["ssh", "-t", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "alwi@devbox-vps", `cd '/home/alwi/app' && ${REMOTE_LOGIN_SHELL}`],
      }),
    );
  });

  it("opens an SSH workspace immediately when remote cwd probing times out", async () => {
    sshResolveRemoteCwd.mockRejectedValueOnce(new Error("Connection timed out during banner exchange"));
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    await act(async () => {
      await result.current.createSshWorkspace(
        { host: "devbox-vps", user: "alwi", port: 2222 },
        "Devbox VPS",
      );
    });

    expect(sshResolveRemoteCwd).toHaveBeenCalledWith(
      expect.objectContaining({ host: "devbox-vps" }),
      undefined,
    );
    expect(result.current.workspaces[0]?.cwd).toBe("~");
    expect(result.current.workspaces[0]?.location).toEqual(
      expect.objectContaining({
        kind: "ssh",
        remoteCwd: undefined,
      }),
    );
    expect(result.current.workspaces[0]?.cells[0]?.cwd).toBe("~");
    expect(terminalCell(result.current.workspaces[0]?.cells[0]).terminalCommand).toEqual([
      "ssh",
      "-t",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-p",
      "2222",
      "alwi@devbox-vps",
      REMOTE_LOGIN_SHELL,
    ]);
  });

  it("updates SSH workspace metadata when the background cwd probe succeeds", async () => {
    const probe = deferred<string>();
    sshResolveRemoteCwd.mockImplementationOnce(() => probe.promise);
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    await act(async () => {
      await result.current.createSshWorkspace(
        { host: "devbox-vps", user: "alwi", port: 2222 },
        "Devbox VPS",
      );
    });

    const workspaceId = result.current.workspaces[0]?.id;
    const cellId = result.current.workspaces[0]?.cells[0]?.id;
    expect(workspaceId).toBeTruthy();
    expect(result.current.workspaces[0]?.cwd).toBe("~");
    expect(result.current.workspaces[0]?.location).toEqual(
      expect.objectContaining({
        kind: "ssh",
        remoteCwd: undefined,
      }),
    );

    await act(async () => {
      probe.resolve("/home/alwi");
      await probe.promise;
    });

    expect(result.current.workspaces[0]).toEqual(
      expect.objectContaining({
        id: workspaceId,
        cwd: "/home/alwi",
        location: expect.objectContaining({
          kind: "ssh",
          remoteCwd: "/home/alwi",
        }),
      }),
    );
    expect(result.current.workspaces[0]?.cells[0]?.id).toBe(cellId);
    expect(result.current.workspaces[0]?.cells[0]?.cwd).toBe("~");
  });

  it("updates an SSH workspace cwd from terminal shell integration without remounting terminal cells", async () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    await act(async () => {
      await result.current.createSshWorkspace(
        { host: "devbox-vps", user: "alwi", port: 2222 },
        "Devbox VPS",
        "/home/alwi",
      );
    });

    const workspaceId = result.current.workspaces[0]?.id;
    const cellId = result.current.workspaces[0]?.cells[0]?.id;
    expect(workspaceId).toBeTruthy();
    expect(result.current.workspaces[0]?.cwd).toBe("/home/alwi");

    act(() => {
      result.current.updateSshWorkspaceCwd(
        workspaceId!,
        "/home/alwi/workspace/acme-main",
      );
    });

    expect(result.current.workspaces[0]).toEqual(
      expect.objectContaining({
        cwd: "/home/alwi/workspace/acme-main",
        location: expect.objectContaining({
          kind: "ssh",
          remoteCwd: "/home/alwi/workspace/acme-main",
        }),
      }),
    );
    expect(result.current.workspaces[0]?.cells[0]?.id).toBe(cellId);
    expect(result.current.workspaces[0]?.cells[0]?.cwd).toBe("/home/alwi");
  });

  it("selects a workspace and focuses its first cell", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project-a", [""], "A");
      result.current.createWorkspace(template, "/tmp/project-b", [""], "B");
    });

    const secondWorkspaceId = result.current.workspaces[1]?.id;
    expect(secondWorkspaceId).toBeTruthy();

    act(() => {
      result.current.handleSelectWorkspace(secondWorkspaceId!);
    });

    expect(result.current.activeWorkspaceId).toBe(secondWorkspaceId);
    expect(result.current.focusedCellId).toBe(result.current.workspaces[1]?.cells[0]?.id);
  });

  it("tracks runtime session ids on individual cells", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project-runtime", ["claude"], "Runtime");
    });

    const workspace = result.current.workspaces[0];
    const workspaceId = workspace?.id;
    const cellId = workspace?.cells[0]?.id;
    expect(workspaceId).toBeTruthy();
    expect(cellId).toBeTruthy();

    act(() => {
      result.current.updateCellRuntimeSessionId(workspaceId!, cellId!, "session-123");
    });

    expect(terminalCell(result.current.workspaces[0]?.cells[0]).runtimeSessionId).toBe("session-123");

    act(() => {
      result.current.updateCellRuntimeSessionId(workspaceId!, cellId!, null);
    });

    expect(terminalCell(result.current.workspaces[0]?.cells[0]).runtimeSessionId).toBeNull();
  });

  it("tracks runtime statuses on individual cells", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project-status", ["claude"], "Status");
    });

    const workspaceId = result.current.workspaces[0]?.id;
    const cellId = result.current.workspaces[0]?.cells[0]?.id;
    expect(workspaceId).toBeTruthy();
    expect(cellId).toBeTruthy();
    expect(terminalCell(result.current.workspaces[0]?.cells[0]).runtimeStatus).toBe("idle");

    act(() => {
      result.current.updateCellRuntimeStatus(workspaceId!, cellId!, "live");
    });

    expect(terminalCell(result.current.workspaces[0]?.cells[0]).runtimeStatus).toBe("live");

    act(() => {
      result.current.updateCellRuntimeStatus(workspaceId!, cellId!, "detached");
    });

    expect(terminalCell(result.current.workspaces[0]?.cells[0]).runtimeStatus).toBe("detached");
  });

  it("restores a persisted workspace snapshot", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project-old", [""], "Old");
    });

    act(() => {
      result.current.restoreWorkspaceSnapshot({
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
    });

    expect(result.current.workspaces).toHaveLength(1);
    expect(result.current.workspaces[0]?.id).toBe("workspace-restored");
    expect(result.current.activeWorkspaceId).toBe("workspace-restored");
    expect(result.current.focusedCellId).toBe("pane-restored");
  });

  it("closes a terminal pane immediately", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/project-close", ["claude", "codex"], "Close");
    });

    const workspaceId = result.current.workspaces[0]?.id;
    const cellId = result.current.workspaces[0]?.cells[0]?.id;
    expect(workspaceId).toBeTruthy();
    expect(cellId).toBeTruthy();

    act(() => {
      result.current.removePane(workspaceId!, cellId!);
    });

    expect(result.current.workspaces[0]?.cells).toHaveLength(1);
    expect(result.current.workspaces[0]?.cells[0]?.id).not.toBe(cellId);
  });

  it("ends the PTY of a closed pane, and only that one", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());
    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/project-kill", ["claude", "codex"], "Kill");
    });
    const workspaceId = result.current.workspaces[0]!.id;
    const [closed, kept] = result.current.workspaces[0]!.cells.map((cell) => cell.id);

    act(() => {
      result.current.removePane(workspaceId, closed!);
    });

    expect(closeTerminalSession).toHaveBeenCalledWith(closed);
    expect(closeTerminalSession).not.toHaveBeenCalledWith(kept);
  });

  it("ends the PTY of every pane in a closed workspace", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());
    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/project-kill-all", ["claude", "codex"], "Kill all");
    });
    const workspace = result.current.workspaces[0]!;

    act(() => {
      result.current.closeWorkspace(workspace.id);
    });

    for (const cell of workspace.cells) expect(closeTerminalSession).toHaveBeenCalledWith(cell.id);
  });

  it("closes the workspace after removing the last terminal pane", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project-last-pane", ["claude"], "Last");
    });

    const workspaceId = result.current.workspaces[0]?.id;
    const cellId = result.current.workspaces[0]?.cells[0]?.id;
    expect(workspaceId).toBeTruthy();
    expect(cellId).toBeTruthy();

    act(() => {
      result.current.removePane(workspaceId!, cellId!);
    });

    expect(result.current.workspaces).toHaveLength(0);
    expect(result.current.activeWorkspaceId).toBeNull();
  });

  it("moves focus to the fallback workspace when closing the active workspace", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project-a", [""], "A");
      result.current.createWorkspace(template, "/tmp/project-b", [""], "B");
    });

    const closingWorkspaceId = result.current.workspaces[1]?.id;
    const fallbackWorkspaceId = result.current.workspaces[0]?.id;
    const fallbackCellId = result.current.workspaces[0]?.cells[0]?.id;
    expect(closingWorkspaceId).toBeTruthy();
    expect(fallbackWorkspaceId).toBeTruthy();
    expect(fallbackCellId).toBeTruthy();

    act(() => {
      result.current.closeWorkspace(closingWorkspaceId!);
    });

    expect(result.current.activeWorkspaceId).toBe(fallbackWorkspaceId);
    expect(result.current.focusedCellId).toBe(fallbackCellId);
  });

  it("tracks the workspace requested for close confirmation", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project-workspace-close", ["claude"], "Close Workspace");
    });

    const workspaceId = result.current.workspaces[0]?.id;
    expect(workspaceId).toBeTruthy();

    act(() => {
      result.current.requestCloseWorkspace(workspaceId!);
    });

    expect(result.current.confirmCloseWorkspaceId).toBe(workspaceId);

    act(() => {
      result.current.closeWorkspace(workspaceId!);
    });

    expect(result.current.confirmCloseWorkspaceId).toBeNull();
  });
});

// Slice 02: system-allocated human names (Nara, Bima, …) for agent cells.
describe("agent naming (slice 02)", () => {
  it("gives two agents added to one workspace different names, even in the same tick", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());
    act(() => {
      result.current.createWorkspace(template, "/tmp/naming", [], "Naming");
    });
    const workspaceId = result.current.workspaces[0]!.id;

    // Two calls inside one `act()` — both `addPane` invocations run before React commits
    // either state update, exercising the same-tick collision this test is named for.
    act(() => {
      result.current.addPane(workspaceId, "claude");
      result.current.addPane(workspaceId, "claude");
    });

    const cells = result.current.workspaces[0]!.cells.map(terminalCell);
    // The initial pane from createWorkspace([]) is shell — only the two just-added agent
    // panes should carry a name at all.
    const named = cells.filter((c) => c.agentName);
    expect(named).toHaveLength(2);
    expect(named[0]!.agentName).toBeTruthy();
    expect(named[0]!.agentName).not.toBe(named[1]!.agentName);
  });

  it("does not give a Shell pane a name from the pool", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());
    act(() => {
      result.current.createWorkspace(template, "/tmp/naming-shell", [], "NamingShell");
    });
    const workspaceId = result.current.workspaces[0]!.id;

    act(() => {
      result.current.addPane(workspaceId, "");
    });

    const cells = result.current.workspaces[0]!.cells.map(terminalCell);
    expect(cells.at(-1)!.agentName).toBeUndefined();
  });

  // Real uniqueness is agentAddress + workspace scoping (already built); a name repeating
  // across workspaces is a deliberate, accepted trade-off, not a bug — nothing cross-checks
  // `taken` between workspaces. Pinning Math.random makes the (now-shuffled, slice 03) draw
  // deterministic so both workspaces land on the SAME name, to observe that directly rather
  // than relying on a real-random coincidence.
  it("allows the same name to appear in two different workspaces", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const { result } = renderHook(() => useCodeSpaceWorkspaceManager());
      act(() => {
        result.current.createWorkspace(template, "/tmp/ws-a", [], "A");
      });
      act(() => {
        result.current.createWorkspace(template, "/tmp/ws-b", [], "B");
      });
      const idA = result.current.workspaces.find((w) => w.label === "A")!.id;
      const idB = result.current.workspaces.find((w) => w.label === "B")!.id;

      act(() => {
        result.current.addPane(idA, "claude");
      });
      act(() => {
        result.current.addPane(idB, "claude");
      });

      const nameA = terminalCell(result.current.workspaces.find((w) => w.id === idA)!.cells.at(-1)).agentName;
      const nameB = terminalCell(result.current.workspaces.find((w) => w.id === idB)!.cells.at(-1)).agentName;
      expect(nameA).toBeTruthy();
      expect(nameA).toBe(nameB);
    } finally {
      randomSpy.mockRestore();
    }
  });

  // Slice 03: the name pool is now shuffled per draw. If that draw happened INSIDE
  // setWorkspaces's updater instead of before it (as it does), StrictMode's double-invoked
  // updater would draw two different shuffled orders for the same addPane call. One addPane
  // call must still add exactly one pane with one name.
  it("(slice 03) adds exactly one named pane per addPane call under StrictMode's double-invoked updater", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager(), { wrapper: StrictMode });
    act(() => {
      result.current.createWorkspace(template, "/tmp/naming-strict", [], "NamingStrict");
    });
    const workspaceId = result.current.workspaces[0]!.id;

    act(() => {
      result.current.addPane(workspaceId, "claude");
    });

    const cells = result.current.workspaces[0]!.cells.map(terminalCell);
    const named = cells.filter((c) => c.agentName);
    expect(named).toHaveLength(1);
    expect(named[0]!.agentName).toBeTruthy();
  });
});

describe("addChatPane (M1.3)", () => {
  it("adds a pane that points at a conversation, and returns its id", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project", ["claude"], "Project");
    });
    const workspaceId = result.current.workspaces[0].id;

    let paneId = "";
    act(() => {
      paneId = result.current.addChatPane(workspaceId, "session-7");
    });

    const pane = result.current.workspaces[0].cells.find((cell) => cell.id === paneId);
    expect(pane).toMatchObject({ type: "chat", sessionId: "session-7", cwd: "/tmp/project" });
  });

  it("never invents a conversation of its own — the id comes from the caller", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project", ["claude"], "Project");
    });
    const workspaceId = result.current.workspaces[0].id;

    act(() => {
      result.current.addChatPane(workspaceId, "session-a");
      result.current.addChatPane(workspaceId, "session-b");
    });

    const chatPanes = result.current.workspaces[0].cells.filter((cell) => cell.type === "chat");
    expect(chatPanes.map((cell) => (cell as { sessionId: string }).sessionId)).toEqual([
      "session-a",
      "session-b",
    ]);
  });


  /**
   * The test that was missing on 2026-09-20.
   *
   * The first version of `addChatPane` appended to `workspace.cells` and recomputed rows/cols.
   * Every assertion about cells passed, and the pane was still INVISIBLE in the running app: a
   * workspace laid out by the terminal-v2 tree draws only panes the tree knows about. "It is in
   * the state" is not "it is on the screen".
   */
  it("puts the pane in the layout tree, not only in the cells array", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/project-chat-layout", ["claude", "codex"], "Chat Layout");
    });
    const workspaceId = result.current.workspaces[0].id;
    // Seed the tree the way the running app has it: the layout bridge builds it in the browser,
    // and jsdom has no bridge, so the state is installed directly here.
    const existingPaneIds = result.current.workspaces[0].cells.map((cell) => cell.id);
    act(() => {
      result.current.updateWorkspacePaneLayout(workspaceId, {
        mode: "grid",
        terminalV2Layout: createTerminalV2LayoutFromPaneIds(existingPaneIds, existingPaneIds[0]),
      });
    });
    const layoutBefore = result.current.workspaces[0].paneLayout?.terminalV2Layout;
    // Guard the guard: if this workspace has no tree, the test proves nothing.
    expect(layoutBefore).toBeTruthy();

    let paneId = "";
    act(() => {
      paneId = result.current.addChatPane(workspaceId, "session-7");
    });

    const collectPaneIds = (node: TerminalV2LayoutNode | null | undefined): string[] => {
      if (!node) return [];
      return node.kind === "leaf" ? [node.paneId] : node.children.flatMap(collectPaneIds);
    };

    const layoutAfter = result.current.workspaces[0].paneLayout?.terminalV2Layout;
    expect(collectPaneIds(layoutAfter?.root)).toContain(paneId);
  });

  it("regrows the grid so the new pane has somewhere to live", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(template, "/tmp/project", ["claude"], "Project");
    });
    const workspaceId = result.current.workspaces[0].id;
    const before = result.current.workspaces[0].cells.length;

    act(() => {
      result.current.addChatPane(workspaceId, "session-7");
    });

    const workspace = result.current.workspaces[0];
    expect(workspace.cells).toHaveLength(before + 1);
    expect(workspace.rows * workspace.cols).toBeGreaterThanOrEqual(workspace.cells.length);
  });
});

describe("focus memory across folders", () => {
  /**
   * Seed the split tree the way the running app has it: the layout bridge builds it in the
   * browser, and jsdom has no bridge.
   */
  function seedLayout(result: { current: ReturnType<typeof useCodeSpaceWorkspaceManager> }, index: number) {
    const workspace = result.current.workspaces[index];
    const paneIds = workspace.cells.map((cell) => cell.id);
    act(() => {
      result.current.updateWorkspacePaneLayout(workspace.id, {
        mode: "grid",
        terminalV2Layout: createTerminalV2LayoutFromPaneIds(paneIds, paneIds[0]),
      });
    });
  }

  it("returns you to the pane you were on, not to the first one", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/one", ["", ""], "One");
    });
    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/two", ["", ""], "Two");
    });
    seedLayout(result, 0);
    seedLayout(result, 1);

    const [first, second] = result.current.workspaces;
    const secondPaneOfTwo = second.cells[1].id;

    act(() => {
      result.current.setFocusedCellId(secondPaneOfTwo);
    });
    act(() => {
      result.current.handleSelectWorkspace(first.id);
    });
    expect(result.current.focusedCellId).toBe(first.cells[0].id);

    act(() => {
      result.current.handleSelectWorkspace(second.id);
    });
    expect(result.current.focusedCellId).toBe(secondPaneOfTwo);
  });

  it("records the pane on the workspace that owns it, whatever is active", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/one", ["", ""], "One");
    });
    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/two", ["", ""], "Two");
    });
    seedLayout(result, 0);
    seedLayout(result, 1);

    const [first, second] = result.current.workspaces;
    const secondPaneOfOne = first.cells[1].id;

    // What the rail does when you pick a pane in another folder: both land in one batch, and the
    // focus write used to be keyed on the workspace that was active BEFORE the pair.
    act(() => {
      result.current.handleSelectWorkspace(first.id);
      result.current.setFocusedCellId(secondPaneOfOne);
    });

    expect(result.current.workspaces[0].paneLayout?.terminalV2Layout?.activePaneId).toBe(secondPaneOfOne);

    act(() => {
      result.current.handleSelectWorkspace(second.id);
    });
    act(() => {
      result.current.handleSelectWorkspace(first.id);
    });
    expect(result.current.focusedCellId).toBe(secondPaneOfOne);
  });
});

describe("zoom belongs to the folder it was taken in", () => {
  function twoFolders() {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());
    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/one", ["", ""], "One");
    });
    act(() => {
      result.current.createWorkspace(twoPaneTemplate, "/tmp/two", ["", ""], "Two");
    });
    return result;
  }

  it("does not follow you into the next folder", () => {
    const result = twoFolders();
    const [first, second] = result.current.workspaces;

    act(() => {
      result.current.setWorkspaceZoom(second.id, second.cells[0].id);
    });

    expect(result.current.workspaces[1].paneLayout?.mode).toBe("focus");
    expect(result.current.workspaces[1].paneLayout?.focusCellId).toBe(second.cells[0].id);
    // The folder nobody maximised in keeps its grid — this is the bug that was reported.
    expect(result.current.workspaces[0].paneLayout?.mode ?? "grid").toBe("grid");

    act(() => {
      result.current.handleSelectWorkspace(first.id);
    });
    expect(result.current.workspaces[0].paneLayout?.mode ?? "grid").toBe("grid");
    // And the folder that was zoomed is still zoomed when you go back to it.
    expect(result.current.workspaces[1].paneLayout?.mode).toBe("focus");
  });

  it("gives the grid back, and keeps the split tree while doing it", () => {
    const result = twoFolders();
    const target = result.current.workspaces[1];
    const paneIds = target.cells.map((cell) => cell.id);
    act(() => {
      result.current.updateWorkspacePaneLayout(target.id, {
        mode: "grid",
        terminalV2Layout: createTerminalV2LayoutFromPaneIds(paneIds, paneIds[0]),
      });
    });

    act(() => {
      result.current.setWorkspaceZoom(target.id, paneIds[1]);
    });
    act(() => {
      result.current.setWorkspaceZoom(target.id, null);
    });

    const layout = result.current.workspaces[1].paneLayout;
    expect(layout?.mode).toBe("grid");
    expect(layout?.focusCellId).toBeNull();
    // Leaving the zoom must not cost the seams someone dragged.
    expect(layout?.terminalV2Layout?.root).toBeTruthy();
  });

  it("refuses a pane that is not in that folder", () => {
    const result = twoFolders();
    const [first, second] = result.current.workspaces;

    act(() => {
      result.current.setWorkspaceZoom(second.id, first.cells[0].id);
    });

    expect(result.current.workspaces[1].paneLayout?.mode ?? "grid").toBe("grid");
  });
});
