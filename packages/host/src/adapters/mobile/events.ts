import type { ConversationUpdate } from "../../types/conversation.js";
import type { FleetMember } from "../../types/fleet.js";
import type { NotificationEvent } from "../../types/notifications.js";

/** Bumped when an existing event's shape changes incompatibly, never for additions. */
export const MOBILE_PROTOCOL_VERSION = 1;

/** Longest accepted pane id — a bound on untrusted input, not a real id length. */
const MAX_ID_LENGTH = 1024;

/** Most cells one resume may ask about — the pager's window is five (`AgentScreen._reach`). */
const MAX_RESUME_CURSORS = 32;

/** What the app may rely on. Unknown entries are ignored by older apps (ADR-10). */
export interface HostCaps {
  protocol: number;
  features: string[];
}

export type HostMode = "client" | "standalone";

export { hostFeatures, type HostCapabilityOpts } from "./host-features.js";

/** First frame on every connection, so the app never has to ask separately. */
export interface HelloEvent {
  type: "hello";
  hostId: string;
  hostLabel: string;
  mode: HostMode;
  hostCaps: HostCaps;
}

/**
 * One thing that changed in a cell's conversation, as `Part`s rather than hook entries.
 *
 * The live counterpart of `GET /m/cell/:paneId/conversation`, and additive beside
 * `notification`: both are broadcast for the same step, so a phone built before this frame
 * keeps working unchanged (ADR-4). It exists to end a duplication rather than to add a
 * capability — the entry→part rule was written twice, in `parts-from-entries.ts` and again
 * in the app's `conversation_builder.dart`, pinned equal by a test. Sending the answer means
 * there is one implementation of it.
 *
 * `agentType` rides along because a `Part` carries no runner and the phone files by cell.
 */
export interface ConversationUpdateEvent {
  type: "conversation";
  paneId: string;
  agentType: string;
  update: ConversationUpdate;
  /**
   * Monotonic per cell, for the life of this host process — what a reconnecting client sends
   * back as `conversation.resume`. Absent from a host older than the resume lane, and a client
   * that sees none simply cannot resume; it refetches, as it always did.
   */
  cursor: number;
}

/**
 * The client asked to resume from further back than this host still holds.
 *
 * The twin of `cell.truncated`, and the same honesty: a hole named is a hole the client can
 * repair with one REST fetch, while a hole hidden is a transcript missing its middle.
 */
export interface ConversationTruncatedEvent {
  type: "conversation.truncated";
  paneId: string;
  requestedFromCursor: number;
  /** The oldest cursor still held. Zero when nothing is held for this cell at all. */
  oldestCursor: number;
}

export interface FleetChangedEvent {
  type: "fleet.changed";
  cells: FleetMember[];
}

export interface CellOutputEvent {
  type: "cell.output";
  paneId: string;
  chunk: string;
  /** Ring-buffer offset this chunk ends at — what a later `resume` asks from. */
  byteOffset: number;
}

/** What every host can do, whichever mode it runs in. */

export interface NotificationForwardEvent {
  type: "notification";
  event: NotificationEvent;
}

// `ChatTokenEvent` lived here with a golden fixture and types on both sides, and
// **nothing ever published it** — `POST /api/bridge/chat` is request/response, so there
// were no tokens to stream in the first place. Removed 2026-08-06 rather than left as a
// contract that reads as supported: the same class of gap as `cell.output` (dab5261e),
// except a fixture made this one look finished. It comes back with its producer, if a
// streaming bridge and a surface for it are ever decided (PLAN §2.3 F7).

/** Sent instead of silently dropping output the ring buffer no longer holds. */
export interface OutputTruncatedEvent {
  type: "cell.truncated";
  paneId: string;
  requestedFromByte: number;
  servedFromByte: number;
}

export type ServerEvent =
  | HelloEvent
  | FleetChangedEvent
  | CellOutputEvent
  | NotificationForwardEvent
  | ConversationUpdateEvent
  | ConversationTruncatedEvent
  | OutputTruncatedEvent;

export interface SubscribeMessage {
  type: "subscribe";
  /** null detaches from the current pane without opening another. */
  paneId: string | null;
}

export interface ResumeMessage {
  type: "resume";
  paneId: string;
  fromByte: number;
}

export interface PingMessage {
  type: "ping";
}

/**
 * "Here is the last cursor I hold for each cell I follow — send me the rest."
 *
 * A list, unlike `resume`, because the phone follows a window of neighbouring cells at once
 * (`live_conversation.dart`), and a reconnect has to repair all of them in one round trip
 * rather than one socket message per cell.
 */
export interface ConversationResumeMessage {
  type: "conversation.resume";
  cursors: Array<{ paneId: string; cursor: number }>;
}

export type ClientMessage =
  | SubscribeMessage
  | ResumeMessage
  | ConversationResumeMessage
  | PingMessage;

/**
 * Parses an inbound frame, returning null for anything malformed.
 *
 * The socket is reachable from another device, so every frame is untrusted:
 * this validates shape rather than trusting a cast, and bounds id length so a
 * frame cannot be used to push unbounded strings into logs or lookups.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const msg = parsed as Record<string, unknown>;
  switch (msg["type"]) {
    case "ping":
      return { type: "ping" };
    case "subscribe":
      return parseSubscribe(msg);
    case "resume":
      return parseResume(msg);
    case "conversation.resume":
      return parseConversationResume(msg);
    default:
      return null;
  }
}

function parseSubscribe(msg: Record<string, unknown>): SubscribeMessage | null {
  const paneId = msg["paneId"];
  if (paneId === null) return { type: "subscribe", paneId: null };
  if (!isId(paneId)) return null;
  return { type: "subscribe", paneId };
}

function parseResume(msg: Record<string, unknown>): ResumeMessage | null {
  const paneId = msg["paneId"];
  const fromByte = msg["fromByte"];
  if (!isId(paneId) || !isByteOffset(fromByte)) return null;
  return { type: "resume", paneId, fromByte };
}

/** Bounded in length as well as shape: the window is five cells, never a list of thousands. */
function parseConversationResume(msg: Record<string, unknown>): ConversationResumeMessage | null {
  const raw = msg["cursors"];
  if (!Array.isArray(raw) || raw.length > MAX_RESUME_CURSORS) return null;
  const cursors: ConversationResumeMessage["cursors"] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const { paneId, cursor } = entry as Record<string, unknown>;
    if (!isId(paneId) || !isByteOffset(cursor)) return null;
    cursors.push({ paneId, cursor });
  }
  return { type: "conversation.resume", cursors };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isByteOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
