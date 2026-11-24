import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { CANVAS_BRAINSTORM_REMOTE } from "../../services/canvas-factory-brainstorm";
import { useCanvasFactoryBrainstorm } from "../useCanvasFactoryBrainstorm";

const run = { repo: "o/r", issue: 7, title: "Fix login" };

function setup(overrides: Partial<Parameters<typeof useCanvasFactoryBrainstorm>[0]> = {}) {
  const deps = {
    nodes: [] as Node[],
    rootDir: "/repo",
    boardReady: true,
    openProject: vi.fn(async () => undefined),
    projectFolders: () => [] as string[],
    boardIsRemote: () => false,
    addFactoryNode: vi.fn(() => "factory-1"),
    addLaunchedTerminalNode: vi.fn(() => ({ id: "term-1" })),
    createFrame: vi.fn(() => "frame-1"),
    revealNode: vi.fn(),
    onStarted: vi.fn(),
    ...overrides,
  };
  const hook = renderHook((props) => useCanvasFactoryBrainstorm(props), { initialProps: deps });
  return { deps, hook };
}

describe("useCanvasFactoryBrainstorm", () => {
  it("places the Factory node and the agent's terminal in one Frame, then steps the Dock aside", async () => {
    const { deps, hook } = setup();
    let why: string | null = "unset";
    await act(async () => {
      why = await hook.result.current("PROMPT", "/repo", run);
    });
    expect(why).toBeNull();
    expect(deps.openProject).not.toHaveBeenCalled();
    expect(deps.addFactoryNode).toHaveBeenCalledWith(run);
    expect(deps.addLaunchedTerminalNode).toHaveBeenCalledWith({ cwd: "/repo", launchCommand: ["claude", "PROMPT"], label: "Brainstorm #7 Fix login" });
    expect(deps.createFrame).toHaveBeenCalledWith(["factory-1", "term-1"], { title: "#7 Fix login", taskKey: "factory:o/r#7", relocate: true });
    expect(deps.revealNode).toHaveBeenCalledWith("term-1");
    expect(deps.onStarted).toHaveBeenCalled();
  });

  it("joins the Frame the Factory node already sits in", async () => {
    const nodes = [
      { id: "f1", type: "frame", position: { x: 0, y: 0 }, data: { title: "Mine" } },
      { id: "n1", type: "factory", position: { x: 0, y: 0 }, data: { ...run, frameId: "f1" } },
    ] as Node[];
    const { deps, hook } = setup({ nodes });
    await act(async () => {
      await hook.result.current("PROMPT", "/repo", run);
    });
    expect(deps.addFactoryNode).not.toHaveBeenCalled();
    expect(deps.createFrame).not.toHaveBeenCalled();
    expect(deps.addLaunchedTerminalNode).toHaveBeenCalledWith(expect.objectContaining({ frameId: "f1" }));
  });

  it("brings the checkout's canvas on screen first, and places nothing until it has loaded", async () => {
    const { deps, hook } = setup({ rootDir: "/other" });
    let pending!: Promise<string | null>;
    act(() => {
      pending = hook.result.current("PROMPT", "/repo/", run);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(deps.openProject).toHaveBeenCalledWith("/repo/");
    expect(deps.addLaunchedTerminalNode).not.toHaveBeenCalled();
    hook.rerender({ ...deps, rootDir: "/repo" });
    await act(async () => {
      expect(await pending).toBeNull();
    });
    expect(deps.addLaunchedTerminalNode).toHaveBeenCalledTimes(1);
  });

  it("keeps a repo in a subfolder on its parent's canvas: no new canvas, the terminal still runs in the repo", async () => {
    const { deps, hook } = setup({ rootDir: "/other", projectFolders: () => ["/main"] });
    let pending!: Promise<string | null>;
    act(() => {
      pending = hook.result.current("PROMPT", "/main/front", run);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(deps.openProject).toHaveBeenCalledWith("/main");
    hook.rerender({ ...deps, rootDir: "/main" });
    await act(async () => {
      expect(await pending).toBeNull();
    });
    expect(deps.addLaunchedTerminalNode).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/main/front" }));
  });

  it("says why on a canvas that runs on another machine, and opens nothing", async () => {
    const { deps, hook } = setup({ boardIsRemote: () => true });
    let why: string | null = null;
    await act(async () => {
      why = await hook.result.current("PROMPT", "/repo", run);
    });
    expect(why).toBe(CANVAS_BRAINSTORM_REMOTE);
    expect(deps.addLaunchedTerminalNode).not.toHaveBeenCalled();
    expect(deps.onStarted).not.toHaveBeenCalled();
  });
});
