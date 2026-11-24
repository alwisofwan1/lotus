/**
 * Reading a headless cell's conversation — the shape the host sends, not one of ours.
 *
 * A cell the phone started with `tui:false` has no terminal at all: the host runs it through
 * `StructuredSessions`, in memory, and what it can hand back is turns of typed parts rather than
 * bytes. `machine_host_conversation` deliberately passes that page through unparsed, because the
 * format belongs to `packages/host` and a copy of it in Rust would be a thing to keep in step with
 * someone else's schema. This module is the one place the canvas looks at it, and it is written
 * for the same reason: so the rest of the canvas never has to.
 *
 * **The rule that shapes everything here: a part is never dropped.** The list of `type` values in
 * `plans/codecanvas-vps-connector/issues/12` was read off the wire from one short conversation on
 * one runner, and is stated there to be incomplete — `packages/host/src/types/conversation.ts`
 * already defines several the canvas has never seen, and runners keep gaining more. So a part
 * keeps its `raw` object and its `type` string verbatim, and the renderer's fallback shows both.
 * A part that vanishes because the desktop did not recognise its name is a conversation that lies
 * about what the agent did.
 */

/** One part of a turn, with the host's own object kept beside the fields we read. */
export interface HostConversationPart {
  /**
   * The part's `type`, exactly as the host wrote it — never mapped onto a known one, never
   * replaced by a placeholder. The renderer keys off this and falls back on anything it does not
   * have a component for, so an unnamed kind still reaches the screen under its own name.
   */
  type: string;
  id: string;
  /** Order within the page. Timestamps collide inside a millisecond; this does not. */
  seq: number;
  ts: number;
  /** Everything the host sent for this part, untouched. The typed readers below pull from here. */
  raw: Record<string, unknown>;
}

export interface HostConversationTurn {
  turnId: string;
  startedAt: number;
  /** Absent while the turn is still open — the last turn of a cell being talked to usually is. */
  endedAt?: number;
  /** `end_turn` | `cancelled` | `error` | `max_turns`, or anything a newer host adds. */
  stopReason?: string;
  parts: HostConversationPart[];
}

export interface HostConversationPage {
  paneId: string;
  /** Runner family — `claude`, `codex`, `cursor`. */
  runner: string;
  /** What the operator calls it, when the host's fleet knows. */
  runnerLabel?: string;
  source: string;
  turns: HostConversationTurn[];
  hasMore: boolean;
  totalEver?: number;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function partOf(raw: unknown, index: number): HostConversationPart {
  const object = objectOf(raw);
  if (!object) {
    // Not droppable, even though there is nothing here to read. Whatever the host meant by this
    // was part of the conversation, and the fallback renderer prints it as JSON rather than
    // leaving a hole the operator cannot see.
    return { type: "", id: `part-${index}`, seq: index, ts: 0, raw: { value: raw } };
  }
  return {
    type: stringOf(object.type),
    id: stringOf(object.id, `part-${index}`),
    seq: numberOf(object.seq, index),
    ts: numberOf(object.ts, 0),
    raw: object,
  };
}

function turnOf(raw: unknown, index: number): HostConversationTurn {
  const object = objectOf(raw) ?? {};
  const parts = Array.isArray(object.parts) ? object.parts.map(partOf) : [];
  return {
    turnId: stringOf(object.turnId, `turn-${index}`),
    startedAt: numberOf(object.startedAt, 0),
    ...(typeof object.endedAt === "number" ? { endedAt: object.endedAt } : {}),
    ...(typeof object.stopReason === "string" ? { stopReason: object.stopReason } : {}),
    // Stable sort by `seq`, which is the field that exists precisely because `ts` is not enough.
    parts: parts.map((part, order) => ({ part, order }))
      .sort((a, b) => (a.part.seq - b.part.seq) || (a.order - b.order))
      .map(({ part }) => part),
  };
}

/**
 * The page a host answered with, or `null` when it was not a page at all.
 *
 * `null` rather than a throw, and rather than an empty page: the node polls this on a timer, and a
 * host mid-restart answering something unexpected must leave the last good conversation on screen
 * instead of blanking it or tearing the node down.
 */
export function readConversationPage(raw: unknown): HostConversationPage | null {
  const object = objectOf(raw);
  if (!object) return null;
  if (!Array.isArray(object.turns)) return null;
  return {
    paneId: stringOf(object.paneId),
    runner: stringOf(object.runner),
    ...(typeof object.runnerLabel === "string" ? { runnerLabel: object.runnerLabel } : {}),
    source: stringOf(object.source),
    turns: object.turns.map(turnOf),
    hasMore: object.hasMore === true,
    ...(typeof object.totalEver === "number" ? { totalEver: object.totalEver } : {}),
  };
}

/**
 * Is the conversation waiting on the agent right now?
 *
 * A turn with no `stopReason` and no `endedAt` is one the runner has not finished. This is what
 * the poll cadence and the node's status dot both read, so they can never disagree.
 */
export function isTurnOpen(turn: HostConversationTurn | undefined): boolean {
  if (!turn) return false;
  return turn.stopReason === undefined && turn.endedAt === undefined;
}

/** True while the cell's newest turn is still running. */
export function isPageBusy(page: HostConversationPage | null): boolean {
  return isTurnOpen(page?.turns.at(-1));
}

/**
 * How long to wait before asking the host for this conversation again — `null` to not ask at all.
 *
 * **Polling is the decision, and it is not free.** `/m/stream` is the host's only push surface and
 * it demands the pairing credential a phone gets; `/v1`, the loopback surface reached over the ssh
 * connection that is already open, has no stream. So the canvas asks. One ask is one ssh round
 * trip — cheap over a master connection, and cheap is not nothing when a board can hold a dozen
 * nodes.
 *
 * Two things therefore gate it:
 *
 * - **Invisible costs nothing.** A node collapsed to a glyph or scrolled off the viewport is not
 *   being read, so it does not ask.
 * - **A settled conversation asks rarely, it does not stop.** Ticket 12 says to stop once the last
 *   turn's `stopReason` closes it. Stopping outright is wrong for the one thing this feature is
 *   for: the cell is also reachable from the phone, so a turn that starts over there would never
 *   appear here, and the node would show a conversation that quietly stopped being true. Slowing
 *   to `IDLE_POLL_MS` keeps continuity at a fourteenth of the cost of the busy cadence.
 */
export const BUSY_POLL_MS = 1_200;
export const IDLE_POLL_MS = 17_000;

export function conversationPollDelayMs(
  page: HostConversationPage | null,
  visible: boolean,
): number | null {
  if (!visible) return null;
  return isPageBusy(page) ? BUSY_POLL_MS : IDLE_POLL_MS;
}

/**
 * The one line to show for a part the canvas has no component for.
 *
 * Tries the field each known family carries its prose in before giving up and printing the object:
 * `text` for messages and reasoning, `message` for errors, `summary` for the host's own `unknown`
 * part, `detail` for a status, `title` for a tool call. Never empty — an empty fallback is the
 * same silence this module exists to prevent.
 */
export function fallbackPartText(part: HostConversationPart): string {
  for (const key of ["text", "message", "summary", "detail", "title"]) {
    const value = part.raw[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  try {
    return JSON.stringify(part.raw);
  } catch {
    return String(part.raw);
  }
}

/**
 * The name to print for a part the canvas cannot draw.
 *
 * The host has its own `unknown` part for an event *it* could not name, and that one carries the
 * original in `rawType`. Printing the word "unknown" there would hide the one fact worth reporting,
 * so the inner name wins whenever there is one.
 */
export function rawPartTypeOf(part: HostConversationPart): string {
  const inner = part.raw.rawType;
  if (typeof inner === "string" && inner.trim()) return inner;
  return part.type || "untyped";
}
