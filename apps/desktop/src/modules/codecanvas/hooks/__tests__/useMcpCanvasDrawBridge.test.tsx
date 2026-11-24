import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpCanvasDrawBridge, type CanvasDrawBridgeDeps } from "../useMcpCanvasDrawBridge";
import { setCanvasBehaviorSetting } from "../useCanvasBehaviorSettings";

type EventCallback = (event: { payload: unknown }) => void | Promise<void>;

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, EventCallback[]>();
  return {
    listeners,
    isTauri: vi.fn(() => true),
    loadTauriCore: vi.fn(() => Promise.resolve({})),
    bridgeResolveMcpRequest: vi.fn((_arg: { requestId: string; ok: boolean; data?: any; error?: string }) => Promise.resolve(true)),
    listen: vi.fn((event: string, callback: EventCallback) => {
      const list = listeners.get(event) ?? [];
      list.push(callback);
      listeners.set(event, list);
      return Promise.resolve(vi.fn(() => {
        listeners.set(event, (listeners.get(event) ?? []).filter((c) => c !== callback));
      }));
    }),
  };
});

vi.mock("@/lib/tauri/runtime", () => ({ isTauri: mocks.isTauri, loadTauriCore: mocks.loadTauriCore }));
vi.mock("@/lib/tauri-api", () => ({ bridgeResolveMcpRequest: mocks.bridgeResolveMcpRequest }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
function emit(payload: unknown) {
  return Promise.all([...(mocks.listeners.get("mcp://canvas-draw") ?? [])].map((l) => l({ payload })));
}
const emptyScene = { shapes: [], connectors: [], frames: [], clusters: [], counts: { shapes: 0, connectors: 0, otherNodes: 0, frames: 0 } };
function deps(overrides: Partial<CanvasDrawBridgeDeps> = {}): CanvasDrawBridgeDeps {
  return {
    resolveAnchor: () => ({ x: 0, y: 0 }),
    existingShapeIds: () => new Set<string>(),
    measure: (t) => t.length * 8,
    commit: vi.fn(),
    readScene: () => emptyScene,
    board: () => ({ nodes: [], edges: [] }),
    ...overrides,
  };
}
function emitRead(payload: unknown) {
  return Promise.all([...(mocks.listeners.get("mcp://canvas-read-shapes") ?? [])].map((l) => l({ payload })));
}

const DIAGRAM = {
  requestId: "d1",
  mode: "diagram" as const,
  graph: { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] },
  frame: { title: "Flow" },
};

describe("useMcpCanvasDrawBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.isTauri.mockReturnValue(true);
    setCanvasBehaviorSetting("allowAgentCanvasDraw", false);
  });

  it("denies the request and never commits when the draw gate is off", async () => {
    const commit = vi.fn();
    renderHook(() => useMcpCanvasDrawBridge(deps({ commit })));
    await flush();
    await emit(DIAGRAM);

    expect(commit).not.toHaveBeenCalled();
    expect(mocks.bridgeResolveMcpRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "d1", ok: false, error: expect.stringMatching(/disabled/i) }),
    );
  });

  it("commits the built application and acks with the receipt when enabled", async () => {
    setCanvasBehaviorSetting("allowAgentCanvasDraw", true);
    const commit = vi.fn();
    renderHook(() => useMcpCanvasDrawBridge(deps({ commit })));
    await flush();
    await emit(DIAGRAM);

    expect(commit).toHaveBeenCalledTimes(1);
    const application = commit.mock.calls[0][0];
    expect(application.nodes.length).toBe(3); // frame + 2 shapes
    expect(application.edges.length).toBe(1);

    const ack = mocks.bridgeResolveMcpRequest.mock.calls.at(-1)![0]!;
    expect(ack.requestId).toBe("d1");
    expect(ack.ok).toBe(true);
    expect(ack.data.mode).toBe("diagram");
    expect(ack.data.connectors).toBe(1);
  });

  it("acks ok:false and does not commit when the request is invalid", async () => {
    setCanvasBehaviorSetting("allowAgentCanvasDraw", true);
    const commit = vi.fn();
    renderHook(() => useMcpCanvasDrawBridge(deps({ commit })));
    await flush();
    await emit({ requestId: "bad", mode: "diagram", graph: { nodes: [], edges: [] } });

    expect(commit).not.toHaveBeenCalled();
    expect(mocks.bridgeResolveMcpRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "bad", ok: false, error: expect.any(String) }),
    );
  });

  it("passes the resolved anchor and existing ids into the runtime for ops mode", async () => {
    setCanvasBehaviorSetting("allowAgentCanvasDraw", true);
    const commit = vi.fn();
    renderHook(() => useMcpCanvasDrawBridge(deps({
      commit,
      resolveAnchor: () => ({ x: 500, y: 700 }),
      existingShapeIds: () => new Set(["existing-1"]),
    })));
    await flush();
    await emit({
      requestId: "o1",
      mode: "ops",
      ops: [
        { op: "create_shape", shape: "rectangle", text: "new", at: [10, 20] },
        { op: "update_shape", id: "existing-1", patch: { text: "renamed" } },
      ],
    });

    const application = commit.mock.calls[0][0];
    expect(application.nodes[0].position).toEqual({ x: 510, y: 720 });
    expect(application.patches).toEqual([{ id: "existing-1", patch: { text: "renamed" } }]);
  });

  it("applies a duplicate requestId only once", async () => {
    setCanvasBehaviorSetting("allowAgentCanvasDraw", true);
    const commit = vi.fn();
    renderHook(() => useMcpCanvasDrawBridge(deps({ commit })));
    await flush();
    await emit(DIAGRAM);
    await emit(DIAGRAM);

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("answers a read-shapes request with the current scene when enabled", async () => {
    setCanvasBehaviorSetting("allowAgentCanvasDraw", true);
    const scene = { shapes: [{ id: "a", shape: "rectangle", bounds: { x: 0, y: 0, w: 10, h: 10 } }], connectors: [], frames: [], clusters: [], counts: { shapes: 1, connectors: 0, otherNodes: 0, frames: 0 } };
    renderHook(() => useMcpCanvasDrawBridge(deps({ readScene: () => scene })));
    await flush();
    await emitRead({ requestId: "r1" });

    const ack = mocks.bridgeResolveMcpRequest.mock.calls.at(-1)![0]!;
    expect(ack).toMatchObject({ requestId: "r1", ok: true });
    expect(ack.data).toEqual(scene);
  });

  it("denies a read-shapes request when the gate is off", async () => {
    renderHook(() => useMcpCanvasDrawBridge(deps()));
    await flush();
    await emitRead({ requestId: "r2" });
    expect(mocks.bridgeResolveMcpRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "r2", ok: false, error: expect.stringMatching(/disabled/i) }),
    );
  });

  it("is a no-op outside Tauri", async () => {
    mocks.isTauri.mockReturnValue(false);
    renderHook(() => useMcpCanvasDrawBridge(deps()));
    await flush();
    expect(mocks.listen).not.toHaveBeenCalled();
  });
});
