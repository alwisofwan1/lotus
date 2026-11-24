import { describe, expect, it } from "vitest";
import {
  formatVoiceDuration,
  initialLiveVoiceStrip,
  liveVoiceStatusText,
  liveVoiceSummary,
  reduceLiveVoiceStrip,
  toolLineLabel,
  type LiveVoiceStripEvent,
  type LiveVoiceStripState,
} from "../live-voice-strip";

function run(events: LiveVoiceStripEvent[], state: LiveVoiceStripState = initialLiveVoiceStrip()): LiveVoiceStripState {
  return events.reduce(reduceLiveVoiceStrip, state);
}

/** What the strip shows, one string per line, turns in order. */
function lines(state: LiveVoiceStripState): string[] {
  return state.turns.flatMap((turn) => turn.lines.map((line) => `${line.kind}: ${line.text}`));
}

const user = (turn: number, text: string, more: Partial<Extract<LiveVoiceStripEvent, { type: "transcript" }>> = {}): LiveVoiceStripEvent => ({
  type: "transcript",
  speaker: "user",
  turn,
  text,
  isFinal: true,
  ...more,
});
const agent = (turn: number, text: string, more: Partial<Extract<LiveVoiceStripEvent, { type: "transcript" }>> = {}): LiveVoiceStripEvent => ({
  type: "transcript",
  speaker: "agent",
  turn,
  text,
  isFinal: true,
  ...more,
});

describe("Live Voice strip", () => {
  it("shows what each side said, the user first in a turn even when their words land late", () => {
    const state = run([
      agent(1, "Opening a reviewer.", { itemId: "a1" }),
      user(1, "Spawn a reviewer", { itemId: "u1" }),
    ]);
    expect(lines(state)).toEqual(["you: Spawn a reviewer", "lotus: Opening a reviewer."]);
  });

  it("builds a line from its deltas, and the final text replaces them", () => {
    const state = run([
      agent(1, "Open", { itemId: "a1", isFinal: false }),
      agent(1, "ing…", { itemId: "a1", isFinal: false }),
    ]);
    expect(lines(state)).toEqual(["lotus: Opening…"]);
    expect(lines(reduceLiveVoiceStrip(state, agent(1, "Opening it now.", { itemId: "a1" })))).toEqual(["lotus: Opening it now."]);
  });

  it("lets a cumulative update replace what was heard so far", () => {
    const state = run([
      user(1, "spawn a", { itemId: "u1", isFinal: false, cumulative: true }),
      user(1, "spawn a reviewer", { itemId: "u1", isFinal: false, cumulative: true }),
    ]);
    expect(lines(state)).toEqual(["you: spawn a reviewer"]);
  });

  it("puts one line per tool call in the turn it ran in, after what was said", () => {
    const state = run([
      user(1, "Spawn a reviewer and focus it"),
      { type: "tool", turn: 1, name: "spawn_agent", args: { name: "Reviewer" }, ok: true },
      { type: "tool", turn: 1, name: "focus", args: { target: "Reviewer" }, ok: true },
      agent(1, "Done."),
    ]);
    expect(lines(state)).toEqual([
      "you: Spawn a reviewer and focus it",
      "tool: spawn_agent · Reviewer",
      "tool: focus · Reviewer",
      "lotus: Done.",
    ]);
    expect(state.actions).toBe(2);
  });

  it("keeps the last three turns and drops older ones, but still counts their actions", () => {
    const state = run([
      user(1, "one"),
      { type: "tool", turn: 1, name: "focus", args: { target: "Nova" }, ok: true },
      user(2, "two"),
      user(3, "three"),
      user(4, "four"),
    ]);
    expect(lines(state)).toEqual(["you: two", "you: three", "you: four"]);
    expect(state.actions).toBe(1);
  });

  it("ignores empty text", () => {
    expect(lines(run([user(1, "   ")]))).toEqual([]);
  });

  it("a final that lands after the next turn began completes its own line, not a new one", () => {
    const state = run([
      user(1, "spawn a rev", { itemId: "u1", isFinal: false }),
      user(2, "and focus it", { itemId: "u2" }),
      user(2, "spawn a reviewer", { itemId: "u1" }),
    ]);
    expect(lines(state)).toEqual(["you: spawn a reviewer", "you: and focus it"]);
  });

  it("empties on reset, for the next session", () => {
    const state = run([user(1, "one"), { type: "tool", turn: 1, name: "focus", args: {}, ok: true }, { type: "reset" }]);
    expect(state).toEqual(initialLiveVoiceStrip());
  });

  it("marks a failed tool line", () => {
    const state = run([{ type: "tool", turn: 1, name: "close", args: { target: "Rowan" }, ok: false }]);
    expect(state.turns[0].lines[0]).toMatchObject({ kind: "tool", ok: false });
  });
});

describe("toolLineLabel", () => {
  it("names the tool and what it acted on", () => {
    expect(toolLineLabel("dispatch", { target: "Rowan", task: "check auth" })).toBe("dispatch · Rowan");
    expect(toolLineLabel("create_node", { kind: "note" })).toBe("create_node · note");
    expect(toolLineLabel("arrange", {})).toBe("arrange");
  });
});

describe("summary and status", () => {
  it("formats the session length as m:ss", () => {
    expect(formatVoiceDuration(0)).toBe("0:00");
    expect(formatVoiceDuration(65_400)).toBe("1:05");
  });

  it("summarises a session in one line", () => {
    expect(liveVoiceSummary(2, 65_000)).toBe("Live Voice · 2 actions · 1:05");
    expect(liveVoiceSummary(1, 4_000)).toBe("Live Voice · 1 action · 0:04");
  });

  it("says what Live Voice is doing", () => {
    expect(liveVoiceStatusText({ phase: "connecting", agentSpeaking: false })).toBe("Connecting…");
    expect(liveVoiceStatusText({ phase: "reconnecting", agentSpeaking: false })).toBe("Connection dropped — reconnecting…");
    expect(liveVoiceStatusText({ phase: "listening", agentSpeaking: false })).toBe("Listening…");
    expect(liveVoiceStatusText({ phase: "user", agentSpeaking: false })).toBe("Listening…");
    expect(liveVoiceStatusText({ phase: "agent", agentSpeaking: true })).toBe("Lotus is speaking — talk to interrupt");
    expect(liveVoiceStatusText({ phase: "thinking", agentSpeaking: false, activity: "Running requested action…" })).toBe(
      "Running requested action…",
    );
    expect(liveVoiceStatusText({ phase: "error", agentSpeaking: false, error: "Bad key" })).toBe("Bad key");
    expect(liveVoiceStatusText({ phase: "error", agentSpeaking: false })).toBe("Live Voice stopped working.");
  });
});
