import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryCodeCanvasProjectRepository, type CodeCanvasProjectRepository } from "../../services/codecanvas-project-repository";
import type { CodeCanvasProjectSnapshot } from "@/lib/tauri/codecanvas";
import { canvasProjectViewStateStore } from "../../services/canvas-project-view-state";

const closeWorkspaceTerminalSessions = vi.hoisted(() => vi.fn());
const destroyPersistentPty = vi.hoisted(() => vi.fn());
const destroyPersistentPtyConfirmed = vi.hoisted(() => vi.fn<() => Promise<void>>());
const destroyScopePersistentPtys = vi.hoisted(() => vi.fn());
vi.mock("@/modules/codespace/services/terminal-session-registry", () => ({
  closeWorkspaceTerminalSessions,
  closeTerminalSession: vi.fn(),
}));
vi.mock("@/lib/pty-session-pool", () => ({
  destroyPersistentPty,
  destroyPersistentPtyConfirmed,
  getPersistentPtySnapshot: () => null,
  destroyScopePersistentPtys,
}));

import { useCanvasBoard } from "../useCanvasBoard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("useCanvasBoard multi-project orchestration", () => {
  beforeEach(() => {
    closeWorkspaceTerminalSessions.mockReset();
    destroyPersistentPty.mockReset();
    destroyPersistentPtyConfirmed.mockReset().mockResolvedValue(undefined);
    destroyScopePersistentPtys.mockReset();
  });

  it("settles an explicit agent close before saving and switching the outgoing board", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.openProject("/close-a"); });
    const firstId = result.current.activeProjectId!;
    await act(async () => { await result.current.openProject("/close-b"); });
    const secondId = result.current.activeProjectId!;
    await act(async () => { await result.current.selectProject(firstId); });
    let agentId!: string;
    act(() => { agentId = result.current.addAgentNode({ id: "def", name: "Close", model: "", prompt: "", appliedSkills: [], updatedAt: 0 })!; });
    const kill = deferred<void>();
    destroyPersistentPtyConfirmed.mockReturnValueOnce(kill.promise);
    let closing!: Promise<unknown>;
    let switching!: Promise<unknown>;
    act(() => { closing = result.current.removeNode(agentId); switching = result.current.selectProject(secondId); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.activeProjectId).toBe(firstId);
    await act(async () => { kill.resolve(); await Promise.all([closing, switching]); });
    const saved = await repository.loadProject(firstId);
    expect(saved?.nodes.map((node) => node.id)).not.toContain(agentId);
    expect(result.current.activeProjectId).toBe(secondId);
  });

  it("opens a Canvas Project and exposes it as active", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.openProject("/repo/app"); });

    expect(result.current.activeProject?.rootDir).toBe("/repo/app");
    expect(result.current.projects).toHaveLength(1);
    expect(result.current.rootDir).toBe("/repo/app");
    expect(result.current.showPicker).toBe(false);
  });

  /**
   * The switch has to be atomic, and this is the test that says so.
   *
   * `setActiveProjectId` used to run BEFORE the `await` that loads the board, publishing
   * a render that carried the incoming project's id next to the outgoing project's
   * `rootDir` and nodes. Anything reading both at once — the fleet push does — concluded
   * that the old project's agents belonged to the new project. That is how an agent
   * running in `terax-ai` reached Lotus Pocket labelled `codespace-demo`, in a row that
   * would have dispatched into the wrong repo (2026-08-10).
   *
   * The load is held open deliberately. A repository that answers instantly closes the
   * window this bug lives in, and a test that cannot observe the window cannot fail:
   * scanning renders against a fast in-memory repository passes with the defect present.
   * Loading a real project reads disk over Tauri IPC, so the slow case is the true one.
   */
  it("holds a project id back until its own board is loaded", async () => {
    const base = createInMemoryCodeCanvasProjectRepository();
    const gate = deferred<void>();
    const repository: CodeCanvasProjectRepository = {
      ...base,
      loadProject: async (projectId) => {
        await gate.promise;
        return base.loadProject(projectId);
      },
    };
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let terax: CodeCanvasProjectSnapshot | null = null;
    await act(async () => { terax = await result.current.openProject("/repo/terax-ai"); });
    await act(async () => { await result.current.openProject("/repo/codespace-demo"); });

    let switching!: Promise<void>;
    await act(async () => {
      switching = result.current.selectProject(terax!.id);
      await Promise.resolve();
    });

    // Mid-switch: the board is still terax-ai's, so the id on offer must still be
    // terax-ai's. Announcing the incoming id here is the whole defect.
    expect(result.current.activeProjectId).not.toBe(terax!.id);
    expect(result.current.rootDir).toBe("/repo/codespace-demo");

    gate.resolve();
    await act(async () => { await switching; });

    expect(result.current.activeProjectId).toBe(terax!.id);
    expect(result.current.rootDir).toBe("/repo/terax-ai");
  });

  it("keeps the latest project request when slow loads finish out of order", async () => {
    const base = createInMemoryCodeCanvasProjectRepository();
    const first = await base.openProject("/repo/first");
    const second = await base.openProject("/repo/second");
    const third = await base.openProject("/repo/third");
    await base.setActiveProject(first.id);
    const secondGate = deferred<void>();
    const thirdGate = deferred<void>();
    const repository: CodeCanvasProjectRepository = {
      ...base,
      setActiveProject: async (projectId) => {
        if (projectId === second.id) await secondGate.promise;
        return base.setActiveProject(projectId);
      },
      loadProject: async (projectId) => {
        if (projectId === third.id) await thirdGate.promise;
        return base.loadProject(projectId);
      },
    };
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let toSecond!: Promise<void>;
    let toThird!: Promise<void>;
    act(() => {
      toSecond = result.current.selectProject(second.id);
      toThird = result.current.selectProject(third.id);
    });

    thirdGate.resolve();
    await act(async () => { await toThird; });
    expect(result.current.activeProjectId).toBe(third.id);

    secondGate.resolve();
    await act(async () => { await toSecond; });
    expect(result.current.activeProjectId).toBe(third.id);
    expect((await repository.getIndex()).activeProjectId).toBe(third.id);
  });

  it("keeps the latest open-project request when folder opens finish out of order", async () => {
    const base = createInMemoryCodeCanvasProjectRepository();
    const first = await base.openProject("/repo/first");
    const secondGate = deferred<void>();
    const thirdGate = deferred<void>();
    const repository: CodeCanvasProjectRepository = {
      ...base,
      openProject: async (rootDir) => {
        if (rootDir === "/repo/second") await secondGate.promise;
        if (rootDir === "/repo/third") await thirdGate.promise;
        return base.openProject(rootDir);
      },
    };
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.activeProjectId).toBe(first.id));

    let toSecond!: Promise<CodeCanvasProjectSnapshot | null>;
    let toThird!: Promise<CodeCanvasProjectSnapshot | null>;
    act(() => {
      toSecond = result.current.openProject("/repo/second");
      toThird = result.current.openProject("/repo/third");
    });

    thirdGate.resolve();
    const third = await act(async () => toThird);
    expect(result.current.activeProjectId).toBe(third?.id);

    secondGate.resolve();
    const second = await act(async () => toSecond);
    expect(second).toBeNull();
    expect(result.current.activeProjectId).toBe(third?.id);
    expect((await repository.getIndex()).activeProjectId).toBe(third?.id);
  });

  it("rolls the durable project pointer back when opening a folder fails", async () => {
    const base = createInMemoryCodeCanvasProjectRepository();
    const first = await base.openProject("/repo/first");
    const repository: CodeCanvasProjectRepository = {
      ...base,
      openProject: async () => {
        await base.openProject("/repo/broken");
        throw new Error("cannot read project");
      },
    };
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.activeProjectId).toBe(first.id));

    await expect(act(async () => result.current.openProject("/repo/broken"))).rejects.toThrow("cannot read project");

    expect(result.current.activeProjectId).toBe(first.id);
    expect((await repository.getIndex()).activeProjectId).toBe(first.id);
  });

  it("tears down outgoing browser overlays only after the incoming project loads", async () => {
    const base = createInMemoryCodeCanvasProjectRepository();
    const first = await base.openProject("/repo/first");
    const second = await base.openProject("/repo/second");
    await base.setActiveProject(first.id);
    const order: string[] = [];
    const repository: CodeCanvasProjectRepository = {
      ...base,
      loadProject: async (projectId) => {
        order.push("load");
        return base.loadProject(projectId);
      },
    };
    const teardownBrowsers = vi.fn(async () => { order.push("teardown"); });
    const { result } = renderHook(() => useCanvasBoard({ repository, teardownBrowsers }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    order.length = 0;

    await act(async () => { await result.current.selectProject(second.id); });

    expect(order).toEqual(["load", "teardown"]);
  });

  it("marks a project open as loading while native restore is pending", async () => {
    const snapshot: CodeCanvasProjectSnapshot = {
      id: "cp_pending",
      rootDir: "/repo/pending",
      alias: null,
      position: 0,
      updatedAt: 1,
      lastOpenedAt: 1,
      nodes: [],
      edges: [],
      terminalCounter: 0,
    };
    const open = deferred<CodeCanvasProjectSnapshot>();
    let opened = false;
    const meta = {
      id: snapshot.id,
      rootDir: snapshot.rootDir,
      alias: snapshot.alias,
      position: snapshot.position,
      updatedAt: snapshot.updatedAt,
      lastOpenedAt: snapshot.lastOpenedAt,
    };
    const repository: CodeCanvasProjectRepository = {
      getIndex: vi.fn(async () => opened
        ? { projects: [meta], activeProjectId: snapshot.id }
        : { projects: [], activeProjectId: null }),
      openProject: vi.fn(async () => {
        const value = await open.promise;
        opened = true;
        return value;
      }),
      loadProject: vi.fn(async () => null),
      saveProject: vi.fn(async () => {}),
      renameProject: vi.fn(async () => {}),
      closeProject: vi.fn(async () => ({ projects: [], activeProjectId: null })),
      setActiveProject: vi.fn(async () => {}),
    };
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pending!: Promise<CodeCanvasProjectSnapshot | null>;
    act(() => { pending = result.current.openProject("/repo/pending"); });

    expect(result.current.loading).toBe(true);

    open.resolve(snapshot);
    await act(async () => { await pending; });

    expect(result.current.loading).toBe(false);
    expect(result.current.activeProjectId).toBe(snapshot.id);
  });

  it("hydrates selected project terminals with that project's runtime scope", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    const first = await repository.openProject("/repo/one");
    await repository.saveProject({
      ...first,
      nodes: [{
        type: "terminal",
        id: "term-1",
        position: { x: 0, y: 0 },
        size: { w: 720, h: 420 },
        cwd: "/repo/one",
        terminalNumber: 1,
        assignedWorktree: null,
      }],
      edges: [],
      terminalCounter: 1,
    });
    await repository.openProject("/repo/two");
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.selectProject(first.id); });

    expect(result.current.activeProjectId).toBe(first.id);
    // A lone loose terminal is wrapped in "Frame 1" on open (LOT2-135, decision 37).
    expect(result.current.nodes.find((n) => n.id === "term-1")?.data.runtimePaneId).toBe(`canvas:${first.id}:term-1`);
    expect(closeWorkspaceTerminalSessions).not.toHaveBeenCalled();
    expect(destroyScopePersistentPtys).not.toHaveBeenCalled();
  });

  it("reopens the active sidebar project after the picker is shown", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.openProject("/repo/app"); });
    const projectId = result.current.activeProjectId!;

    act(() => { result.current.setShowPicker(true); });
    await act(async () => { await result.current.selectProject(projectId); });

    expect(result.current.showPicker).toBe(false);
    expect(result.current.activeProjectId).toBe(projectId);
    expect(result.current.rootDir).toBe("/repo/app");
  });

  it("does not let a slow active-project close override a newer project selection", async () => {
    const base = createInMemoryCodeCanvasProjectRepository();
    const first = await base.openProject("/repo/first");
    await base.openProject("/repo/second");
    const third = await base.openProject("/repo/third");
    await base.setActiveProject(first.id);
    const closeGate = deferred<void>();
    const repository: CodeCanvasProjectRepository = {
      ...base,
      closeProject: async (projectId) => {
        const index = await base.closeProject(projectId);
        await closeGate.promise;
        return index;
      },
    };
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.activeProjectId).toBe(first.id));

    let closing!: Promise<void>;
    act(() => { closing = result.current.closeProject(first.id); });
    await act(async () => { await result.current.selectProject(third.id); });
    expect(result.current.activeProjectId).toBe(third.id);

    closeGate.resolve();
    await act(async () => { await closing; });

    expect(result.current.activeProjectId).toBe(third.id);
    expect((await repository.getIndex()).activeProjectId).toBe(third.id);
  });

  it("does not settle the active focus when closing a different project", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    const background = await repository.openProject("/repo/background");
    await repository.openProject("/repo/active");
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const beforeSwap = vi.fn(() => null);
    act(() => result.current.setBeforeBoardSwap(beforeSwap));
    canvasProjectViewStateStore.rememberFocus(background.id, "agent-background");

    await act(async () => { await result.current.closeProject(background.id); });

    expect(beforeSwap).not.toHaveBeenCalled();
    expect(result.current.rootDir).toBe("/repo/active");
    expect(canvasProjectViewStateStore.read(background.id).mode).toBe("board");
  });

  it("closes only the closed Canvas Project runtime scope", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.openProject("/repo/app"); });
    const projectId = result.current.activeProjectId!;

    await act(async () => { await result.current.closeProject(projectId); });

    expect(closeWorkspaceTerminalSessions).toHaveBeenCalledWith(`canvas:${projectId}`);
    expect(destroyScopePersistentPtys).toHaveBeenCalledWith(`canvas:${projectId}`);
    expect(result.current.activeProjectId).toBeNull();
  });

  it("exposes autosave failure status for the active Canvas Project", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    repository.saveProject = vi.fn(async () => { throw new Error("disk full"); });
    const { result, unmount } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.openProject("/repo/app"); });
    vi.useFakeTimers();

    act(() => { result.current.addNoteNode(); });
    expect(result.current.autosave.status).toBe("dirty");
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.autosave.status).toBe("failed");
    expect(result.current.autosave.error).toBe("disk full");
    unmount();
    vi.useRealTimers();
  });

  it("repairs invalid persisted nodes before hydrating the board", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    const snapshot = await repository.openProject("/repo/app");
    await repository.saveProject({
      ...snapshot,
      nodes: [
        { type: "note", id: "n1", position: { x: 1, y: 2 }, size: { w: 300, h: 200 }, content: "ok" },
        { type: "mystery", id: "bad", position: { x: 0, y: 0 }, size: { w: 1, h: 1 } },
      ] as never,
      edges: [{ id: "e-bad", source: "bad", target: "n1" }] as never,
    });

    const { result } = renderHook(() => useCanvasBoard({ repository }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    // The repaired board's one loose window is wrapped in "Frame 1" on open (decision 37).
    expect(result.current.nodes.map((node) => node.id)).toEqual(["frame-auto-n1", "n1"]);
    expect(result.current.edges).toEqual([]);
  });
});

describe("useCanvasBoard canonical persistence while Fleet is active", () => {
  it("runs every save through the registered canonical-node projection", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.openProject("/repo/first"); });
    act(() => { result.current.addTerminalNode({ x: 0, y: 0 }); });
    // The first window on an empty canvas creates "Frame 1" around itself (decision 37).
    await waitFor(() => expect(result.current.nodes).toHaveLength(2));

    const board = result.current as typeof result.current & {
      setPrepareNodesForSave(handler: ((nodes: typeof result.current.nodes) => typeof result.current.nodes) | null): void;
    };
    act(() => board.setPrepareNodesForSave((nodes) => nodes.map((node) => ({
      ...node,
      position: { x: 10, y: 20 },
      width: 420,
      height: 320,
      style: { ...node.style, width: 420, height: 320 },
    }))));

    await act(async () => { await result.current.saveActiveProject(); });

    const saved = await repository.loadProject(result.current.activeProjectId!);
    expect(saved?.nodes.find((n) => n.type === "terminal")).toMatchObject({
      position: { x: 10, y: 20 },
      size: { w: 420, h: 320 },
    });
  });
});

describe("useCanvasBoard beforeBoardSwap (focus mode across a project switch)", () => {
  /**
   * Fleet focus stretches the hero and veils the rest, then autosaves that geometry. A switch away
   * saved the board exactly so; coming back drew the hero at fleet size beside an unveiled neighbour
   * under a stale rail (2026-08-28). The layer that owns focus settles the board first and the save
   * must persist THAT, not `board.nodes` as they stood.
   */
  it("persists the settled nodes returned by the hook, not the live board", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let first: CodeCanvasProjectSnapshot | null = null;
    await act(async () => { first = await result.current.openProject("/repo/first"); });
    await act(async () => { result.current.addTerminalNode({ x: 10, y: 20 }); });
    await waitFor(() => expect(result.current.nodes).toHaveLength(2)); // Frame 1 + the terminal
    const terminal = () => result.current.nodes.find((n) => n.type === "terminal")!;
    const id = terminal().id;

    // Pretend focus mode stretched the node; the settle hook hands back the pre-focus box.
    const settled = vi.fn(() => [{ ...terminal(), position: { x: 10, y: 20 }, width: 400, height: 300, style: { width: 400, height: 300 } }]);
    act(() => result.current.setBeforeBoardSwap(settled));
    act(() => {
      result.current.restoreLayoutSnapshot(new Map([[id, { x: 0, y: 0, width: 1400, height: 900 }]]));
    });
    await waitFor(() => expect(terminal().width).toBe(1400));

    await act(async () => { await result.current.openProject("/repo/second"); });
    expect(settled).toHaveBeenCalledTimes(1);

    const saved = await repository.loadProject(first!.id);
    const node = saved!.nodes.find((n) => n.id === id) as { position: { x: number; y: number }; size: { w: number; h: number } };
    expect(node.position).toEqual({ x: 10, y: 20 });
    expect(node.size).toEqual({ w: 400, h: 300 });
  });

  it("saves the live board untouched when the hook has nothing to settle", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let first: CodeCanvasProjectSnapshot | null = null;
    await act(async () => { first = await result.current.openProject("/repo/first"); });
    await act(async () => { result.current.addTerminalNode({ x: 10, y: 20 }); });
    await waitFor(() => expect(result.current.nodes).toHaveLength(2)); // Frame 1 + the terminal
    act(() => result.current.setBeforeBoardSwap(() => null));
    await act(async () => { await result.current.openProject("/repo/second"); });
    const saved = await repository.loadProject(first!.id);
    expect(saved!.nodes).toHaveLength(2);
  });
});
