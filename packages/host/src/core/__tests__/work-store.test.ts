import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkStore } from "../work-store.js";

describe("WorkStore", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-work-store-"));
    path = join(dir, "work.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a persisted planning work session for a device", () => {
    const store = new WorkStore(path);

    const session = store.create("42", {
      projectId: "lotus",
      projectPath: "/repo/lotus",
      provider: "claude",
      goal: "fix login bug",
    });

    expect(session).toEqual(expect.objectContaining({
      deviceId: "42",
      projectId: "lotus",
      projectPath: "/repo/lotus",
      provider: "claude",
      goal: "fix login bug",
      state: "planning",
      approvedAt: null,
      completedAt: null,
      summary: null,
      checkResult: null,
    }));

    const reloaded = new WorkStore(path);
    expect(reloaded.getActive("42")).toEqual(session);
  });

  it("updates state and plan without losing the active work session", () => {
    const store = new WorkStore(path);
    const session = store.create("42", {
      projectId: "lotus",
      projectPath: "/repo/lotus",
      provider: "claude",
      goal: "fix login bug",
    });

    const updated = store.update(session.id, {
      state: "awaiting-approval",
      plan: "1. inspect\n2. patch\n3. test",
      summary: "not done yet",
      checkResult: "checks pending",
    });

    expect(updated?.state).toBe("awaiting-approval");
    expect(updated?.plan).toContain("inspect");
    expect(updated?.summary).toBe("not done yet");
    expect(updated?.checkResult).toBe("checks pending");
    expect(store.getActive("42")?.id).toBe(session.id);
  });

  it("lists active sessions for dashboard surfaces", () => {
    const store = new WorkStore(path);
    const a = store.create("1", {
      projectId: "api",
      projectPath: "/srv/api",
      provider: "claude",
      goal: "fix api",
    });
    const b = store.create("2", {
      projectId: "web",
      projectPath: "/srv/web",
      provider: "codex",
      goal: "fix web",
    });
    store.update(b.id, { state: "complete" });

    expect(store.listActive()).toEqual([a]);
  });

  it("clears active work when the session reaches a terminal state", () => {
    const store = new WorkStore(path);
    const session = store.create("42", {
      projectId: "lotus",
      projectPath: "/repo/lotus",
      provider: "claude",
      goal: "fix login bug",
    });

    store.update(session.id, { state: "complete" });

    expect(store.get(session.id)?.state).toBe("complete");
    expect(store.getActive("42")).toBeNull();
  });
});
