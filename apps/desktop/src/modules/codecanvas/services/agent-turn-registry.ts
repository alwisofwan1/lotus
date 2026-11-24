/**
 * The canvas's mirror of Rust's per-pane turn store (`plans/honest-agent-status/` Slice 1).
 *
 * **Why this is not in `services/narration/`.** The hook drop stream already has a canvas
 * consumer — the voice narrator — and it is gated by the narration profile. Reusing it would put
 * a status badge behind a *voice* toggle, which PLAN.md forbids as a hard invariant. This module
 * subscribes on its own account and is always on.
 *
 * It holds facts, nothing else: no freshness rule, no mapping onto UI state, no notion of what a
 * runner is capable of. Those are the resolver's job (Slice 2). Keeping them out is what lets the
 * resolver be a pure function over data this module simply hands over.
 */

/** One pane's turn state as the hook reported it. */
export interface AgentTurnFact {
  /** The pane's `LOTUS_PANE_ID` — for canvas agents, `canvasRuntimePaneId(projectId, nodeId)`. */
  paneId: string;
  /**
   * The canonical hook status: `idle`, `running`, `needs-input`, `error`, `ended`.
   *
   * Typed `string`, not a union, on purpose. The vocabulary lives in
   * `scripts/agent-notify/event-mapping.mjs` and can grow without a desktop rebuild, so a value
   * this build has never heard of must arrive intact and be declined by the resolver rather than
   * be coerced or dropped here.
   */
  turn: string;
  /** The hook's own timestamp (epoch ms), not a receipt time. */
  atMs: number;
}

export type AgentTurnListener = () => void;

export interface AgentTurnRegistry {
  record(fact: AgentTurnFact): void;
  get(paneId: string): AgentTurnFact | undefined;
  /**
   * Record that a human acted on this pane, at `atMs`.
   *
   * This exists because a rejected permission prompt produces **no hook event at all**: the tool
   * never runs, so no `tool-post` fires, and Claude ends the turn without a `Stop`. Observed live
   * on 2026-08-25 — a pane sat at `needs-input` for 200+ seconds after the operator rejected the
   * write, with the terminal plainly back at its prompt. The plan had assumed a stale ask would
   * "self-correct on the pane's next hook event"; on the rejection path there is no next event.
   *
   * It is deliberately NOT a synthetic `running` fact. Fabricating a hook state would be inferring
   * one, and `needs-you` is never inferred (`types/canvas.ts`). A separate mark can only ever
   * SUPPRESS an ask, never create a state — so the invariant holds and the resolver stays the only
   * place that decides.
   */
  noteAnswered(paneId: string, atMs: number): void;
  /** When a human last acted on this pane, if ever. */
  answeredAt(paneId: string): number | undefined;
  clear(paneId: string): void;
  subscribe(listener: AgentTurnListener): () => void;
  /**
   * A counter that advances on every observable change, for `useSyncExternalStore`.
   *
   * That hook needs a snapshot that is primitive and reference-stable; the store itself is a Map,
   * so handing it out would either tear or loop. It advances in lockstep with the listeners — a
   * rejected stale fact moves neither.
   */
  version(): number;
}

export function createAgentTurnRegistry(): AgentTurnRegistry {
  const facts = new Map<string, AgentTurnFact>();
  const answered = new Map<string, number>();
  const listeners = new Set<AgentTurnListener>();
  // Only fired when something observable actually changed. A rejected stale fact and a clear of an
  // unknown pane both leave the store identical, and re-rendering the board for either would make
  // every late hydrate cost a repaint.
  let version = 0;
  const emit = () => {
    version += 1;
    listeners.forEach((listener) => listener());
  };

  return {
    record(fact) {
      // Monotonic by the hook's own timestamp, not by arrival. The cold hydrate races the push
      // stream — a board mounting mid-turn can have `canvasPaneTurns()` resolve after a pushed
      // fact — and last-write-wins would let a stale `running` overwrite a live `needs-input`.
      //
      // Ties go to the newcomer: two hooks can share a millisecond (`tool-post` and `stop` do),
      // and the later arrival is the later event. Rejecting ties would pin a pane on whichever
      // of them happened to land first.
      const known = facts.get(fact.paneId);
      if (known && known.atMs > fact.atMs) return;
      facts.set(fact.paneId, fact);
      emit();
    },
    get(paneId) {
      return facts.get(paneId);
    },
    noteAnswered(paneId, atMs) {
      // Monotonic, like `record`: a human acting twice keeps the later moment, and an out-of-order
      // report changes nothing observable — so it must not repaint the board either.
      const known = answered.get(paneId);
      if (known !== undefined && known >= atMs) return;
      answered.set(paneId, atMs);
      emit();
    },
    answeredAt(paneId) {
      return answered.get(paneId);
    },
    clear(paneId) {
      // Deleting the entry drops the monotonic watermark with it, which is what lets a reopened
      // pane that kept its id record again. Keeping a watermark past a clear would make such a
      // pane permanently unrecordable — its next fact is older than the one we just discarded.
      // The answered mark goes with the fact: left behind, it would suppress the first genuine ask
      // a reopened pane raises.
      const had = facts.delete(paneId) || answered.delete(paneId);
      if (had) emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version() {
      return version;
    },
  };
}

/**
 * Process-wide store shared by the feed hook (producer) and every status reader (consumer) —
 * the same shape `agentStatusRegistry` uses, for the same reason: one transport, N cheap readers.
 */
export const agentTurnRegistry: AgentTurnRegistry = createAgentTurnRegistry();
