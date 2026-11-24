import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpSpawnBridge, type SpawnDelegate } from "../useMcpSpawnBridge";
import { CellBusProvider, useCellBus } from "@/modules/codespace/services/bridge/cell-bus-context";
import {
  clearTerminalSessionRegistryForTests,
  registerTerminalSession,
} from "@/modules/codespace/services/terminal-session-registry";

type EventCallback = (event: { payload: unknown }) => void | Promise<void>;

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, EventCallback[]>();
  const pendingListenResolvers: Array<(unlisten: () => void) => void> = [];
  let deferListen = false;

  return {
    listeners,
    pendingListenResolvers,
    setDeferListen(value: boolean) {
      deferListen = value;
    },
    isTauri: vi.fn(() => true),
    loadTauriCore: vi.fn(() => Promise.resolve({})),
    bridgeResolveMcpRequest: vi.fn(() => Promise.resolve(true)),
    listen: vi.fn((event: string, callback: EventCallback) => {
      const eventListeners = listeners.get(event) ?? [];
      eventListeners.push(callback);
      listeners.set(event, eventListeners);
      const unlisten = vi.fn(() => {
        listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== callback));
      });
      if (deferListen) {
        return new Promise<() => void>((resolve) => {
          pendingListenResolvers.push(() => resolve(unlisten));
        });
      }
      return Promise.resolve(unlisten);
    }),
  };
});

vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: mocks.isTauri,
  loadTauriCore: mocks.loadTauriCore,
}));

vi.mock("@/lib/tauri-api", () => ({
  bridgeResolveMcpRequest: mocks.bridgeResolveMcpRequest,
  getRunner: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

function wrapper(workspaceId = "ws-1") {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <CellBusProvider workspaceId={workspaceId}>{children}</CellBusProvider>;
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function emitSpawn(payload: unknown) {
  const listeners = [...(mocks.listeners.get("mcp://spawn-cell") ?? [])];
  return Promise.all(listeners.map((listener) => listener({ payload })));
}

function registerLiveSession(paneId: string, sessionId = `session-${paneId}`) {
  return registerTerminalSession(paneId, {
    workspaceId: "ws-1",
    cwd: "/tmp",
    status: "live",
    close: vi.fn(),
    getSessionId: () => sessionId,
  });
}

describe("useMcpSpawnBridge", () => {
  beforeEach(() => {
    clearTerminalSessionRegistryForTests();
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.pendingListenResolvers.length = 0;
    mocks.setDeferListen(false);
    mocks.isTauri.mockReturnValue(true);
  });

  it("keeps one Tauri listener across delegate rerenders", async () => {
    const firstDelegate = vi.fn<SpawnDelegate>(() => "pane-1");
    const secondDelegate = vi.fn<SpawnDelegate>(() => "pane-2");

    const { rerender } = renderHook(
      ({ delegate }) => {
        const bus = useCellBus();
        useMcpSpawnBridge(delegate);
        return bus;
      },
      {
        wrapper: wrapper(),
        initialProps: { delegate: firstDelegate },
      },
    );

    await flushMicrotasks();
    rerender({ delegate: secondDelegate });
    await flushMicrotasks();

    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(mocks.listeners.get("mcp://spawn-cell")).toHaveLength(1);
  });

  it("pins the model and effort the phone chose, after the posture", async () => {
    const delegate = vi.fn<SpawnDelegate>(() => "pane-tuned");

    const { result } = renderHook(
      () => {
        const bus = useCellBus();
        useMcpSpawnBridge(delegate);
        return bus;
      },
      { wrapper: wrapper() },
    );
    await flushMicrotasks();

    const pending = emitSpawn({
      requestId: "spawn-tuned",
      provider: "codex",
      workspaceId: "ws-1",
      permissionMode: "safe",
      model: "gpt-5.4-codex",
      effort: "xhigh",
    });
    act(() => {
      registerLiveSession("pane-tuned", "session-tuned");
      result.current.emit("terminal:spawned", { paneId: "pane-tuned", workspaceId: "ws-1", cwd: "/tmp" });
    });
    await pending;

    expect(delegate).toHaveBeenCalledWith('codex -m gpt-5.4-codex -c model_reasoning_effort="xhigh"', "ws-1");
  });

  it("hands the chosen Claude account to the delegate", async () => {
    const delegate = vi.fn<SpawnDelegate>(() => "pane-acct");
    const { result } = renderHook(
      () => {
        const bus = useCellBus();
        useMcpSpawnBridge(delegate);
        return bus;
      },
      { wrapper: wrapper() },
    );
    await flushMicrotasks();

    const pending = emitSpawn({ requestId: "spawn-acct", provider: "claude", workspaceId: "ws-1", profileId: " initech " });
    act(() => {
      registerLiveSession("pane-acct", "session-acct");
      result.current.emit("terminal:spawned", { paneId: "pane-acct", workspaceId: "ws-1", cwd: "/tmp" });
    });
    await pending;

    expect(delegate.mock.calls[0]?.[2]).toBe("initech");
  });

  it("hands the spawning agent's pane to the delegate (#319)", async () => {
    const delegate = vi.fn<SpawnDelegate>(() => "pane-kid");
    const { result } = renderHook(
      () => {
        const bus = useCellBus();
        useMcpSpawnBridge(delegate);
        return bus;
      },
      { wrapper: wrapper() },
    );
    await flushMicrotasks();

    const pending = emitSpawn({ requestId: "spawn-kid", provider: "claude", workspaceId: "ws-1", fromPaneId: "pane-agent" });
    act(() => {
      registerLiveSession("pane-kid", "session-kid");
      result.current.emit("terminal:spawned", { paneId: "pane-kid", workspaceId: "ws-1", cwd: "/tmp" });
    });
    await pending;

    expect(delegate.mock.calls[0]?.slice(1)).toEqual(["ws-1", undefined, "pane-agent"]);
  });

  it("uses the latest delegate without reinstalling the listener", async () => {
    const firstDelegate = vi.fn<SpawnDelegate>(() => "pane-old");
    const secondDelegate = vi.fn<SpawnDelegate>(() => "pane-new");

    const { result, rerender } = renderHook(
      ({ delegate }) => {
        const bus = useCellBus();
        useMcpSpawnBridge(delegate);
        return bus;
      },
      {
        wrapper: wrapper(),
        initialProps: { delegate: firstDelegate },
      },
    );

    await flushMicrotasks();
    rerender({ delegate: secondDelegate });
    await flushMicrotasks();

    const pending = emitSpawn({ requestId: "spawn-latest", provider: "codex", workspaceId: "ws-1" });
    act(() => {
      registerLiveSession("pane-new", "session-new");
      result.current.emit("terminal:spawned", { paneId: "pane-new", workspaceId: "ws-1", cwd: "/tmp" });
    });
    await pending;

    expect(firstDelegate).not.toHaveBeenCalled();
    expect(secondDelegate).toHaveBeenCalledWith("codex", "ws-1");
    expect(mocks.bridgeResolveMcpRequest).toHaveBeenCalledWith({
      requestId: "spawn-latest",
      ok: true,
      data: {
        paneId: "pane-new",
        workspaceId: "ws-1",
        cwd: "/tmp",
        sessionId: "session-new",
        provider: "codex",
      },
      error: undefined,
    });
  });

  it("unlistens if async listener installation resolves after unmount", async () => {
    mocks.setDeferListen(true);

    const { unmount } = renderHook(
      () => {
        useMcpSpawnBridge(() => "pane-1");
      },
      { wrapper: wrapper() },
    );

    await flushMicrotasks();
    expect(mocks.listeners.get("mcp://spawn-cell")).toHaveLength(1);

    unmount();
    act(() => {
      for (const resolve of mocks.pendingListenResolvers.splice(0)) {
        resolve(() => {
          mocks.listeners.set("mcp://spawn-cell", []);
        });
      }
    });
    await flushMicrotasks();

    expect(mocks.listeners.get("mcp://spawn-cell")).toEqual([]);
  });

  it("dedupes duplicate spawn events for the same MCP request id", async () => {
    const delegate = vi.fn<SpawnDelegate>(() => "pane-1");

    const { result } = renderHook(
      () => {
        const bus = useCellBus();
        useMcpSpawnBridge(delegate);
        return bus;
      },
      { wrapper: wrapper() },
    );

    await flushMicrotasks();

    const first = emitSpawn({ requestId: "spawn-dedupe", provider: "codex", workspaceId: "ws-1" });
    act(() => {
      registerLiveSession("pane-1", "session-1");
      result.current.emit("terminal:spawned", { paneId: "pane-1", workspaceId: "ws-1", cwd: "/tmp" });
    });
    await first;

    await emitSpawn({ requestId: "spawn-dedupe", provider: "codex", workspaceId: "ws-1" });

    expect(delegate).toHaveBeenCalledOnce();
    expect(mocks.bridgeResolveMcpRequest).toHaveBeenCalledTimes(1);
  });
});
