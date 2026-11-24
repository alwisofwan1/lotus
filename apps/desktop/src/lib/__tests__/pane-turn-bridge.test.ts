/**
 * The frontend half of `plans/honest-agent-status/` Slice 0: the two readers of Rust's per-pane
 * turn store. Until these existed, `pane_turns` had a reader in the MCP fleet reply and one in
 * the mobile HTTP handler and **none in the desktop frontend** — so the phone knew an agent was
 * blocked on a permission prompt while the canvas card showed it as running.
 *
 * These tests pin the two properties the resolver downstream depends on and that a well-meaning
 * refactor would quietly break: absent stays absent, and neither reader throws outside Tauri.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
const mockListen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

function enterTauri() {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
}

function leaveTauri() {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
}

describe("canvasPaneTurns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    leaveTauri();
  });

  it("asks Rust for exactly the pane ids it was given", async () => {
    enterTauri();
    mockInvoke.mockResolvedValue([]);
    const { canvasPaneTurns } = await import("../tauri-api");

    await canvasPaneTurns(["canvas:cp_1:node-a", "canvas:cp_1:node-b"]);

    expect(mockInvoke).toHaveBeenCalledWith("canvas_pane_turns", {
      paneIds: ["canvas:cp_1:node-a", "canvas:cp_1:node-b"],
    });
  });

  it("returns the snapshots Rust reported, unmodified", async () => {
    enterTauri();
    mockInvoke.mockResolvedValue([
      { paneId: "canvas:cp_1:node-a", turn: "needs-input", turnAgeMs: 1200 },
    ]);
    const { canvasPaneTurns } = await import("../tauri-api");

    const out = await canvasPaneTurns(["canvas:cp_1:node-a"]);

    expect(out).toEqual([{ paneId: "canvas:cp_1:node-a", turn: "needs-input", turnAgeMs: 1200 }]);
  });

  it("passes through a turn value this build has never heard of", async () => {
    // The wire vocabulary lives in `scripts/agent-notify/event-mapping.mjs` and can grow without
    // a desktop rebuild. An unknown value must reach the resolver intact so it can decline to act
    // on it — dropping or coercing it here would turn a new state into a silently wrong one.
    enterTauri();
    mockInvoke.mockResolvedValue([{ paneId: "p-1", turn: "compacting", turnAgeMs: 5 }]);
    const { canvasPaneTurns } = await import("../tauri-api");

    const out = await canvasPaneTurns(["p-1"]);

    expect(out[0].turn).toBe("compacting");
  });

  it("omits panes Rust had no fact for, rather than defaulting them", async () => {
    // The load-bearing property of the whole plan. An entry invented here would make every
    // hook-less runner (cursor, a non-claude custom command) look settled at the prompt.
    enterTauri();
    mockInvoke.mockResolvedValue([{ paneId: "p-1", turn: "idle", turnAgeMs: 10 }]);
    const { canvasPaneTurns } = await import("../tauri-api");

    const out = await canvasPaneTurns(["p-1", "p-2"]);

    expect(out).toHaveLength(1);
    expect(out.some((s) => s.paneId === "p-2")).toBe(false);
  });

  it("does not call Rust at all for an empty pane list", async () => {
    enterTauri();
    const { canvasPaneTurns } = await import("../tauri-api");

    expect(await canvasPaneTurns([])).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns an empty list outside Tauri instead of throwing", async () => {
    const { canvasPaneTurns } = await import("../tauri-api");

    expect(await canvasPaneTurns(["p-1"])).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("subscribeCanvasPaneTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    leaveTauri();
  });

  it("delivers a pushed turn fact to its listener", async () => {
    enterTauri();
    let emit: ((event: { payload: unknown }) => void) | undefined;
    mockListen.mockImplementation((_name: string, handler: (e: { payload: unknown }) => void) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
    const { subscribeCanvasPaneTurn } = await import("../tauri-api");
    const seen: unknown[] = [];

    const off = subscribeCanvasPaneTurn((event) => seen.push(event));
    await vi.waitFor(() => expect(emit).toBeDefined());
    emit!({ payload: { paneId: "p-1", turn: "needs-input", atMs: 42 } });

    expect(seen).toEqual([{ paneId: "p-1", turn: "needs-input", atMs: 42 }]);
    expect(mockListen).toHaveBeenCalledWith("mcp://pane-turn", expect.any(Function));
    off();
  });

  it("ignores an event with no pane id — there is nothing to correlate", async () => {
    enterTauri();
    let emit: ((event: { payload: unknown }) => void) | undefined;
    mockListen.mockImplementation((_name: string, handler: (e: { payload: unknown }) => void) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
    const { subscribeCanvasPaneTurn } = await import("../tauri-api");
    const seen: unknown[] = [];

    subscribeCanvasPaneTurn((event) => seen.push(event));
    await vi.waitFor(() => expect(emit).toBeDefined());
    emit!({ payload: { turn: "idle", atMs: 1 } });

    expect(seen).toEqual([]);
  });

  it("is a silent no-op outside Tauri", async () => {
    const { subscribeCanvasPaneTurn } = await import("../tauri-api");

    const off = subscribeCanvasPaneTurn(() => {
      throw new Error("must never be called");
    });

    expect(mockListen).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
  });

  it("survives an unavailable event bridge without throwing", async () => {
    // The cold hydrate is the fallback: losing the push channel must degrade to stale-but-present
    // state, never to a crashed canvas.
    enterTauri();
    mockListen.mockRejectedValue(new Error("event bridge unavailable"));
    const { subscribeCanvasPaneTurn } = await import("../tauri-api");

    const off = subscribeCanvasPaneTurn(() => {});

    expect(() => off()).not.toThrow();
  });

  it("unsubscribes even when the listener resolved after the caller gave up", async () => {
    // React unmount / HMR races the `listen` promise. Whoever loses must not leave a live
    // listener behind writing into a dead component.
    enterTauri();
    let resolveListen: ((off: () => void) => void) | undefined;
    const offSpy = vi.fn();
    mockListen.mockImplementation(
      () => new Promise<() => void>((resolve) => (resolveListen = resolve)),
    );
    const { subscribeCanvasPaneTurn } = await import("../tauri-api");

    const off = subscribeCanvasPaneTurn(() => {});
    off();
    await vi.waitFor(() => expect(resolveListen).toBeDefined());
    resolveListen!(offSpy);

    await vi.waitFor(() => expect(offSpy).toHaveBeenCalled());
  });
});
