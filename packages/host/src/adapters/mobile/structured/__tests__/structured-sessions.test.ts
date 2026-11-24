import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentStopEvent } from "../../../../types/notifications.js";
import { NativeConversation } from "../../codex-app-server/native-conversation.js";
import type { CodexSessionOptions } from "../../codex-app-server/session.js";
import type { ProviderBridgeSession, ProviderUsage } from "../../../../types/provider-bridge.js";
import { ClaudeConversation } from "../bridges/claude/conversation.js";
import { fakeBinDir } from "../../__tests__/support/fake-bin.js";
import { BridgeRegistry } from "../bridge-registry.js";
import { StructuredSessions, codexPosture } from "../structured-sessions.js";

/** A session that never spawns anything: the test feeds its conversation by hand. */
class FakeSession {
  readonly conversation: NativeConversation;
  alive = true;
  thread: string | undefined;
  prompts: string[] = [];
  interrupted = 0;
  decisions: string[] = [];
  constructor(readonly opts: CodexSessionOptions) {
    this.conversation = new NativeConversation(opts.paneId);
  }
  async start(): Promise<void> { this.thread = "thr-1"; }
  async prompt(text: string): Promise<void> { this.prompts.push(text); }
  async interrupt(): Promise<void> { this.interrupted++; }
  decide(key: string): boolean {
    const pending = this.conversation.pendingPermission();
    if (pending === undefined) return false;
    this.decisions.push(key);
    return this.conversation.decide(pending.requestId, key) !== undefined;
  }
  close(): void { this.alive = false; }
}

function harness() {
  const sessions: FakeSession[] = [];
  const frames: AgentStopEvent[] = [];
  let fleetChanges = 0;
  const store = new StructuredSessions({
    publishNotification: (e) => frames.push(e),
    fleetChanged: () => { fleetChanges++; },
    createSession: (opts) => { const s = new FakeSession(opts); sessions.push(s); return s; },
  });
  return { store, sessions, frames, fleetChanges: () => fleetChanges };
}

const spawnReq = { workspaceId: "ws-lotus", workspaceLabel: "Lotus", cwd: "/Users/op/code/lotus" };

describe("StructuredSessions", () => {
  it("spawns a cell that looks like any other fleet member, with codex's thread as its session id", async () => {
    const { store, sessions } = harness();
    const member = await store.spawn({ ...spawnReq, initialPrompt: "run the tests\nplease" });
    expect(member).toMatchObject({ agentType: "codex", workspaceId: "ws-lotus", status: "live", isAlive: true, sessionId: "thr-1", headline: "run the tests", gating: "asks", turn: "idle", terminal: false });
    expect(member.paneId).toMatch(/^ss-[0-9a-f]{8}$/);
    expect(sessions[0]?.prompts).toEqual(["run the tests\nplease"]);
    expect(sessions[0]?.opts).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(store.list("ws-lotus")).toHaveLength(1);
    expect(store.list("ws-other")).toHaveLength(0);
  });

  /**
   * The bug: `title` fell back to the bridge's own `runnerLabel`, so every cell a phone started
   * was called after the binary. Two of them were one name — in the fleet, in the desktop's adopt
   * list ("Adopt Claude Code", twice), and in the push that said one of them needed you.
   */
  it("names a cell the client did not name, and never after its runner", async () => {
    const { store } = harness();
    const first = await store.spawn({ ...spawnReq });
    const second = await store.spawn({ ...spawnReq, cwd: "/Users/op/code/other" });

    expect(first.title).not.toBe(first.runnerLabel);
    expect(first.title).not.toBe(second.title);
    // The label is not lost by this — it answers its own question, one field up.
    expect(first.runnerLabel).toBe("Codex");
  });

  /** A client that names its cell keeps that name; the pool is a floor, not a policy. */
  it("keeps a title the client chose", async () => {
    const { store } = harness();
    const member = await store.spawn({ ...spawnReq, title: "Rowan", runnerLabel: "acme" });
    expect(member.title).toBe("Rowan");
  });

  it("yolo never asks: approvalPolicy never, gating skipped", async () => {
    const { store, sessions } = harness();
    const m = await store.spawn({ ...spawnReq, permissionMode: "yolo" });
    expect(sessions[0]?.opts.approvalPolicy).toBe("never");
    expect(m.gating).toBe("skipped");
  });

  it("publishes hook-vocabulary frames a phone in the field already renders, stamped with the part's time", async () => {
    const { store, sessions, frames } = harness();
    const m = await store.spawn(spawnReq);
    const c = sessions[0]!.conversation;
    c.apply("turn/started", { turn: { id: "t1", startedAt: 1_700 } });
    c.apply("item/completed", { turnId: "t1", completedAtMs: 1_700_001, item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] } });
    c.apply("item/started", { turnId: "t1", startedAtMs: 1_700_002, item: { type: "commandExecution", id: "e1", command: "/bin/zsh -lc ls", commandActions: [{ command: "ls" }], status: "inProgress" } });
    c.apply("item/completed", { turnId: "t1", completedAtMs: 1_700_003, item: { type: "commandExecution", id: "e1", command: "/bin/zsh -lc ls", commandActions: [{ command: "ls" }], status: "completed", aggregatedOutput: "a\n", exitCode: 0 } });
    c.apply("item/completed", { turnId: "t1", completedAtMs: 1_700_004, item: { type: "agentMessage", id: "m1", text: "thinking aloud", phase: "commentary" } });
    c.apply("item/completed", { turnId: "t1", completedAtMs: 1_700_005, item: { type: "agentMessage", id: "m2", text: "done", phase: "final_answer" } });
    c.apply("turn/completed", { turn: { id: "t1", status: "completed", completedAt: 1_700, durationMs: 5 } });

    expect(frames.map((f) => [f.event, f.title, f.tool_target || f.body])).toEqual([
      ["prompt-submit", "You", "hi"],
      ["tool-pre", "exec", "ls"],
      ["tool-post", "exec", "ls"],
      ["agent-response", "Finished working", "thinking aloud"],
      // The final answer arrived before turn/completed, so at that moment the turn was
      // still open and it was prose, not the end. The REST read below says `stop`.
      ["agent-response", "Finished working", "done"],
    ]);
    expect(frames.every((f) => f.pane_id === m.paneId && f.agent_type === "codex")).toBe(true);
    expect(frames[0]?.timestamp).toBe(1_700_001);

    // REST reads the same conversation back in the same vocabulary; the closing text is `stop`.
    const transcript = store.transcript(m.paneId)!;
    expect(transcript.entries.map((e) => e.event)).toEqual(["prompt-submit", "tool-pre", "tool-post", "agent-response", "stop"]);
    expect(transcript.entries[0]?.timestamp).toBe(1_700_001);
    expect(transcript.source).toBe("file");
  });

  it("tracks turn state for the fleet: running while a turn is open, needs-input on an approval, idle after", async () => {
    const { store, sessions, fleetChanges } = harness();
    const m = await store.spawn(spawnReq);
    const c = sessions[0]!.conversation;
    const before = fleetChanges();
    c.apply("turn/started", { turn: { id: "t1", startedAt: 1 } });
    expect(store.list()[0]?.turn).toBe("running");
    c.requestApproval("item/commandExecution/requestApproval", { turnId: "t1", itemId: "e1", command: "rm -rf build" }, "a0");
    expect(store.list()[0]?.turn).toBe("needs-input");
    const perm = store.permission(m.paneId)!;
    expect(perm.awaiting).toBe(true);
    expect(perm.prompt?.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
    expect(perm.prompt?.question).toBe("Run rm -rf build?");
    // The phone answers with the printed digit through /input.
    expect(store.input(m.paneId, "1")).toBe(true);
    expect(sessions[0]?.decisions).toEqual(["1"]);
    expect(store.list()[0]?.turn).toBe("running");
    expect(store.permission(m.paneId)?.awaiting).toBe(false);
    c.apply("turn/completed", { turn: { id: "t1", status: "completed", completedAt: 2 } });
    expect(store.list()[0]?.turn).toBe("idle");
    expect(fleetChanges()).toBeGreaterThan(before);
  });

  /**
   * Measured on devbox-vps 2026-09-05, with a real phone: the operator answered an approval
   * chip, the answer arrived as `/dispatch`, and the host said 200 while nothing happened.
   * Codex stayed blocked, the phone honestly said "needs you", and the operator answered
   * eight more times. The same digit sent to `/input` unblocked it immediately.
   *
   * The client bug is fixed in `apps/pocket`. This is the half that must not depend on a
   * client being right: a cell waiting for a decision cannot take a sentence, and saying so
   * is the difference between a refusal an operator can read and a silence they cannot.
   */
  it("refuses a prompt while a permission is pending, rather than swallowing it", async () => {
    const { store, sessions } = harness();
    const m = await store.spawn(spawnReq);
    const c = sessions[0]!.conversation;
    c.apply("turn/started", { turn: { id: "t1", startedAt: 1 } });
    c.requestApproval("item/commandExecution/requestApproval", { turnId: "t1", itemId: "e1", command: "rm -rf build" }, "a0");

    expect(await store.dispatch(m.paneId, "2")).toBe("blocked");
    expect(sessions[0]?.prompts).not.toContain("2");

    // And the answer still works through the route that means "a key press".
    expect(store.input(m.paneId, "2")).toBe(true);
    expect(await store.dispatch(m.paneId, "now do the next thing")).toBe("sent");
  });

  it("dispatch prompts, stop interrupts, close ends the process and drops the cell", async () => {
    const { store, sessions, fleetChanges } = harness();
    const m = await store.spawn(spawnReq);
    expect(await store.dispatch(m.paneId, "go")).toBe("sent");
    expect(await store.stop(m.paneId)).toBe(true);
    expect(sessions[0]?.prompts).toEqual(["go"]);
    expect(sessions[0]?.interrupted).toBe(1);
    const n = fleetChanges();
    expect(store.close(m.paneId)).toBe(true);
    expect(sessions[0]?.alive).toBe(false);
    expect(store.has(m.paneId)).toBe(false);
    expect(fleetChanges()).toBe(n + 1);
    expect(await store.dispatch(m.paneId, "x")).toBe("unknown");
  });

  it("a key that is not a pending permission's digit is refused rather than sent anywhere", async () => {
    const { store } = harness();
    const m = await store.spawn(spawnReq);
    expect(store.input(m.paneId, "1")).toBe(false);
    expect(store.input("ss-nope", "1")).toBe(false);
  });
});

/**
 * `codex app-server` has no `--permission-mode`: `thread/start` takes an approval policy and a
 * sandbox as two separate things. One word from the phone therefore has to become a pair
 * here, which is the concrete reason each runner advertises its own scale rather than sharing
 * Claude's.
 */
describe("StructuredSessions, a turn that has not finished", () => {
  /** A session whose prompt resolves only when the turn ends — ACP and Claude both do this. */
  class SlowSession extends FakeSession {
    override async prompt(text: string): Promise<void> {
      this.prompts.push(text);
      return new Promise<void>(() => undefined); // never resolves
    }
  }

  function slowHarness() {
    const sessions: SlowSession[] = [];
    const store = new StructuredSessions({
      publishNotification: () => undefined,
      fleetChanged: () => undefined,
      createSession: (o) => { const s = new SlowSession(o); sessions.push(s); return s; },
    });
    return { store, sessions };
  }

  it("answers `sent` as soon as the runner has the text, not when the turn ends", async () => {
    // Measured against a real Claude on 2026-09-07: awaiting the turn made this route hang
    // 25 s+, and forever once the turn stopped on an approval — because the answer arrives on
    // `/input`, a request the phone can only make after this one has returned.
    const { store, sessions } = slowHarness();
    const member = await store.spawn(spawnReq);
    await expect(store.dispatch(member.paneId, "go")).resolves.toBe("sent");
    expect(sessions[0]?.prompts).toEqual(["go"]);
  });

  it("returns from a spawn that carried an initial prompt", async () => {
    const { store, sessions } = slowHarness();
    const member = await store.spawn({ ...spawnReq, initialPrompt: "start here" });
    expect(member.paneId).toMatch(/^ss-/);
    expect(sessions[0]?.prompts).toEqual(["start here"]);
  });
});

describe("StructuredSessions, the plan window", () => {
  it("carries what the runner reported, and says nothing when it reports nothing", async () => {
    // Absent means *this runner does not say* — never that the plan is fine. Codex reports
    // token counts but no quota, and ACP carries no usage at all.
    const { store } = harness();
    const member = await store.spawn(spawnReq);
    expect(store.list().find((m) => m.paneId === member.paneId)).not.toHaveProperty("usage");
  });

  it("reads it per call, because a plan moves under a cell doing nothing", async () => {
    let window: ProviderUsage | undefined;
    const store = new StructuredSessions({
      publishNotification: () => undefined,
      fleetChanged: () => undefined,
      registry: new BridgeRegistry({
        createCodexSession: (o) => {
          const session = new FakeSession(o) as FakeSession & {
            usage?: () => ProviderUsage | undefined;
          };
          session.usage = () => window;
          return session;
        },
      }),
    });
    const member = await store.spawn(spawnReq);
    expect(store.list().find((m) => m.paneId === member.paneId)).not.toHaveProperty("usage");

    window = { status: "rejected", window: "five_hour" };
    expect(store.list().find((m) => m.paneId === member.paneId)?.usage).toEqual(window);
  });
});

describe("StructuredSessions, what this host can run headless", () => {
  it("answers from the registry, and takes back every name it gives", () => {
    const store = new StructuredSessions({
      publishNotification: () => undefined,
      fleetChanged: () => undefined,
      registry: new BridgeRegistry({ env: { PATH: "" } }),
    });
    expect(store.headlessRunners()).toEqual([]);
    expect(store.canRun("codex")).toBe(false);
  });

  it("refuses a runner it has no bridge for, by name", async () => {
    const { store } = harness();
    await expect(store.spawn({ ...spawnReq, agentType: "qwen" })).rejects.toThrow(/no provider bridge for "qwen"/);
  });
});

describe("codexPosture", () => {
  it("expands each advertised stop into both axes", () => {
    expect(codexPosture("read-only")).toEqual({ approvalPolicy: "on-request", sandbox: "read-only" });
    expect(codexPosture("auto")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(codexPosture("full-access")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  /**
   * The pair only ever moved the approval axis. Letting `yolo` also widen the sandbox would
   * change what a phone built before this scale spawns — silently, and in the direction that
   * cannot be undone once the process is running (ADR-8).
   */
  it("leaves the legacy pair meaning exactly what it meant", () => {
    expect(codexPosture("yolo")).toEqual({ approvalPolicy: "never", sandbox: "workspace-write" });
    expect(codexPosture("safe")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(codexPosture(undefined)).toEqual(codexPosture("safe"));
  });

  /**
   * A newer phone may know a stop this host does not. The safe reading of an unknown posture
   * is *ask* — never *run free*.
   */
  it("reads a posture it has never heard of as asking", () => {
    expect(codexPosture("dontAsk").approvalPolicy).toBe("on-request");
    expect(codexPosture("").sandbox).toBe("workspace-write");
  });
});

/**
 * Postur berhenti jadi keputusan sekali seumur sel (`plans/permission-ownership` 9b). Yang
 * memindahkannya adalah **runner**, lewat kanal kontrolnya sendiri — store ini hanya menemukan
 * sel yang benar dan menerjemahkan stop-nya ke kata yang runner itu pakai.
 */
describe("moving a running cell's posture", () => {
  const claudeStore = (session: Partial<ProviderBridgeSession>) => {
    const dir = mkdtempSync(join(tmpdir(), "lotus-posture-"));
    const registry = new BridgeRegistry({
      env: { PATH: fakeBinDir(dir, ["claude"]) },
      createClaudeSession: () =>
        ({
          conversation: new ClaudeConversation("ss-x"),
          alive: true,
          thread: "thr-1",
          start: async () => undefined,
          prompt: async () => undefined,
          interrupt: async () => undefined,
          decide: () => false,
          close: () => undefined,
          ...session,
        }) as ProviderBridgeSession,
    });
    return new StructuredSessions({
      publishNotification: () => undefined,
      fleetChanged: () => undefined,
      registry,
    });
  };

  it("asks the session, in the runner's own word for that stop", async () => {
    const asked: string[] = [];
    const sessions = claudeStore({
      setPermissionMode: async (mode: string) => {
        asked.push(mode);
      },
    });
    const member = await sessions.spawn({ ...spawnReq, agentType: "claude" });

    await expect(sessions.setPosture(member.paneId, "read-only")).resolves.toBe(true);

    // `read-only` is the phone's word; `plan` is Claude's. The factory owns that translation,
    // exactly as it does at spawn — one mapping, not two that can drift.
    expect(asked).toEqual(["plan"]);
  });

  it("says no for a pane it does not hold, rather than pretending", async () => {
    const sessions = claudeStore({});
    await expect(sessions.setPosture("no-such-pane", "manual")).resolves.toBe(false);
  });

  /** A refusal the phone can act on: the control exists, this runner just cannot honour it. */
  it("says no for a session whose bridge cannot move it", async () => {
    const sessions = claudeStore({});
    const member = await sessions.spawn({ ...spawnReq, agentType: "claude" });

    await expect(sessions.setPosture(member.paneId, "manual")).resolves.toBe(false);
  });
});

/**
 * A question reaches the phone through the **pending** surface, not only the transcript — that
 * is where the card is drawn from and where the digits have to be. What it must not lose on the
 * way is the sentence under each option: `{key,label}` had nowhere to keep them, so a headless
 * cell showed "Spaces" with nothing to say what choosing it means.
 */
describe("what /permission says about a question", () => {
  const asking = {
    questions: [
      {
        question: "Tabs or spaces?",
        options: [
          { label: "Spaces", description: "Indent with spaces." },
          { label: "Tabs", description: "Indent with tab characters." },
        ],
      },
    ],
  };

  it("carries the question whole, with every option's own words", async () => {
    const conversation = new ClaudeConversation("ss-x");
    const dir = mkdtempSync(join(tmpdir(), "lotus-question-"));
    const store = new StructuredSessions({
      publishNotification: () => undefined,
      fleetChanged: () => undefined,
      registry: new BridgeRegistry({
        env: { PATH: fakeBinDir(dir, ["claude"]) },
        createClaudeSession: () =>
          ({
            conversation,
            alive: true,
            thread: "thr-1",
            start: async () => undefined,
            prompt: async () => undefined,
            interrupt: async () => undefined,
            decide: () => false,
            close: () => undefined,
          }) as ProviderBridgeSession,
      }),
    });
    const member = await store.spawn({ ...spawnReq, agentType: "claude" });
    conversation.openTurn("pick one");
    conversation.requestPermission("perm-0", {
      toolName: "AskUserQuestion",
      toolUseId: "toolu_1",
      input: asking,
    });

    const answer = store.permission(member.paneId);

    expect(answer?.awaiting).toBe(true);
    expect(answer?.question?.[0]?.options).toEqual([
      { key: "1", label: "Spaces", description: "Indent with spaces." },
      { key: "2", label: "Tabs", description: "Indent with tab characters." },
    ]);
    // And the old shape rides along, so a phone built before this still draws buttons.
    expect(answer?.prompt?.options.map((o) => o.key)).toEqual(["1", "2"]);
    expect(answer?.prompt?.ask).toBe("question");
  });
});
