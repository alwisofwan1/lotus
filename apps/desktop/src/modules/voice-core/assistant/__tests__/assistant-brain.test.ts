import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEventEnvelope } from "@/modules/chat/domain/thread-event";
import type { ApprovalDecision } from "@/modules/chat/runtime/chat-runtime-client";
import { ASSISTANT_THREAD_TITLE, brainConfigKey, createAssistantBrain, type AssistantChatClient, type AssistantThreadStore } from "../assistant-brain";
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from "../assistant-settings";

type Event = ThreadEventEnvelope["event"];

function harness(initial: Partial<AssistantSettings> = {}) {
  let settings: AssistantSettings = { ...DEFAULT_ASSISTANT_SETTINGS, brain: "claude", ...initial };
  const listeners = new Map<string, (envelope: ThreadEventEnvelope) => void>();
  const stored = new Map<string, { threadId: string; config: string }>();
  let seq = 0;
  let nextId = 0;
  const sent: { threadId: string; text: string }[] = [];
  const resolved: { threadId: string; interactionId: string; decision: ApprovalDecision }[] = [];
  const created: unknown[] = [];
  const missing = new Set<string>();

  const client: AssistantChatClient = {
    createThread: vi.fn(async (input) => {
      created.push(input);
      return { id: `t${++nextId}` };
    }),
    lockPermissions: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    warm: vi.fn(async () => {}),
    send: vi.fn(async (threadId, text) => {
      if (missing.has(threadId)) throw new Error("thread not found");
      sent.push({ threadId, text });
    }),
    subscribe: vi.fn(async (threadId, onEvent, onReplayed) => {
      listeners.set(threadId, onEvent);
      queueMicrotask(onReplayed);
      return () => listeners.delete(threadId);
    }),
    resolve: vi.fn(async (threadId, interactionId, decision) => {
      resolved.push({ threadId, interactionId, decision });
    }),
  };
  const store: AssistantThreadStore = { get: (cwd) => stored.get(cwd) ?? null, set: (cwd, v) => (v ? stored.set(cwd, v) : stored.delete(cwd)) };
  const brain = createAssistantBrain({ client, store, settings: () => settings, waitMs: 1_000 });
  const emit = (threadId: string, event: Event) => listeners.get(threadId)?.({ threadId, seq: ++seq, at: 0, event });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    brain,
    client,
    stored,
    sent,
    resolved,
    created,
    missing,
    emit,
    flush,
    setSettings: (patch: Partial<AssistantSettings>) => (settings = { ...settings, ...patch }),
    reply: (threadId: string, text: string) => {
      emit(threadId, { type: "item/completed", turnId: "u1", item: { id: "m1", kind: "agentMessage", text } } as Event);
      emit(threadId, { type: "turn/answered", turnId: "u1" });
    },
    permission: (threadId: string, id: string, toolName: string, input: unknown) =>
      emit(threadId, { type: "interaction/requested", turnId: "u1", interaction: { id, kind: "toolPermission", itemId: null, toolName, input, blockedPath: null } }),
  };
}

describe("assistant brain", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("creates one titled thread per folder, sends the role once, and returns the reply", async () => {
    const h = harness();
    const first = h.brain.ask("/repo", "what changed today?");
    await h.flush();
    expect(h.created).toEqual([{ cwd: "/repo", runner: "claude", model: null, effort: "low", permissionMode: "default" }]);
    expect(h.client.lockPermissions).toHaveBeenCalledWith("t1");
    expect(h.client.rename).toHaveBeenCalledWith("t1", ASSISTANT_THREAD_TITLE);
    expect(h.sent[0].text).toMatch(/^You are the Lotus Assistant[\s\S]*Request: what changed today\?$/);
    h.reply("t1", "Two commits about voice.");
    await expect(first).resolves.toEqual({ kind: "answer", text: "Two commits about voice." });

    const second = h.brain.ask("/repo", "and yesterday?");
    await h.flush();
    expect(h.client.createThread).toHaveBeenCalledTimes(1);
    expect(h.sent[1]).toEqual({ threadId: "t1", text: "and yesterday?" });
    h.reply("t1", "Nothing.");
    await expect(second).resolves.toEqual({ kind: "answer", text: "Nothing." });
  });

  it("ignores replayed history", async () => {
    const h = harness();
    h.stored.set("/repo", { threadId: "old", config: brainConfigKey({ ...DEFAULT_ASSISTANT_SETTINGS, brain: "claude" }) });
    h.client.subscribe = vi.fn(async (threadId, onEvent, onReplayed) => {
      onEvent({ threadId, seq: 1, at: 0, event: { type: "turn/answered", turnId: "old" } });
      queueMicrotask(onReplayed);
      return () => {};
    });
    const brain = createAssistantBrain({ client: h.client, store: { get: (c) => h.stored.get(c) ?? null, set: () => {} }, settings: () => ({ ...DEFAULT_ASSISTANT_SETTINGS, brain: "claude" }), waitMs: 50 });
    await expect(brain.ask("/repo", "hi")).resolves.toEqual({ kind: "pending" });
  });

  it("allows safe actions by itself and asks before risky ones", async () => {
    const h = harness();
    const asking = h.brain.ask("/repo", "push it");
    await h.flush();
    h.permission("t1", "i1", "Bash", { command: "git status" });
    await h.flush();
    expect(h.resolved).toEqual([{ threadId: "t1", interactionId: "i1", decision: { behavior: "allow" } }]);

    h.permission("t1", "i2", "Bash", { command: "git push origin main" });
    await expect(asking).resolves.toEqual({ kind: "approval", action: "push to origin main" });
    expect(h.brain.awaitingApproval()).toBe(true);

    const decided = h.brain.decide(true);
    await h.flush();
    expect(h.resolved[1]).toEqual({ threadId: "t1", interactionId: "i2", decision: { behavior: "allow" } });
    h.reply("t1", "Pushed.");
    await expect(decided).resolves.toEqual({ kind: "answer", text: "Pushed." });
  });

  it("denies the open question when the user moves on, and on a no", async () => {
    const h = harness();
    const asking = h.brain.ask("/repo", "send it");
    await h.flush();
    h.permission("t1", "i1", "mcp__lotus__lotus_chat_tell", { text: "x" });
    await asking;
    const next = h.brain.ask("/repo", "never mind, what time is it");
    await h.flush();
    expect(h.resolved[0].decision).toEqual({ behavior: "deny", message: "The user moved on without saying yes." });
    h.reply("t1", "Noon.");
    await next;

    const again = h.brain.ask("/repo", "delete it");
    await h.flush();
    h.permission("t1", "i2", "Bash", { command: "rm a" });
    await again;
    const no = h.brain.decide(false);
    await h.flush();
    expect(h.resolved[1].decision).toEqual({ behavior: "deny", message: "The user said no." });
    h.reply("t1", "Okay, left it.");
    await expect(no).resolves.toEqual({ kind: "answer", text: "Okay, left it." });
  });

  it("runs everything when asking is switched off", async () => {
    const h = harness({ confirm: "off" });
    void h.brain.ask("/repo", "push");
    await h.flush();
    h.permission("t1", "i1", "Bash", { command: "git push" });
    await h.flush();
    expect(h.resolved[0].decision).toEqual({ behavior: "allow" });
  });

  it("refuses option pickers so the brain asks in words", async () => {
    const h = harness();
    void h.brain.ask("/repo", "plan it");
    await h.flush();
    h.emit("t1", { type: "interaction/requested", turnId: "u1", interaction: { id: "q1", kind: "question", itemId: null, questions: [] } });
    await h.flush();
    expect(h.resolved[0].decision.behavior).toBe("deny");
  });

  it("says still working after the wait", async () => {
    vi.useFakeTimers();
    const h = harness();
    const asking = h.brain.ask("/repo", "build the feature");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(asking).resolves.toEqual({ kind: "pending" });
  });

  it("replaces a stored thread that is gone, and a thread from other settings", async () => {
    const h = harness();
    h.stored.set("/repo", { threadId: "gone", config: brainConfigKey({ ...DEFAULT_ASSISTANT_SETTINGS, brain: "claude" }) });
    h.missing.add("gone");
    const asking = h.brain.ask("/repo", "hello");
    await h.flush();
    await h.flush();
    expect(h.stored.get("/repo")?.threadId).toBe("t1");
    h.reply("t1", "Hi.");
    await expect(asking).resolves.toEqual({ kind: "answer", text: "Hi." });

    h.setSettings({ effort: "high" });
    void h.brain.ask("/repo", "hello again");
    await h.flush();
    expect(h.created.at(-1)).toMatchObject({ runner: "claude", effort: "high" });
  });

  it("warms the folder's existing thread before the first ask, and the ask reuses it", async () => {
    const h = harness();
    h.stored.set("/repo", { threadId: "old", config: brainConfigKey({ ...DEFAULT_ASSISTANT_SETTINGS, brain: "claude" }) });
    const ready = h.brain.prepare("/repo");
    const asking = h.brain.ask("/repo", "status?");
    await ready;
    await h.flush();
    expect(h.client.createThread).not.toHaveBeenCalled();
    expect(h.client.warm).toHaveBeenCalledWith("old");
    expect(h.sent[0]).toEqual({ threadId: "old", text: "status?" });
    h.reply("old", "Clean.");
    await expect(asking).resolves.toEqual({ kind: "answer", text: "Clean." });
  });

  it("creates nothing when the folder has no thread yet", async () => {
    const h = harness();
    await h.brain.prepare("/repo");
    expect(h.client.createThread).not.toHaveBeenCalled();
    expect(h.client.warm).not.toHaveBeenCalled();
    expect(h.stored.size).toBe(0);
  });

  it("asks normally when the warm-up fails", async () => {
    const h = harness();
    h.stored.set("/repo", { threadId: "t1", config: brainConfigKey({ ...DEFAULT_ASSISTANT_SETTINGS, brain: "claude" }) });
    h.client.warm = vi.fn(async () => Promise.reject(new Error("spawn failed")));
    await h.brain.prepare("/repo");
    const asking = h.brain.ask("/repo", "hi");
    await h.flush();
    h.reply("t1", "Hello.");
    await expect(asking).resolves.toEqual({ kind: "answer", text: "Hello." });
  });

  it("never uses a thread it could not lock", async () => {
    const h = harness();
    h.client.lockPermissions = vi.fn(async () => Promise.reject(new Error("lock failed")));
    await expect(h.brain.ask("/repo", "push")).resolves.toEqual({ kind: "error", message: "lock failed" });
    expect(h.sent).toEqual([]);
    expect(h.stored.size).toBe(0);
  });

  it("starts fresh on a new topic, reports failures, and stays off when off", async () => {
    const h = harness();
    void h.brain.ask("/repo", "one");
    await h.flush();
    void h.brain.ask("/repo", "two", { newTopic: true });
    await h.flush();
    expect(h.client.createThread).toHaveBeenCalledTimes(2);

    const failing = h.brain.ask("/repo", "three");
    await h.flush();
    h.emit("t2", { type: "turn/completed", turnId: "u", status: "failed", error: "rate limited", usage: null });
    await expect(failing).resolves.toEqual({ kind: "error", message: "rate limited" });

    h.setSettings({ brain: "off" });
    await expect(h.brain.ask("/repo", "four")).resolves.toMatchObject({ kind: "error" });
    await expect(h.brain.decide(true)).resolves.toMatchObject({ kind: "error" });
  });
});
