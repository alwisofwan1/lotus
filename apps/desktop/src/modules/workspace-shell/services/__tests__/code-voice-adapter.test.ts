import { describe, expect, it } from "vitest";
import { describeVoiceAdapterContract } from "@/modules/voice-core/testing/voice-adapter-contract";
import {
  CODE_VOICE_REVIEW_REASON,
  codeVoiceFocusMovedReason,
  createCodeVoiceAdapter,
  type CodeVoicePane,
  type CodeVoiceSendOutcome,
} from "../code-voice-adapter";
import type { ComposerRoute } from "../composer-routing";
import { createCodeLiveVoiceTools } from "../code-live-voice-tools";

interface Setup {
  /** The route for p1, the pane focused unless `focusedId` says otherwise. */
  route?: ComposerRoute;
  focusedId?: string | null;
  /** The composer already holds a message. */
  composerHasText?: boolean;
  sendRightAway?: boolean;
  outcome?: CodeVoiceSendOutcome;
  panes?: CodeVoicePane[];
}

const TERMINAL: ComposerRoute = { kind: "terminal", paneId: "p1", runtimeSessionId: "pty-1" };
const THREAD: ComposerRoute = { kind: "thread", paneId: "p2", sessionId: "chat-1" };
const RANI = { id: "p1", name: "Rani" };

function makeCode(initial: Setup = {}) {
  const setup = { ...initial };
  const composer: string[] = [];
  const prompted: Array<{ text: string; route: ComposerRoute; target: string }> = [];
  const keptFor: Array<string | undefined> = [];
  const sent: Array<{ text: string; route: ComposerRoute }> = [];
  const panes = setup.panes ?? [
    { id: "p1", name: "Rani", kind: "terminal", activity: "working" },
    { id: "p2", name: "Release notes", kind: "thread", activity: "idle" },
  ];
  const focus = { id: setup.focusedId === undefined ? "p1" : setup.focusedId };
  const routes: Record<string, ComposerRoute> = { p1: setup.route ?? TERMINAL, p2: THREAD };
  const blockP1 = () => {
    routes.p1 = { kind: "blocked", reason: "This terminal has no live session yet." };
  };
  const adapter = createCodeVoiceAdapter({
    focused: () => {
      const pane = panes.find((p) => p.id === focus.id);
      return pane ? { id: pane.id, name: pane.name } : null;
    },
    routeFor: (paneId) =>
      (paneId ? routes[paneId] : undefined) ?? { kind: "blocked", reason: "Pick a pane first — there is nowhere to send this." },
    getPanes: () => panes,
    composerHasText: () => setup.composerHasText ?? false,
    sendRightAway: () => setup.sendRightAway ?? false,
    holdInComposer: (text, _spoken, target) => {
      composer.push(text);
      keptFor.push(target?.id);
    },
    send: async (text, route) => {
      sent.push({ text, route });
      return setup.outcome ?? { ok: true };
    },
    prompt: async (text, route, target) => {
      prompted.push({ text, route, target: target.id });
      return setup.outcome ?? { ok: true };
    },
    // Code has Live Voice: the contract checks its tools too.
    liveTools: createCodeLiveVoiceTools({
      getPanes: () => panes,
      focusedId: () => focus.id,
      focus: () => {},
      send: async () => ({ ok: true }),
      launchable: () => ["Claude Code"],
      spawn: () => null,
    }),
  });
  const moveFocus = (id: string | null) => {
    focus.id = id;
  };
  return { adapter, composer, keptFor, sent, prompted, panes, moveFocus, blockP1, setup };
}

const paneOf = (route: ComposerRoute) => (route.kind === "blocked" ? "" : route.paneId);

describeVoiceAdapterContract("Code", () => {
  const code = makeCode();
  return {
    adapter: code.adapter,
    targetNames: code.panes.map((p) => p.name),
    sendable: { text: "run the tests", intent: { source: "typed" } },
    holdable: { text: "run the tests", intent: { source: "voice", target: null } },
    effects: () => code.composer.length + code.sent.length + code.prompted.length,
    lockedTarget: {
      target: RANI,
      text: "run the tests",
      moveFocus: () => code.moveFocus("p2"),
      deliveredTo: () => code.sent.map((s) => paneOf(s.route)),
    },
    heldPrompt: {
      target: RANI,
      text: "run the tests",
      prompted: () => code.prompted.map((p) => paneOf(p.route)),
      sent: () => code.sent.map((s) => paneOf(s.route)),
      typeInComposer: () => {
        code.setup.composerHasText = true;
      },
      cannotTakeUnsent: code.blockP1,
      setSendRightAway: (on) => {
        code.setup.sendRightAway = on;
      },
    },
  };
});

describe("Code Voice Adapter", () => {
  it("puts a spoken turn, unsent, in the focused terminal agent's prompt", async () => {
    const code = makeCode();
    const result = await code.adapter.deliver("fix the failing test", { source: "voice", target: RANI });
    expect(result).toEqual({ status: "prompted", route: "terminal", text: "fix the failing test", target: RANI });
    expect(code.prompted).toEqual([{ text: "fix the failing test", route: TERMINAL, target: "p1" }]);
    expect(code.composer).toEqual([]);
    expect(code.sent).toEqual([]);
  });

  it("adds a spoken turn to a message already in the composer, for review", async () => {
    const code = makeCode({ composerHasText: true });
    const result = await code.adapter.deliver("and the lint", { source: "voice", target: RANI });
    expect(result).toEqual({ status: "held", route: "composer", text: "and the lint", reason: CODE_VOICE_REVIEW_REASON });
    expect(code.composer).toEqual(["and the lint"]);
    expect(code.prompted).toEqual([]);
  });

  it("puts a spoken turn, unsent, in the focused thread's own input", async () => {
    const code = makeCode({ focusedId: "p2" });
    const notes = { id: "p2", name: "Release notes" };
    const result = await code.adapter.deliver("summarise this", { source: "voice", target: notes });
    expect(result).toEqual({ status: "prompted", route: "thread", text: "summarise this", target: notes });
    expect(code.prompted).toEqual([{ text: "summarise this", route: THREAD, target: "p2" }]);
    expect(code.composer).toEqual([]);
  });

  it("keeps a spoken turn in the composer, with the reason, when a thread cannot take unsent text", async () => {
    const code = makeCode({ focusedId: "p2", outcome: { ok: false, reason: CODE_VOICE_REVIEW_REASON } });
    const result = await code.adapter.deliver("summarise this", { source: "voice", target: { id: "p2", name: "Release notes" } });
    expect(result).toEqual({ status: "held", route: "composer", text: "summarise this", reason: CODE_VOICE_REVIEW_REASON });
    expect(code.composer).toEqual(["summarise this"]);
  });

  it("keeps the text in the composer when the terminal refuses unsent text", async () => {
    const code = makeCode({ outcome: { ok: false, reason: "That terminal is gone." } });
    const result = await code.adapter.deliver("hello", { source: "voice", target: RANI });
    expect(result).toMatchObject({ status: "held", route: "composer", reason: "That terminal is gone." });
    expect(code.composer).toEqual(["hello"]);
  });

  it("sends a spoken turn to the focused terminal when send right away is on", async () => {
    const code = makeCode({ sendRightAway: true });
    const result = await code.adapter.deliver("  fix the failing test ", { source: "voice" });
    expect(result).toEqual({ status: "sent", route: "terminal", text: "fix the failing test" });
    expect(code.sent).toEqual([{ text: "fix the failing test", route: TERMINAL }]);
    expect(code.composer).toEqual([]);
  });

  it("sends to the focused thread the same way", async () => {
    const code = makeCode({ focusedId: "p2", sendRightAway: true });
    const result = await code.adapter.deliver("summarise this", { source: "voice" });
    expect(result).toMatchObject({ status: "sent", route: "thread" });
    expect(code.sent).toEqual([{ text: "summarise this", route: THREAD }]);
  });

  it("keeps a spoken turn for the pane it was spoken to when focus moved, even with send right away on", async () => {
    const code = makeCode({ sendRightAway: true });
    code.moveFocus("p2");
    const result = await code.adapter.deliver("fix the failing test", { source: "voice", target: RANI });
    expect(result).toEqual({
      status: "held",
      route: "composer",
      text: "fix the failing test",
      reason: "Spoken for Rani — you moved to Release notes. Kept here; Enter sends to Rani.",
    });
    expect(code.composer).toEqual(["fix the failing test"]);
    expect(code.keptFor).toEqual(["p1"]);
    expect(code.sent).toEqual([]);
  });

  it("sends a turn ended with ⌘Enter right away, with send right away off", async () => {
    const code = makeCode();
    const result = await code.adapter.deliver("fix the failing test", { source: "voice", target: RANI, sendNow: true });
    expect(result).toEqual({ status: "sent", route: "terminal", text: "fix the failing test" });
    expect(code.sent).toEqual([{ text: "fix the failing test", route: TERMINAL }]);
  });

  it("sends text kept for a pane to that pane on Enter, wherever focus is now", async () => {
    const code = makeCode();
    code.moveFocus("p2");
    const result = await code.adapter.deliver("fix the failing test", { source: "typed", target: RANI });
    expect(result).toEqual({ status: "sent", route: "terminal", text: "fix the failing test" });
    expect(code.sent).toEqual([{ text: "fix the failing test", route: TERMINAL }]);
  });

  it("adds a turn spoken for another pane to the message already in the composer, and says where it goes", async () => {
    const code = makeCode({ composerHasText: true });
    code.moveFocus("p2");
    const result = await code.adapter.deliver("and the lint", { source: "voice", target: RANI });
    expect(result).toEqual({
      status: "held",
      route: "composer",
      text: "and the lint",
      reason: "Spoken for Rani — added to your message; Enter sends it to Release notes.",
    });
    expect(code.keptFor).toEqual([undefined]);
  });

  it("says so when focus left every pane during the turn", () => {
    expect(codeVoiceFocusMovedReason("Rani", null)).toBe("Spoken for Rani — no pane has focus now. Kept here; Enter sends to Rani.");
  });

  it("keeps the text in the composer with the reason when the pane cannot take it", async () => {
    const code = makeCode({ route: { kind: "blocked", reason: "This terminal has no live session yet." }, sendRightAway: true });
    const result = await code.adapter.deliver("hello", { source: "voice" });
    expect(result).toEqual({ status: "held", route: "composer", text: "hello", reason: "This terminal has no live session yet." });
    expect(code.composer).toEqual(["hello"]);
    expect(code.sent).toEqual([]);
  });

  it("keeps the text when the pane refuses it at send time", async () => {
    const code = makeCode({ sendRightAway: true, outcome: { ok: false, reason: "That conversation is not ready to receive messages." } });
    const result = await code.adapter.deliver("hello", { source: "voice" });
    expect(result).toMatchObject({ status: "held", reason: "That conversation is not ready to receive messages." });
    expect(code.composer).toEqual(["hello"]);
  });

  it("names every pane as a target and marks the working ones busy", () => {
    const code = makeCode();
    expect(code.adapter.targets()).toEqual([
      { id: "p1", name: "Rani", kind: "terminal", busy: true },
      { id: "p2", name: "Release notes", kind: "thread", busy: false },
    ]);
  });

  it("offers Live Voice with the pane tools and no close", () => {
    const names = makeCode().adapter.liveTools?.tools.map((tool) => tool.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["focus", "say_to_agent", "dispatch", "spawn_agent", "agent_status"]));
    expect(names.some((name) => name.startsWith("close"))).toBe(false);
  });
});
