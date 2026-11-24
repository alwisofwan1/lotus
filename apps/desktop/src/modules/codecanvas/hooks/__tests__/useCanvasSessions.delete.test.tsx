import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasSessions } from "../useCanvasSessions";
import type { CanvasSessionStore } from "../../services/session-store";
import type { CanvasSessionRecord } from "../../services/session-record";

function record(overrides: Partial<CanvasSessionRecord> = {}): CanvasSessionRecord {
  return {
    id: "sess-1",
    projectId: "cp_1",
    nodeId: "agent-1",
    runner: "claude",
    status: "resumable",
    title: "Probe · baris hantu",
    origin: "manual",
    cwd: "/repo",
    createdAt: 0,
    lastActivityAt: 0,
    ...overrides,
  } as CanvasSessionRecord;
}

function fakeStore(rows: CanvasSessionRecord[]): CanvasSessionStore & { remove: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => rows),
    upsert: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  } as never;
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe("useCanvasSessions — delete with undo", () => {
  // The row must leave the list on the press, not when the write lands: a list that waits for a
  // round trip reads as a button that did nothing.
  it("removes the row immediately and writes only after the grace period", async () => {
    const store = fakeStore([record()]);
    const { result } = renderHook(() => useCanvasSessions("cp_1", store));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => result.current.deleteSession(record()));
    expect(result.current.sessions).toHaveLength(0);
    expect(store.remove).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(6000); });
    await waitFor(() => expect(store.remove).toHaveBeenCalledWith("sess-1"));
  });

  // Undo is the whole safety net here — there is no dialog. It has to restore the row AND make sure
  // the delete never reaches the store.
  it("puts the row back and never writes when undone", async () => {
    const store = fakeStore([record()]);
    const { result } = renderHook(() => useCanvasSessions("cp_1", store));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => result.current.deleteSession(record()));
    act(() => result.current.undoDelete());
    expect(result.current.sessions).toHaveLength(1);

    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(store.remove).not.toHaveBeenCalled();
  });

  // Closing the popover is not "never mind". The undo window simply ends, and the delete the user
  // asked for has to land — otherwise the row quietly returns on the next read.
  it("commits a pending delete when the surface goes away", async () => {
    const store = fakeStore([record()]);
    const { result, unmount } = renderHook(() => useCanvasSessions("cp_1", store));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => result.current.deleteSession(record()));
    unmount();

    await waitFor(() => expect(store.remove).toHaveBeenCalledWith("sess-1"));
  });

  it("exposes what was just deleted, so the panel can name it", async () => {
    const store = fakeStore([record()]);
    const { result } = renderHook(() => useCanvasSessions("cp_1", store));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => result.current.deleteSession(record()));
    expect(result.current.pendingDelete?.title).toBe("Probe · baris hantu");

    act(() => result.current.undoDelete());
    expect(result.current.pendingDelete).toBeNull();
  });

  // A running conversation is refused by `deleteDecision`; the hook must not quietly drop it.
  it("refuses to remove a live row", async () => {
    const live = record({ status: "live" });
    const store = fakeStore([live]);
    const { result } = renderHook(() => useCanvasSessions("cp_1", store));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => result.current.deleteSession(live));

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.pendingDelete).toBeNull();
  });
});
