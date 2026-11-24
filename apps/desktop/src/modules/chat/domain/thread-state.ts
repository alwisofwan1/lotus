// Folds ThreadEvents into the state of one thread. Pure and immutable: each change returns new
// objects for the parts it touched, so React can compare by reference. Events at or below the
// last applied `seq` are ignored, so a replay after a reconnect is safe.

import type {
  AuthSource,
  Interaction,
  ThreadEventEnvelope,
  ThreadItem,
  TurnInput,
  TurnStatus,
  TurnUsage,
} from "./thread-event";

export interface ItemState {
  item: ThreadItem;
  startedAt: number;
  endedAt: number | null;
}

export interface TurnState {
  id: string;
  input: TurnInput | null;
  status: "running" | TurnStatus;
  error: string | null;
  usage: TurnUsage | null;
  /** Set on a completed turn a fork can start from. */
  forkPoint?: string | null;
  startedAt: number;
  endedAt: number | null;
  /** The closing reply is in while the turn still runs (Stop hooks); cleared if an item follows. */
  answered?: boolean;
  items: ItemState[];
}

export interface InteractionState {
  interaction: Interaction;
  turnId: string | null;
  requestedAt: number;
  resolution: {
    decision: "allowed" | "denied" | "answered";
    message: string | null;
    answers: Record<string, string> | null;
    at: number;
  } | null;
}

export interface SessionState {
  providerSessionId: string | null;
  model: string | null;
  /** Codex's reasoning effort, once picked in this thread. */
  effort: string | null;
  authSource: AuthSource;
  requestedAuth: AuthSource | null;
  cwd: string | null;
  ended: boolean;
  error: string | null;
}

export interface ModelSwitch {
  model: string;
  label: string;
  /** How many turns had started when it happened; the switch shows after the last of them. */
  afterTurns: number;
  at: number;
}

export interface RateLimitState {
  status: string;
  rateLimitType: string | null;
  resetsAtMs: number | null;
}

export interface ThreadState {
  threadId: string;
  lastSeq: number;
  session: SessionState;
  turns: TurnState[];
  interactions: InteractionState[];
  modelSwitches: ModelSwitch[];
  /** The last limit warning or rejection; cleared by an account switch. */
  rateLimit: RateLimitState | null;
  /** The ccs account picked in this thread; null = the one it was created on. */
  account: string | null;
  /** This chat is a fork: of which chat, at which turn, and after how many of its own turns the marker sits. */
  forkedFrom?: { threadId: string; title: string; turn: number; afterTurns: number; worktree?: string };
}

export function emptyThreadState(threadId: string): ThreadState {
  return {
    threadId,
    lastSeq: 0,
    session: { providerSessionId: null, model: null, effort: null, authSource: "unknown", requestedAuth: null, cwd: null, ended: false, error: null },
    turns: [],
    interactions: [],
    modelSwitches: [],
    rateLimit: null,
    account: null,
  };
}

export function applyThreadEvents(state: ThreadState, envelopes: readonly ThreadEventEnvelope[]): ThreadState {
  return envelopes.reduce(applyThreadEvent, state);
}

export function applyThreadEvent(state: ThreadState, envelope: ThreadEventEnvelope): ThreadState {
  if (envelope.threadId !== state.threadId || envelope.seq <= state.lastSeq) return state;
  const next = reduce(state, envelope);
  return next === state ? { ...state, lastSeq: envelope.seq } : { ...next, lastSeq: envelope.seq };
}

function reduce(state: ThreadState, { event, at }: ThreadEventEnvelope): ThreadState {
  switch (event.type) {
    case "session/configured":
      return {
        ...state,
        session: {
          ...state.session,
          providerSessionId: event.providerSessionId ?? state.session.providerSessionId,
          model: event.model ?? state.session.model,
          authSource: event.authSource,
          requestedAuth: event.requestedAuth ?? null,
          cwd: event.cwd ?? state.session.cwd,
          ended: false,
          error: null,
        },
      };
    case "session/modelChanged":
      return {
        ...state,
        session: { ...state.session, model: event.model, effort: event.effort ?? state.session.effort },
        modelSwitches: [...state.modelSwitches, { model: event.model, label: event.label, afterTurns: state.turns.length, at }],
      };
    case "session/accountChanged":
      return {
        ...state,
        rateLimit: null,
        account: event.account,
        // Shown in the timeline like a model switch: "Switched to acme account".
        modelSwitches: [...state.modelSwitches, { model: state.session.model ?? "", label: `${event.account} account`, afterTurns: state.turns.length, at }],
      };
    case "session/permissionChanged":
      // Shown in the timeline like a model switch: "Switched to Allow everything".
      return {
        ...state,
        modelSwitches: [...state.modelSwitches, { model: state.session.model ?? "", label: event.label, afterTurns: state.turns.length, at }],
      };
    case "session/background":
      return state; // read by the Rust runtime (delegate wait / verify), not drawn
    case "session/rateLimit":
      return { ...state, rateLimit: { status: event.status, rateLimitType: event.rateLimitType, resetsAtMs: event.resetsAtMs } };
    case "session/ended":
      return {
        ...state,
        session: { ...state.session, ended: true, error: event.error },
        // A background sub-agent outlives its turn but not its process.
        turns: state.turns.map((turn) =>
          turn.items.some((i) => i.item.status === "running")
            ? { ...turn, items: turn.items.map((i) => (i.item.status === "running" ? { ...i, item: { ...i.item, status: "interrupted" as const }, endedAt: i.endedAt ?? at } : i)) }
            : turn,
        ),
      };
    case "turn/started":
      if (state.turns.some((t) => t.id === event.turnId)) return state;
      return {
        ...state,
        // A turn running proves a live session, also where none announced itself (a remote host revived it).
        session: state.session.ended ? { ...state.session, ended: false, error: null } : state.session,
        turns: [
          ...state.turns,
          {
            id: event.turnId,
            input: event.input,
            status: "running",
            error: null,
            usage: null,
            forkPoint: null,
            startedAt: at,
            endedAt: null,
            items: [],
          },
        ],
      };
    case "turn/completed":
      return updateTurn(state, event.turnId, (turn) => ({
        ...turn,
        status: event.status,
        error: event.error,
        usage: event.usage,
        forkPoint: event.forkPoint ?? null,
        endedAt: at,
      }));
    case "thread/forked":
      return { ...state, forkedFrom: { threadId: event.fromThreadId, title: event.fromTitle, turn: event.turn, afterTurns: state.turns.length } };
    case "thread/rewound": {
      const cut = state.turns.findIndex((t) => t.id === event.turnId);
      if (cut < 0) return state;
      const kept = new Set(state.turns.slice(0, cut).map((t) => t.id));
      return {
        ...state,
        turns: state.turns.slice(0, cut),
        interactions: state.interactions.filter((i) => i.turnId === null || kept.has(i.turnId)),
        modelSwitches: state.modelSwitches.filter((s) => s.afterTurns <= cut),
        forkedFrom: state.forkedFrom && { ...state.forkedFrom, afterTurns: Math.min(state.forkedFrom.afterTurns, cut) },
      };
    }
    case "thread/worktree":
      return state.forkedFrom ? { ...state, forkedFrom: { ...state.forkedFrom, worktree: event.branch } } : state;
    case "turn/answered":
      return updateTurn(state, event.turnId, (turn) => (turn.status === "running" ? { ...turn, answered: true } : turn));
    case "item/started":
      return updateTurn(state, event.turnId, (turn) =>
        turn.items.some((i) => i.item.id === event.item.id)
          ? turn
          : { ...turn, answered: false, items: [...turn.items, { item: event.item, startedAt: at, endedAt: null }] },
      );
    case "item/delta":
      return updateItem(state, event.turnId, event.itemId, (entry) =>
        entry.item.kind === "agentMessage" || entry.item.kind === "reasoning"
          ? { ...entry, item: { ...entry.item, text: entry.item.text + event.delta } }
          : entry,
      );
    case "item/completed": {
      const turn = state.turns.find((t) => t.id === event.turnId);
      if (turn && !turn.items.some((i) => i.item.id === event.item.id)) {
        // Completed without a start (e.g. a block that only came in a final message).
        return updateTurn(state, event.turnId, (t) => ({
          ...t,
          items: [...t.items, { item: event.item, startedAt: at, endedAt: at }],
        }));
      }
      return updateItem(state, event.turnId, event.item.id, (entry) => ({ ...entry, item: event.item, endedAt: at }));
    }
    case "interaction/requested":
      if (state.interactions.some((i) => i.interaction.id === event.interaction.id)) return state;
      return {
        ...state,
        interactions: [
          ...state.interactions,
          { interaction: event.interaction, turnId: event.turnId, requestedAt: at, resolution: null },
        ],
      };
    case "interaction/resolved":
      return {
        ...state,
        interactions: state.interactions.map((i) =>
          i.interaction.id === event.interactionId
            ? { ...i, resolution: { decision: event.decision, message: event.message, answers: event.answers, at } }
            : i,
        ),
      };
  }
}

function updateTurn(state: ThreadState, turnId: string, change: (turn: TurnState) => TurnState): ThreadState {
  const index = state.turns.findIndex((t) => t.id === turnId);
  if (index < 0) return state;
  const turn = change(state.turns[index]);
  if (turn === state.turns[index]) return state;
  const turns = state.turns.slice();
  turns[index] = turn;
  return { ...state, turns };
}

function updateItem(
  state: ThreadState,
  turnId: string,
  itemId: string,
  change: (entry: ItemState) => ItemState,
): ThreadState {
  return updateTurn(state, turnId, (turn) => {
    const index = turn.items.findIndex((i) => i.item.id === itemId);
    if (index < 0) return turn;
    const entry = change(turn.items[index]);
    if (entry === turn.items[index]) return turn;
    const items = turn.items.slice();
    items[index] = entry;
    return { ...turn, items };
  });
}
