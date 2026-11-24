import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../session-store.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "lotus-session-store-test-"));
}

describe("SessionStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = makeTmp();
    filePath = join(dir, "sessions.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores and retrieves an attachment", () => {
    const store = new SessionStore(filePath);
    store.attach("123", "sess-abc");
    expect(store.getAttachment("123")).toBe("sess-abc");
  });

  it("returns null for unknown deviceId", () => {
    const store = new SessionStore(filePath);
    expect(store.getAttachment("999")).toBeNull();
  });

  it("overwrites an existing attachment", () => {
    const store = new SessionStore(filePath);
    store.attach("123", "sess-old");
    store.attach("123", "sess-new");
    expect(store.getAttachment("123")).toBe("sess-new");
  });

  it("detach removes the entry", () => {
    const store = new SessionStore(filePath);
    store.attach("123", "sess-abc");
    store.detach("123");
    expect(store.getAttachment("123")).toBeNull();
  });

  it("detach on unknown deviceId is a no-op", () => {
    const store = new SessionStore(filePath);
    expect(() => store.detach("999")).not.toThrow();
  });

  it("persists across instances (survives restart)", () => {
    const store1 = new SessionStore(filePath);
    store1.attach("42", "sess-persisted");

    const store2 = new SessionStore(filePath);
    expect(store2.getAttachment("42")).toBe("sess-persisted");
  });

  it("prunes entries older than TTL on load", () => {
    const ttlMs = 1000;
    const store1 = new SessionStore(filePath, ttlMs);
    store1.attach("7", "stale-session");

    // Manually backdate the stored timestamp
    const data = JSON.parse(readFileSync(filePath, "utf8")) as {
      chats: Record<string, { ptyAttachment?: { sessionId: string; attachedAt: number } }>;
    };
    data.chats["7"]!.ptyAttachment!.attachedAt = Date.now() - ttlMs - 1;
    writeFileSync(filePath, JSON.stringify(data));

    const store2 = new SessionStore(filePath, ttlMs);
    expect(store2.getAttachment("7")).toBeNull();
  });

  it("prunes stale entries on getAttachment (live TTL check)", () => {
    const ttlMs = 500;
    const store = new SessionStore(filePath, ttlMs);
    store.attach("8", "live-then-stale");

    // Backdate in place
    const data = JSON.parse(readFileSync(filePath, "utf8")) as {
      chats: Record<string, { ptyAttachment?: { sessionId: string; attachedAt: number } }>;
    };
    data.chats["8"]!.ptyAttachment!.attachedAt = Date.now() - ttlMs - 1;
    writeFileSync(filePath, JSON.stringify(data));

    // Force reload stale data
    const store2 = new SessionStore(filePath, ttlMs);
    expect(store2.getAttachment("8")).toBeNull();
  });

  it("handles missing file gracefully (first run)", () => {
    const store = new SessionStore(join(dir, "nonexistent.json"));
    expect(store.getAttachment("1")).toBeNull();
  });

  it("setFocus / getFocus round-trip workspace + pane", () => {
    const store = new SessionStore(filePath);
    store.setFocus("42", "ws-a", "pane-1");
    expect(store.getFocus("42")).toEqual(expect.objectContaining({ workspaceId: "ws-a", paneId: "pane-1" }));
  });

  it("setFocus without paneId stores workspaceId only", () => {
    const store = new SessionStore(filePath);
    store.setFocus("42", "ws-a");
    expect(store.getFocus("42")).toEqual(expect.objectContaining({ workspaceId: "ws-a" }));
  });

  it("getFocus returns null when no focus is set", () => {
    const store = new SessionStore(filePath);
    expect(store.getFocus("42")).toBeNull();
  });

  it("clearFocus removes the focus entry", () => {
    const store = new SessionStore(filePath);
    store.setFocus("42", "ws-a", "pane-1");
    store.clearFocus("42");
    expect(store.getFocus("42")).toBeNull();
  });

  it("focus persists across instances", () => {
    const store1 = new SessionStore(filePath);
    store1.setFocus("7", "ws-z", "pane-7");

    const store2 = new SessionStore(filePath);
    expect(store2.getFocus("7")).toEqual(expect.objectContaining({ workspaceId: "ws-z", paneId: "pane-7" }));
  });

  it("focus state coexists with PTY attachment for the same chat", () => {
    const store = new SessionStore(filePath);
    store.attach("99", "sess-x");
    store.setFocus("99", "ws-q");

    expect(store.getAttachment("99")).toBe("sess-x");
    expect(store.getFocus("99")).toEqual(expect.objectContaining({ workspaceId: "ws-q" }));
  });

  it("setProjectFocus / getProjectFocus persists the active hosted project", () => {
    const store = new SessionStore(filePath);
    store.setProjectFocus("42", "api", "/srv/api");

    const store2 = new SessionStore(filePath);
    expect(store2.getProjectFocus("42")).toEqual(expect.objectContaining({
      projectId: "api",
      path: "/srv/api",
    }));
  });

  it("clearProjectFocus removes only project focus", () => {
    const store = new SessionStore(filePath);
    store.attach("42", "sess-1");
    store.setFocus("42", "ws-a");
    store.setProjectFocus("42", "api", "/srv/api");

    store.clearProjectFocus("42");

    expect(store.getProjectFocus("42")).toBeNull();
    expect(store.getAttachment("42")).toBe("sess-1");
    expect(store.getFocus("42")).toEqual(expect.objectContaining({ workspaceId: "ws-a" }));
  });

  it("migrates legacy {attachments:{}} shape to the new {chats:{}} shape on load", () => {
    // Hand-crafted legacy file
    writeFileSync(
      filePath,
      JSON.stringify({
        attachments: {
          "1": { sessionId: "sess-legacy", attachedAt: Date.now() },
        },
      }),
    );

    const store = new SessionStore(filePath);
    expect(store.getAttachment("1")).toBe("sess-legacy");
    expect(store.getFocus("1")).toBeNull();
  });
});
