import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeCanvasMemoryItem } from "@/lib/tauri/codecanvas";

const listMemory = vi.fn();
const searchMemory = vi.fn();
const archiveMemory = vi.fn();
const restoreMemory = vi.fn();
const setPinned = vi.fn();
const writeMemory = vi.fn();

vi.mock("@/lib/tauri/codecanvas", () => ({
  codecanvasMemoryList: (...args: unknown[]) => listMemory(...args),
  codecanvasMemorySearch: (...args: unknown[]) => searchMemory(...args),
  codecanvasMemoryArchive: (...args: unknown[]) => archiveMemory(...args),
  codecanvasMemoryRestore: (...args: unknown[]) => restoreMemory(...args),
  codecanvasMemorySetPinned: (...args: unknown[]) => setPinned(...args),
  codecanvasMemoryWrite: (...args: unknown[]) => writeMemory(...args),
}));

vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: () => false,
  loadTauriCore: vi.fn(),
}));

import { useCodeCanvasProjectMemory } from "../useCodeCanvasProjectMemory";

function item(overrides: Partial<CodeCanvasMemoryItem> = {}): CodeCanvasMemoryItem {
  return {
    id: "mem-1",
    projectId: "p1",
    scopeKind: "project",
    kind: "note",
    body: "body",
    importance: 0,
    tags: [],
    metadata: {},
    source: "human",
    actorKind: "human",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("useCodeCanvasProjectMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMemory.mockResolvedValue([item()]);
    archiveMemory.mockResolvedValue(undefined);
    restoreMemory.mockResolvedValue(undefined);
    setPinned.mockResolvedValue(item({ tags: ["pinned"] }));
  });

  it("loads the hot set for a project", async () => {
    const { result } = renderHook(() => useCodeCanvasProjectMemory("p1"));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(listMemory).toHaveBeenCalledWith({ projectId: "p1", includeArchived: false, limit: 40 });
  });

  it("reloads with archived rows when the archived view is requested", async () => {
    const { result } = renderHook(() => useCodeCanvasProjectMemory("p1"));
    await waitFor(() => expect(listMemory).toHaveBeenCalled());

    await act(async () => { await result.current.setIncludeArchived(true); });

    expect(listMemory).toHaveBeenLastCalledWith({ projectId: "p1", includeArchived: true, limit: 40 });
    expect(result.current.includeArchived).toBe(true);
  });

  it("keeps the archived view when searching", async () => {
    searchMemory.mockResolvedValue([{ item: item(), rank: 1 }]);
    const { result } = renderHook(() => useCodeCanvasProjectMemory("p1"));
    await waitFor(() => expect(listMemory).toHaveBeenCalled());

    await act(async () => { await result.current.setIncludeArchived(true); });
    await act(async () => { await result.current.search("stash"); });

    expect(searchMemory).toHaveBeenCalledWith({
      projectId: "p1",
      query: "stash",
      includeArchived: true,
      limit: 40,
    });
  });

  it("restores an archived item and refreshes", async () => {
    const { result } = renderHook(() => useCodeCanvasProjectMemory("p1"));
    await waitFor(() => expect(listMemory).toHaveBeenCalled());
    listMemory.mockClear();

    await act(async () => { await result.current.restore("mem-9"); });

    expect(restoreMemory).toHaveBeenCalledWith("p1", "mem-9");
    expect(listMemory).toHaveBeenCalled();
  });

  it("pins an item and refreshes", async () => {
    const { result } = renderHook(() => useCodeCanvasProjectMemory("p1"));
    await waitFor(() => expect(listMemory).toHaveBeenCalled());
    listMemory.mockClear();

    await act(async () => { await result.current.setPinned("mem-9", true); });

    expect(setPinned).toHaveBeenCalledWith("p1", "mem-9", true);
    expect(listMemory).toHaveBeenCalled();
  });

  it("surfaces a failed pin instead of throwing at the caller", async () => {
    setPinned.mockRejectedValue(new Error("command not found"));
    const { result } = renderHook(() => useCodeCanvasProjectMemory("p1"));
    await waitFor(() => expect(listMemory).toHaveBeenCalled());

    await act(async () => { await result.current.setPinned("mem-9", true); });

    expect(result.current.error).toContain("command not found");
  });

  it("does nothing without a project", async () => {
    const { result } = renderHook(() => useCodeCanvasProjectMemory(null));
    await act(async () => { await result.current.restore("mem-1"); });
    expect(restoreMemory).not.toHaveBeenCalled();
    expect(result.current.items).toEqual([]);
  });
});
