import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileView } from "../../services/file-node/file-watch-registry";

const unsubscribe = vi.fn();
let push: ((view: FileView) => void) | null = null;
const subscribe = vi.fn((_source: unknown, listener: (view: FileView) => void) => {
  push = listener;
  listener({ status: "loading" });
  return unsubscribe;
});
const fetchGitBaseline = vi.fn(async () => "base\n");

vi.mock("../../services/file-node/file-node-io", () => ({
  fileWatchRegistry: { subscribe: (...args: Parameters<typeof subscribe>) => subscribe(...args) },
  activeFileSource: (path: string) => ({ root: "/repo", location: null, path }),
  fetchGitBaseline: (...args: unknown[]) => (fetchGitBaseline as (...a: unknown[]) => Promise<string | null>)(...args),
}));

import { useFileNodeView } from "../useFileNode";

const ready = (content: string, rev = 1): FileView => ({ status: "ready", content, sizeBytes: content.length, mtime: 1, rev });

describe("useFileNodeView", () => {
  beforeEach(() => {
    subscribe.mockClear();
    unsubscribe.mockClear();
    fetchGitBaseline.mockClear();
    push = null;
  });

  it("watches while the node is drawn in full, and follows the file", async () => {
    const { result } = renderHook(() => useFileNodeView("/repo/a.ts", true));
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(result.current.view).toEqual({ status: "loading" });
    act(() => push?.(ready("one")));
    expect(result.current.view).toMatchObject({ status: "ready", content: "one" });
    await waitFor(() => expect(result.current.baseline).toBe("base\n"));
  });

  it("stops watching below the glyph tier, and watches again when it is back", () => {
    const { rerender } = renderHook(({ active }) => useFileNodeView("/repo/a.ts", active), { initialProps: { active: true } });
    expect(subscribe).toHaveBeenCalledTimes(1);
    rerender({ active: false });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    rerender({ active: true });
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("never subscribes while inactive from the start", () => {
    renderHook(() => useFileNodeView("/repo/a.ts", false));
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("refetches the git baseline when the file is read again", async () => {
    renderHook(() => useFileNodeView("/repo/a.ts", true));
    act(() => push?.(ready("one", 1)));
    await waitFor(() => expect(fetchGitBaseline).toHaveBeenCalledTimes(1));
    act(() => push?.(ready("two", 2)));
    await waitFor(() => expect(fetchGitBaseline).toHaveBeenCalledTimes(2));
  });
});
