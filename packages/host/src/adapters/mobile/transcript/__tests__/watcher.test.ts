import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptWatcher } from "../watcher.js";

interface FakeHandle {
  path: string;
  closed: boolean;
  fire: () => void;
}

function harness(opts: { live?: (paneId: string) => boolean; throwOn?: string } = {}) {
  const handles: FakeHandle[] = [];
  const changed: string[] = [];
  const watcher = new TranscriptWatcher({
    watch: (path, onChange) => {
      if (opts.throwOn === path) throw new Error("ENOENT");
      const handle: FakeHandle = { path, closed: false, fire: onChange };
      handles.push(handle);
      return { close: () => { handle.closed = true; } };
    },
    isLive: opts.live ?? (() => true),
    onChanged: (paneId) => changed.push(paneId),
  }, 50);
  return { watcher, handles, changed };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TranscriptWatcher", () => {
  it("reports a change after the debounce, once per burst", () => {
    const { watcher, handles, changed } = harness();
    watcher.follow("pane-1", "/t/1.jsonl");
    handles[0]?.fire();
    handles[0]?.fire();
    handles[0]?.fire();
    expect(changed).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(changed).toEqual(["pane-1"]);
  });

  it("reports the next burst too", () => {
    const { watcher, handles, changed } = harness();
    watcher.follow("pane-1", "/t/1.jsonl");
    handles[0]?.fire();
    vi.advanceTimersByTime(50);
    handles[0]?.fire();
    vi.advanceTimersByTime(50);
    expect(changed).toEqual(["pane-1", "pane-1"]);
  });

  it("following the same path twice watches once", () => {
    const { watcher, handles } = harness();
    watcher.follow("pane-1", "/t/1.jsonl");
    watcher.follow("pane-1", "/t/1.jsonl");
    expect(handles).toHaveLength(1);
    expect(watcher.size()).toBe(1);
  });

  it("a resumed session writing a new file is followed instead", () => {
    const { watcher, handles, changed } = harness();
    watcher.follow("pane-1", "/t/1.jsonl");
    watcher.follow("pane-1", "/t/2.jsonl");
    expect(handles[0]?.closed).toBe(true);
    expect(handles[1]?.path).toBe("/t/2.jsonl");
    handles[1]?.fire();
    vi.advanceTimersByTime(50);
    expect(changed).toEqual(["pane-1"]);
  });

  it("a path that cannot be watched is not recorded, so the next fire retries", () => {
    const { watcher, handles } = harness({ throwOn: "/t/gone.jsonl" });
    watcher.follow("pane-1", "/t/gone.jsonl");
    expect(watcher.size()).toBe(0);
    expect(handles).toHaveLength(0);
  });

  it("forget closes the handle and cancels a pending report", () => {
    const { watcher, handles, changed } = harness();
    watcher.follow("pane-1", "/t/1.jsonl");
    handles[0]?.fire();
    watcher.forget("pane-1");
    vi.advanceTimersByTime(50);
    expect(handles[0]?.closed).toBe(true);
    expect(changed).toEqual([]);
    expect(watcher.size()).toBe(0);
  });

  it("a change on a pane that is gone is dropped and the watch released", () => {
    const live = new Set(["pane-1"]);
    const { watcher, handles, changed } = harness({ live: (p) => live.has(p) });
    watcher.follow("pane-1", "/t/1.jsonl");
    live.delete("pane-1");
    handles[0]?.fire();
    vi.advanceTimersByTime(50);
    expect(changed).toEqual([]);
    expect(handles[0]?.closed).toBe(true);
    expect(watcher.size()).toBe(0);
  });

  it("following one pane reaps the panes that have since closed", () => {
    const live = new Set(["pane-1", "pane-2"]);
    const { watcher, handles } = harness({ live: (p) => live.has(p) });
    watcher.follow("pane-1", "/t/1.jsonl");
    live.delete("pane-1");
    watcher.follow("pane-2", "/t/2.jsonl");
    expect(handles[0]?.closed).toBe(true);
    expect(watcher.size()).toBe(1);
  });
});
