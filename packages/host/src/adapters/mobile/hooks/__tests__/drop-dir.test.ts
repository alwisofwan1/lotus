import { describe, expect, it } from "vitest";

import { DRAIN_TTL_MS, drainPending, processDropFile, type ProcessDeps } from "../drop-dir.js";
import type { DropPayload } from "../payload.js";

/**
 * The interesting half of the drop directory is what it refuses, so the filesystem is injected
 * and every branch is reachable without one.
 */

const NOW = 1_800_000_000_000;

function fs(files: Record<string, { body: string; mtimeMs?: number }>) {
  const removed: string[] = [];
  const reads: string[] = [];
  const slept: number[] = [];
  const deps: ProcessDeps = {
    list: () => Object.keys(files),
    mtimeMs: (path) => files[base(path)]?.mtimeMs,
    read: (path) => { reads.push(path); return files[base(path)]?.body; },
    remove: (path) => { removed.push(base(path)); delete files[base(path)]; },
    now: () => NOW,
    sleep: (ms) => { slept.push(ms); },
  };
  return { deps, removed, reads, slept };
}

const base = (path: string): string => path.split("/").pop() ?? path;

const drop = (over: Record<string, unknown> = {}): string => JSON.stringify({
  version: 1, sessionId: "s", agentType: "claude", event: "needs-input", status: "needs-input",
  title: "Needs input", body: "?", userPrompt: "", cwd: "/srv/api", pid: 1, agentPid: 2,
  paneId: "pane-7", timestamp: NOW, ...over,
});

describe("processDropFile", () => {
  it("reads, emits and unlinks — the directory is owned by the consumer", () => {
    const { deps, removed } = fs({ "a.json": { body: drop() } });
    const seen: DropPayload[] = [];

    expect(processDropFile("/d/a.json", deps, (p) => seen.push(p))).toBe("emitted");
    expect(seen[0]?.paneId).toBe("pane-7");
    // Not cleanup: a file left behind is a file the next pass emits again.
    expect(removed).toEqual(["a.json"]);
  });

  it("leaves a .tmp alone, because the producer has not renamed it yet", () => {
    const { deps, removed, reads } = fs({ "a.json.tmp": { body: "half written" } });

    expect(processDropFile("/d/a.json.tmp", deps, () => undefined)).toBe("in-progress");
    expect(reads).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("ignores a file that is not a drop at all", () => {
    const { deps } = fs({ "README": { body: "" } });
    expect(processDropFile("/d/README", deps, () => undefined)).toBe("skipped");
  });

  /**
   * The schema's own TOCTOU case: a create event can arrive before the rename completes, so the
   * first read sees nothing. One retry — never a loop.
   */
  it("retries a read once, then gives up rather than looping", () => {
    let attempts = 0;
    const deps: ProcessDeps = {
      list: () => [], mtimeMs: () => undefined, remove: () => undefined, now: () => NOW,
      read: () => { attempts += 1; return attempts === 1 ? undefined : drop(); },
      sleep: () => undefined,
    };
    const seen: DropPayload[] = [];

    expect(processDropFile("/d/a.json", deps, (p) => seen.push(p))).toBe("emitted");
    expect(attempts).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it("gives up on a file it still cannot read, and leaves it for whoever owns it", () => {
    const { deps, removed } = fs({});

    expect(processDropFile("/d/gone.json", deps, () => undefined)).toBe("read-failed");
    expect(removed).toEqual([]);
  });

  it("unlinks a corrupt file so the watcher cannot loop on it", () => {
    const { deps, removed } = fs({ "bad.json": { body: "{not json" } });
    const seen: DropPayload[] = [];

    expect(processDropFile("/d/bad.json", deps, (p) => seen.push(p))).toBe("invalid");
    expect(seen).toEqual([]);
    expect(removed).toEqual(["bad.json"]);
  });

  it("unlinks a version it cannot read, rather than accumulating it", () => {
    const { deps, removed } = fs({ "v9.json": { body: drop({ version: 9 }) } });

    expect(processDropFile("/d/v9.json", deps, () => undefined)).toBe("invalid");
    expect(removed).toEqual(["v9.json"]);
  });
});

describe("drainPending", () => {
  /**
   * A host that was down for a day must not wake a phone with yesterday's approvals. Stale files
   * are unlinked **without being read** — the payload is not even parsed.
   */
  it("unlinks what is past the window without reading it", () => {
    const { deps, removed, reads } = fs({
      "old.json": { body: drop(), mtimeMs: NOW - DRAIN_TTL_MS - 1 },
    });
    const seen: DropPayload[] = [];

    expect(drainPending("/d", deps, (p) => seen.push(p))).toEqual(["stale"]);
    expect(seen).toEqual([]);
    expect(reads).toEqual([]);
    expect(removed).toEqual(["old.json"]);
  });

  it("emits what is still inside the window", () => {
    const { deps } = fs({ "fresh.json": { body: drop(), mtimeMs: NOW - 1000 } });
    const seen: DropPayload[] = [];

    expect(drainPending("/d", deps, (p) => seen.push(p))).toEqual(["emitted"]);
    expect(seen).toHaveLength(1);
  });

  /**
   * Emitting one stale event costs a notification; dropping a live one costs an agent that waits
   * forever. So an unreadable mtime is treated as fresh.
   */
  it("treats a file it cannot age as fresh", () => {
    const { deps } = fs({ "unknown.json": { body: drop() } });
    const seen: DropPayload[] = [];

    expect(drainPending("/d", deps, (p) => seen.push(p))).toEqual(["emitted"]);
    expect(seen).toHaveLength(1);
  });

  it("passes over an in-progress write and anything that is not a drop", () => {
    const { deps, removed } = fs({
      "a.json.tmp": { body: "" },
      "notes.txt": { body: "" },
    });

    expect(drainPending("/d", deps, () => undefined)).toEqual(["in-progress", "skipped"]);
    expect(removed).toEqual([]);
  });

  it("one bad file does not cost the good ones", () => {
    const { deps } = fs({
      "bad.json": { body: "{" },
      "good.json": { body: drop({ paneId: "pane-9" }) },
    });
    const seen: DropPayload[] = [];

    expect(drainPending("/d", deps, (p) => seen.push(p))).toEqual(["invalid", "emitted"]);
    expect(seen.map((p) => p.paneId)).toEqual(["pane-9"]);
  });

  it("says nothing happened for a directory that is not there", () => {
    const deps: ProcessDeps = {
      list: () => [], mtimeMs: () => undefined, read: () => undefined,
      remove: () => undefined, now: () => NOW,
    };
    expect(drainPending("/nope", deps, () => undefined)).toEqual([]);
  });
});
