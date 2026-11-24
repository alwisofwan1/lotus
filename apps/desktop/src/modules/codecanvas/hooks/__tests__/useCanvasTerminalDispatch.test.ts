import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCanvasTerminalDispatch, type TerminalDispatchDeps } from "../useCanvasTerminalDispatch";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";

function fakeDeps() {
  const writes: Array<[string, string]> = [];
  const cbs = new Map<string, (s: TerminalRuntimeStatus) => void>();
  const deps: TerminalDispatchDeps = {
    subscribeStatus: (paneId, cb) => { cbs.set(paneId, cb); return () => cbs.delete(paneId); },
    write: (paneId, data) => { writes.push([paneId, data]); },
  };
  return { deps, writes, emit: (paneId: string, s: TerminalRuntimeStatus) => cbs.get(paneId)?.(s), isSubscribed: (id: string) => cbs.has(id) };
}

describe("useCanvasTerminalDispatch", () => {
  it("writes the command once the PTY goes live", () => {
    const f = fakeDeps();
    const { result } = renderHook(() => useCanvasTerminalDispatch(f.deps));
    act(() => result.current.schedule({ paneId: "p1", command: "claude 'x'\r" }));
    act(() => f.emit("p1", "starting"));
    expect(f.writes).toEqual([]);
    act(() => f.emit("p1", "live"));
    expect(f.writes).toEqual([["p1", "claude 'x'\r"]]);
  });

  it("writes only once and then unsubscribes", () => {
    const f = fakeDeps();
    const { result } = renderHook(() => useCanvasTerminalDispatch(f.deps));
    act(() => result.current.schedule({ paneId: "p1", command: "go\r" }));
    act(() => f.emit("p1", "live"));
    act(() => f.emit("p1", "live"));
    expect(f.writes).toHaveLength(1);
    expect(f.isSubscribed("p1")).toBe(false);
  });

  it("never writes if the PTY only ever idles/fails", () => {
    const f = fakeDeps();
    const { result } = renderHook(() => useCanvasTerminalDispatch(f.deps));
    act(() => result.current.schedule({ paneId: "p1", command: "go\r" }));
    act(() => f.emit("p1", "idle"));
    act(() => f.emit("p1", "failed"));
    expect(f.writes).toEqual([]);
  });
});
