/**
 * The Live Voice strip — pure core (plans/composer-voice-ux ticket 09, "Strip").
 *
 * While Live Voice runs, a strip attached above the composer shows the last three turns: what the
 * user said, what Lotus said, and one line per tool Lotus called in that turn. It never scrolls, so
 * older turns drop. The action count covers the whole session: it feeds the summary line after End.
 *
 * A turn is the session reducer's `turn` (S2sSession), stamped on each event when it arrives. The
 * user's own words often land after Lotus has started answering (input transcription is slower than
 * the reply), so a turn draws the user's line first whatever order its lines arrived in.
 */

import { CONFIRM_ACTION_TOOL_NAME, WORK_ON_TOOL_NAME } from "./assistant/assistant-tools";
import type { S2sPhase } from "./s2s-session";

export type LiveVoiceStripLine =
  | { key: string; kind: "you" | "lotus"; text: string; final: boolean }
  | { key: string; kind: "tool"; text: string; ok: boolean };

export interface LiveVoiceStripTurn {
  turn: number;
  lines: LiveVoiceStripLine[];
}

export interface LiveVoiceStripState {
  turns: LiveVoiceStripTurn[];
  /** Tool calls this session, dropped turns included. */
  actions: number;
  /** Source of keys for lines whose provider named no item. */
  seq: number;
}

export type LiveVoiceStripEvent =
  | {
      type: "transcript";
      speaker: "user" | "agent";
      turn: number;
      text: string;
      isFinal: boolean;
      itemId?: string;
      /** The text is everything heard for the item so far and replaces it (xAI `…updated`). */
      cumulative?: boolean;
    }
  | { type: "tool"; turn: number; name: string; args: Record<string, unknown>; ok: boolean; summary?: string }
  /** A new session starts with an empty strip. */
  | { type: "reset" };

export const LIVE_VOICE_STRIP_TURNS = 3;

export function initialLiveVoiceStrip(): LiveVoiceStripState {
  return { turns: [], actions: 0, seq: 0 };
}

/** The argument that says what a tool acted on, in the order the canvas tools name it. */
const TOOL_SUBJECT_KEYS = ["target", "name", "agent", "kind", "node", "project", "query"] as const;

/** "spawn_agent · Reviewer": the tool, then what it acted on when its arguments say. */
export function toolLineLabel(name: string, args: Record<string, unknown>, summary?: string): string {
  // The assistant's tools read as what happened, never as a tool name.
  if (name === WORK_ON_TOOL_NAME) return typeof args.request === "string" && args.request.trim() ? `Task · ${args.request.trim()}` : "Task";
  if (name === CONFIRM_ACTION_TOOL_NAME) return args.approve === true ? "You said yes" : "You said no";
  // A tool's own summary ("Sent to Kai") reads better than its name; its first line only, since
  // some carry an output dump after it.
  const said = summary?.split("\n")[0].trim().replace(/:$/, "");
  if (said) return said.length > 80 ? `${said.slice(0, 79).trimEnd()}…` : said;
  for (const key of TOOL_SUBJECT_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return `${name} · ${value.trim()}`;
  }
  return name;
}

function withTurn(state: LiveVoiceStripState, turn: number, edit: (lines: LiveVoiceStripLine[]) => LiveVoiceStripLine[]): LiveVoiceStripTurn[] {
  const existing = state.turns.find((entry) => entry.turn === turn);
  const turns = existing
    ? state.turns.map((entry) => (entry === existing ? { turn, lines: edit(entry.lines) } : entry))
    : [...state.turns, { turn, lines: edit([]) }].sort((a, b) => a.turn - b.turn);
  return turns.slice(-LIVE_VOICE_STRIP_TURNS);
}

/** The user's line leads its turn; everything else keeps arrival order. */
function userFirst(lines: LiveVoiceStripLine[]): LiveVoiceStripLine[] {
  return [...lines.filter((line) => line.kind === "you"), ...lines.filter((line) => line.kind !== "you")];
}

export function reduceLiveVoiceStrip(state: LiveVoiceStripState, event: LiveVoiceStripEvent): LiveVoiceStripState {
  if (event.type === "reset") return initialLiveVoiceStrip();
  if (event.type === "tool") {
    const line: LiveVoiceStripLine = { key: `tool:${state.seq}`, kind: "tool", text: toolLineLabel(event.name, event.args, event.summary), ok: event.ok };
    return { turns: withTurn(state, event.turn, (lines) => [...lines, line]), actions: state.actions + 1, seq: state.seq + 1 };
  }
  if (!event.text.trim()) return state;
  const kind = event.speaker === "user" ? "you" : "lotus";
  const replaces = event.isFinal || !!event.cumulative;
  // An item belongs to the turn it began in: its final can arrive after the next one has started.
  const key = event.itemId ? `${kind}:${event.itemId}` : null;
  const home = key ? state.turns.find((turn) => turn.lines.some((line) => line.key === key)) : undefined;
  let seq = state.seq;
  const turns = withTurn(state, home?.turn ?? event.turn, (lines) => {
    // Without an item id, a delta continues the side's last unfinished line in this turn.
    const index = key
      ? lines.findIndex((line) => line.key === key)
      : lines.findLastIndex((line) => line.kind === kind && !line.final);
    if (index >= 0) {
      const line = lines[index] as Extract<LiveVoiceStripLine, { kind: "you" | "lotus" }>;
      const text = replaces ? event.text : line.text + event.text;
      return lines.map((entry, i) => (i === index ? { ...line, text, final: event.isFinal } : entry));
    }
    return userFirst([...lines, { key: key ?? `${kind}:#${seq++}`, kind, text: event.text, final: event.isFinal }]);
  });
  return { ...state, turns, seq };
}

export function formatVoiceDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The one line left after End: "Live Voice · 2 actions · 1:05". */
export function liveVoiceSummary(actions: number, ms: number): string {
  return `Live Voice · ${actions} ${actions === 1 ? "action" : "actions"} · ${formatVoiceDuration(ms)}`;
}

/** The composer's status line while Live Voice runs. `activity` is the mode's progress copy while Lotus works. */
export function liveVoiceStatusText({
  phase,
  agentSpeaking,
  activity,
  error,
  micMuted = false,
  ending = false,
  working = false,
}: {
  phase: S2sPhase;
  agentSpeaking: boolean;
  activity?: string;
  /** The assistant brain has a request and no answer yet. */
  working?: boolean;
  error?: string;
  micMuted?: boolean;
  /** A sign-off was accepted; the goodbye is playing. */
  ending?: boolean;
}): string {
  if (ending && phase !== "error" && phase !== "closed") return "Ending Live Voice… talk to keep it open";
  if (micMuted && (phase === "listening" || phase === "user" || phase === "agent")) {
    return phase === "agent" && agentSpeaking ? "Lotus is speaking · mic muted" : "Mic muted · Lotus can't hear you";
  }
  if (working && (phase === "listening" || phase === "thinking" || (phase === "agent" && !agentSpeaking))) return "Working on it…";
  switch (phase) {
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Connection dropped — reconnecting…";
    case "thinking":
      return activity ?? "Thinking…";
    case "agent":
      return agentSpeaking ? "Lotus is speaking — talk to interrupt" : "Listening…";
    case "error":
      return error || "Live Voice stopped working.";
    default:
      return "Listening…";
  }
}
