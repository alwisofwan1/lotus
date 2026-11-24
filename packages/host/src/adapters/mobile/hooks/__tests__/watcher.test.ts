import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DropWatcher, defaultDropDir } from "../watcher.js";
import type { DropPayload } from "../payload.js";

/**
 * The thin part, so a real directory is the point here — everything that decides anything is
 * tested without one in `drop-dir.test.ts`.
 */

const dirs: string[] = [];
const watchers: DropWatcher[] = [];

afterEach(() => {
  for (const w of watchers.splice(0)) w.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lotus-hooks-"));
  dirs.push(dir);
  return dir;
}

const drop = (over: Record<string, unknown> = {}): string => JSON.stringify({
  version: 1, sessionId: "s", agentType: "claude", event: "needs-input", status: "needs-input",
  title: "Needs input", body: "?", userPrompt: "", cwd: "/srv/api", pid: 1, agentPid: 2,
  paneId: "pane-7", timestamp: Date.now(), ...over,
});

/** Written the way the schema's atomic protocol requires: stage `.tmp`, then rename. */
function writeDrop(dir: string, name: string, body: string): void {
  const tmp = join(dir, `${name}.tmp`);
  writeFileSync(tmp, body);
  renameSync(tmp, join(dir, name));
}

/**
 * Waits for a condition rather than for a duration.
 *
 * A fixed sleep here is a guess about the scheduler, and it flaked exactly once in a full-suite
 * run while passing alone every time — which is the shape of a timing assumption, not of a bug.
 */
async function until(done: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("DropWatcher", () => {
  /**
   * Draining before watching is not an optimisation: an agent that asked for permission while the
   * host was restarting is still waiting, and the file is the only record that it asked.
   */
  it("picks up what landed while the host was down", () => {
    const dir = tempDir();
    writeDrop(dir, "a.json", drop());
    const seen: DropPayload[] = [];

    const watcher = new DropWatcher({ dir, onPayload: (p) => seen.push(p) });
    watchers.push(watcher);
    watcher.start();

    expect(seen.map((p) => p.paneId)).toEqual(["pane-7"]);
  });

  it("picks up a drop that lands while it is watching", async () => {
    const dir = tempDir();
    const seen: DropPayload[] = [];
    // A short sweep, because what is under test is that the drop is picked up — not which of
    // the two mechanisms noticed it. `fs.watch` alone is not a guarantee (see `SWEEP_MS`).
    const watcher = new DropWatcher({ dir, onPayload: (p) => seen.push(p), sweepMs: 25 });
    watchers.push(watcher);
    watcher.start();

    writeDrop(dir, "b.json", drop({ paneId: "pane-9" }));
    await until(() => seen.length > 0);

    expect(seen.map((p) => p.paneId)).toEqual(["pane-9"]);
  });

  /** The consumer owns the directory: a file left behind is one the next pass emits again. */
  it("leaves the directory empty behind it", async () => {
    const dir = tempDir();
    const watcher = new DropWatcher({ dir, onPayload: () => undefined, sweepMs: 25 });
    watchers.push(watcher);
    watcher.start();

    writeDrop(dir, "c.json", drop());
    await until(() => readdirSync(dir).length === 0);

    expect(readdirSync(dir)).toEqual([]);
  });

  it("creates the directory when it is not there yet", () => {
    const dir = join(tempDir(), "not", "created", "yet");
    const watcher = new DropWatcher({ dir, onPayload: () => undefined });
    watchers.push(watcher);

    expect(() => watcher.start()).not.toThrow();
  });

  it("survives a corrupt drop without stopping", async () => {
    const dir = tempDir();
    const seen: DropPayload[] = [];
    const watcher = new DropWatcher({ dir, onPayload: (p) => seen.push(p), sweepMs: 25 });
    watchers.push(watcher);
    watcher.start();

    writeDrop(dir, "bad.json", "{not json");
    await until(() => readdirSync(dir).length === 0);
    writeDrop(dir, "good.json", drop({ paneId: "pane-3" }));
    await until(() => seen.length > 0);

    expect(seen.map((p) => p.paneId)).toEqual(["pane-3"]);
  });
});

describe("defaultDropDir", () => {
  /**
   * The state dir, never a hardcoded `~/.lotus`: it is what separates dev from release, and
   * hardcoding once made both profiles watch one directory and race for every event.
   */
  it("follows the profile's state directory", () => {
    expect(defaultDropDir({ LOTUS_STATE_DIR: "/custom/state" }, "/home/op"))
      .toBe("/custom/state/agent-hooks/global");
    expect(defaultDropDir({}, "/home/op")).toBe("/home/op/.lotus/agent-hooks/global");
  });

  /**
   * The property the sweep exists for: delivery must not depend on `fs.watch` having fired. This
   * test never gives it the chance — the file is written before the watch could plausibly notice,
   * and a watcher that only listened would sit on it forever.
   */
  it("delivers a drop even when the watch never fires", async () => {
    const dir = tempDir();
    const seen: DropPayload[] = [];
    const watcher = new DropWatcher({ dir, onPayload: (p) => seen.push(p), sweepMs: 25 });
    watchers.push(watcher);
    watcher.start();
    watcher["watcher"]?.close();
    (watcher as unknown as { watcher: unknown }).watcher = null;

    writeDrop(dir, "swept.json", drop({ paneId: "pane-swept" }));
    await until(() => seen.length > 0);

    expect(seen.map((p) => p.paneId)).toEqual(["pane-swept"]);
  });
});
