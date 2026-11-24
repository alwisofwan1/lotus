import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeStore } from "../bridge-store.js";

describe("BridgeStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-bridge-store-test-"));
    filePath = join(dir, "bridge.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("set + get round-trips a {provider, sessionId} state", () => {
    const store = new BridgeStore(filePath);
    store.set("100", { provider: "claude", sessionId: "claude-sess-1" });
    expect(store.get("100")).toEqual({ provider: "claude", sessionId: "claude-sess-1" });
  });

  it("supports codex provider with null sessionId (single-turn)", () => {
    const store = new BridgeStore(filePath);
    store.set("100", { provider: "codex", sessionId: null });
    expect(store.get("100")).toEqual({ provider: "codex", sessionId: null });
  });

  it("returns null for unknown deviceId", () => {
    const store = new BridgeStore(filePath);
    expect(store.get("999")).toBeNull();
  });

  it("clear removes the entry", () => {
    const store = new BridgeStore(filePath);
    store.set("100", { provider: "claude", sessionId: "x" });
    store.clear("100");
    expect(store.get("100")).toBeNull();
  });

  it("setProvider invalidates session id when switching providers", () => {
    const store = new BridgeStore(filePath);
    store.set("100", { provider: "claude", sessionId: "claude-sess-1" });
    store.setProvider("100", "codex");
    expect(store.get("100")).toEqual({ provider: "codex", sessionId: null });
  });

  it("setProvider keeps session id when re-selecting the same provider", () => {
    const store = new BridgeStore(filePath);
    store.set("100", { provider: "claude", sessionId: "claude-sess-1" });
    store.setProvider("100", "claude");
    expect(store.get("100")).toEqual({
      provider: "claude",
      sessionId: "claude-sess-1",
    });
  });

  it("setProvider on no existing entry creates a fresh state", () => {
    const store = new BridgeStore(filePath);
    store.setProvider("100", "codex");
    expect(store.get("100")).toEqual({ provider: "codex", sessionId: null });
  });

  it("setClaudeModel records the alias while keeping provider + session id", () => {
    const store = new BridgeStore(filePath);
    store.set("100", { provider: "claude", sessionId: "sess-1" });
    store.setClaudeModel("100", "haiku");
    expect(store.get("100")).toMatchObject({ provider: "claude", sessionId: "sess-1", claudeModel: "haiku" });
  });

  it("setCodexModel records the slug while keeping provider + session", () => {
    const store = new BridgeStore(filePath);
    store.set("100", { provider: "codex", sessionId: "s1" });
    store.setCodexModel("100", "gpt-5.4");
    expect(store.get("100")).toMatchObject({ provider: "codex", sessionId: "s1", codexModel: "gpt-5.4" });
  });

  it("keeps each provider's model selection independent across a provider switch", () => {
    const store = new BridgeStore(filePath);
    store.set("100", { provider: "codex", sessionId: "s1", codexModel: "gpt-5.4" });
    store.setClaudeModel("100", "opus");
    store.setProvider("100", "claude");
    expect(store.get("100")).toMatchObject({ provider: "claude", codexModel: "gpt-5.4", claudeModel: "opus" });
  });

  it("omits model fields from get when never set (exact shape unchanged)", () => {
    const store = new BridgeStore(filePath);
    store.set("100", { provider: "codex", sessionId: null });
    expect(store.get("100")).toEqual({ provider: "codex", sessionId: null });
  });

  it("persists across instances", () => {
    const a = new BridgeStore(filePath);
    a.set("42", { provider: "claude", sessionId: "persisted" });
    const b = new BridgeStore(filePath);
    expect(b.get("42")).toEqual({ provider: "claude", sessionId: "persisted" });
  });

  it("prunes entries older than TTL on load + access", () => {
    const ttlMs = 1000;
    const store1 = new BridgeStore(filePath, ttlMs);
    store1.set("7", { provider: "claude", sessionId: "stale" });

    const data = JSON.parse(readFileSync(filePath, "utf8")) as {
      chats: Record<string, { lastUsedAt: number }>;
    };
    data.chats["7"]!.lastUsedAt = Date.now() - ttlMs - 1;
    writeFileSync(filePath, JSON.stringify(data));

    const store2 = new BridgeStore(filePath, ttlMs);
    expect(store2.get("7")).toBeNull();
  });

  it("handles missing file gracefully", () => {
    const store = new BridgeStore(join(dir, "nonexistent.json"));
    expect(store.get("1")).toBeNull();
  });
});
