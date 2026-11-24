import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import {
  CANVAS_DELEGATE_REMOTE_BOARD,
  CANVAS_DELEGATE_REMOTE_WORKSPACE,
  CANVAS_DELEGATE_SHELL_COMMAND,
  CANVAS_DELEGATE_UNKNOWN_WORKSPACE,
  canvasLaunchArgv,
  canvasTaskTitle,
  planCanvasTaskPane,
  useCanvasTaskSpawner,
} from "../useCanvasTaskSpawner";
import { withDeniedTools } from "@/modules/tasks/services/delegation-preset";
import { GITHUB_ISSUE_WRITE_DENY_RULES } from "@/modules/tasks/services/github-delegation";
import { NOTION_WRITE_DENY_RULES } from "@/modules/tasks/services/notion-delegation";

const workspaces = [
  { id: "w1", cwd: "/repo", remote: false },
  { id: "w2", cwd: "/srv/api", remote: true },
  { id: "w3", cwd: "/clients/flow-trader", remote: false },
];

describe("planCanvasTaskPane", () => {
  const base = { workspaceId: "w1", agentCommand: "claude --session-id s1", workspaces, boardIsRemote: false };

  it("runs the preset's command as argv, in the task's workspace folder", () => {
    expect(planCanvasTaskPane(base)).toEqual({ ok: true, cwd: "/repo", folder: "/repo", launchCommand: ["claude", "--session-id", "s1"] });
    expect(planCanvasTaskPane({ ...base, cwdOverride: "/repo/sub" })).toMatchObject({ cwd: "/repo/sub" });
  });

  it("says why when it cannot, instead of opening a terminal that would not do the work", () => {
    expect(planCanvasTaskPane({ ...base, boardIsRemote: true })).toEqual({ ok: false, error: CANVAS_DELEGATE_REMOTE_BOARD });
    expect(planCanvasTaskPane({ ...base, workspaceId: "w2" })).toEqual({ ok: false, error: CANVAS_DELEGATE_REMOTE_WORKSPACE });
    expect(planCanvasTaskPane({ ...base, workspaceId: "gone" })).toEqual({ ok: false, error: CANVAS_DELEGATE_UNKNOWN_WORKSPACE });
    expect(planCanvasTaskPane({ ...base, agentCommand: `claude --append-system-prompt "be brief"` })).toEqual({ ok: false, error: CANVAS_DELEGATE_SHELL_COMMAND });
  });
});

describe("canvasLaunchArgv", () => {
  it("keeps a denied-tools rule whole, quotes stripped and its * intact (Notion and GitHub delegations)", () => {
    const command = withDeniedTools("claude --session-id s1", [...GITHUB_ISSUE_WRITE_DENY_RULES, ...NOTION_WRITE_DENY_RULES]);
    const argv = canvasLaunchArgv(command);
    expect(argv?.slice(0, 4)).toEqual(["claude", "--session-id", "s1", "--disallowedTools"]);
    expect(argv?.slice(4)).toEqual([...GITHUB_ISSUE_WRITE_DENY_RULES, ...NOTION_WRITE_DENY_RULES]);
    expect(argv).toContain("Bash(gh issue close:*)");
  });

  it("refuses what only a shell could run", () => {
    for (const command of [`claude "a b"`, "claude && rm x", "claude *", "claude 'open", "FOO=$BAR claude", "a\\ b"]) {
      expect(canvasLaunchArgv(command)).toBeNull();
    }
    expect(canvasLaunchArgv("   ")).toBeNull();
  });
});

describe("canvasTaskTitle", () => {
  it("names the cell by key and title", () => {
    expect(canvasTaskTitle({ id: "t1", key: "LOT-2", title: "Fix login" })).toBe("LOT-2 Fix login");
    expect(canvasTaskTitle({ id: "t1" })).toBe("t1");
    // A GitHub issue's task is already titled by its key.
    expect(canvasTaskTitle({ id: "t2", key: "#18", title: "#18 — Rilis 2" })).toBe("#18 — Rilis 2");
  });
});

describe("useCanvasTaskSpawner", () => {
  function setup(nodes: Node[] = []) {
    let n = 0;
    const deps = {
      nodes,
      workspaces: () => workspaces,
      boardIsRemote: () => false,
      addLaunchedTerminalNode: vi.fn(() => {
        n += 1;
        return { id: `node-${n}`, runtimePaneId: `canvas:p:node-${n}` };
      }),
      createFrame: vi.fn(() => "frame-1"),
      revealNode: vi.fn(),
      rootDir: "/repo",
      boardReady: true,
      openProject: vi.fn(async () => undefined),
    };
    const hook = renderHook((props: typeof deps) => useCanvasTaskSpawner(props), { initialProps: deps });
    return { spawner: hook.result.current!, deps, rerender: hook.rerender };
  }
  const task = { id: "t1", key: "LOT-2", title: "Fix login" };

  it("is absent without a tracker board to read workspaces from", () => {
    const { result } = renderHook(() =>
      useCanvasTaskSpawner({ nodes: [], workspaces: null, boardIsRemote: () => false, addLaunchedTerminalNode: vi.fn(), createFrame: vi.fn(), revealNode: vi.fn(), rootDir: "/repo", boardReady: true, openProject: vi.fn() }),
    );
    expect(result.current).toBeNull();
  });

  it("opens a loose terminal for a task's first cell and returns the registry's pane id", () => {
    const { spawner, deps } = setup();
    expect(spawner.addPane("w1", "claude", undefined, task)).toBe("canvas:p:node-1");
    expect(deps.addLaunchedTerminalNode).toHaveBeenCalledWith({ cwd: "/repo", launchCommand: ["claude"], label: "LOT-2 Fix login", spawnTaskKey: "t1" });
    expect(deps.createFrame).not.toHaveBeenCalled();
    expect(deps.revealNode).toHaveBeenCalledWith("node-1");
  });

  it("makes the task's Frame when a second cell arrives, and joins it after", () => {
    const loose = { id: "old", type: "terminal", position: { x: 0, y: 0 }, data: { spawnTaskKey: "t1" } } as Node;
    const second = setup([loose]);
    second.spawner.addPane("w1", "claude", undefined, task);
    expect(second.deps.createFrame).toHaveBeenCalledWith(["old", "node-1"], { title: "LOT-2 Fix login", taskKey: "t1", relocate: true });

    const frame = { id: "f1", type: "frame", position: { x: 0, y: 0 }, data: { taskKey: "t1" } } as Node;
    const third = setup([frame]);
    third.spawner.addPane("w1", "claude", undefined, task);
    expect(third.deps.addLaunchedTerminalNode).toHaveBeenCalledWith(expect.objectContaining({ frameId: "f1" }));
  });

  it("throws the refusal, which delegation reports as its error", () => {
    const { spawner, deps } = setup();
    expect(() => spawner.addPane("w2", "claude", undefined, task)).toThrow(CANVAS_DELEGATE_REMOTE_WORKSPACE);
    expect(deps.addLaunchedTerminalNode).not.toHaveBeenCalled();
  });

  it("lists the workspaces it can open into", () => {
    const { spawner } = setup();
    expect(spawner.workspace?.("w1")).toEqual({ cwd: "/repo", remote: false });
    expect(spawner.workspaces?.()).toHaveLength(3);
    expect(spawner.launchesAgentDirectly).toBe(true);
  });

  it("opens on the board on screen when the task's folder is that board's", async () => {
    const { spawner, deps } = setup();
    await expect(spawner.openPane!("w1", "claude", undefined, task)).resolves.toBe("canvas:p:node-1");
    expect(deps.openProject).not.toHaveBeenCalled();
  });

  it("brings the task folder's canvas on screen first, then opens the cell there", async () => {
    const { spawner, deps, rerender } = setup();
    let opened: Promise<string | null> | null = null;
    await act(async () => {
      opened = spawner.openPane!("w3", "claude", undefined, task);
      await Promise.resolve();
    });
    expect(deps.openProject).toHaveBeenCalledWith("/clients/flow-trader");
    expect(deps.addLaunchedTerminalNode).not.toHaveBeenCalled();
    // The switch lands as a render with the new board's folder.
    rerender({ ...deps, rootDir: "/clients/flow-trader/" });
    await act(async () => {
      await expect(opened).resolves.toBe("canvas:p:node-1");
    });
    expect(deps.addLaunchedTerminalNode).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/clients/flow-trader" }));
  });
});
