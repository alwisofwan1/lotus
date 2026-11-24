import type { AgentReplyHandle } from "./agent-reply-registry";
import type { AgentStatusRegistry } from "./agent-status-registry";

/**
 * Phase 2 — canonical, queued canvas dispatch delivery (ADR-0030 follow-up).
 *
 * A dispatch to a *visible* canvas agent must never silently fail: if the target's reply handle
 * isn't ready yet (the agent is still spawning), the message is buffered here with a TTL and
 * flushed the moment the handle registers/accepts. This closes the startup race where Atlas
 * dispatches to Nova a beat before Nova's PTY publishes its reply handle — the user should hear
 * "Nova is starting; message queued", never "Nova does not exist".
 *
 * The queue is pure and clock-injected (`now`), so its TTL/expiry behavior is deterministic in
 * tests. Real callers omit `now` and get `Date.now()`.
 */

/** Default buffer window for a starting agent (plan: 30–60s). */
export const DEFAULT_DELIVERY_TTL_MS = 45_000;

/** Cap on buffered messages per node so a never-ready agent can't grow the queue unbounded. */
export const MAX_QUEUED_PER_NODE = 50;

export interface QueuedMessage {
  nodeId: string;
  text: string;
  enqueuedAt: number;
  expiresAt: number;
}

export interface DeliveryQueueDeps {
  getHandle: (nodeId: string) => AgentReplyHandle | undefined;
}

export interface FlushResult {
  /** Texts handed to the handle this flush (in FIFO order). */
  delivered: string[];
  /** Texts dropped because their TTL elapsed before the handle became ready. */
  expired: string[];
  /** Messages still buffered (handle not ready yet). */
  stillQueued: number;
}

export interface AgentDeliveryQueue {
  /** Buffer a message for a node whose handle isn't ready yet. Returns the stored entry. */
  enqueue(nodeId: string, text: string, opts?: { now?: number; ttlMs?: number }): QueuedMessage;
  /**
   * Attempt delivery of every buffered message for a node. Expired entries are dropped; if the
   * handle now accepts, non-expired entries are delivered FIFO. A not-ready handle leaves
   * non-expired entries buffered for a later flush.
   */
  flush(nodeId: string, deps: DeliveryQueueDeps, opts?: { now?: number }): FlushResult;
  /** Drop expired messages across all nodes; returns the dropped entries (for diagnostics). */
  sweep(opts?: { now?: number }): QueuedMessage[];
  /** Currently buffered messages for a node (FIFO), excluding nothing — raw view for tests/diagnostics. */
  pending(nodeId: string): QueuedMessage[];
  /** Total buffered messages across all nodes. */
  size(): number;
  /** Drop all buffered messages for a node (or the whole queue when nodeId omitted). */
  clear(nodeId?: string): void;
}

function handleAccepts(handle: AgentReplyHandle | undefined): boolean {
  if (!handle) return false;
  if (handle.accepts) return handle.accepts();
  return handle.canReply();
}

export function createAgentDeliveryQueue(): AgentDeliveryQueue {
  const queues = new Map<string, QueuedMessage[]>();

  return {
    enqueue(nodeId, text, opts) {
      const now = opts?.now ?? Date.now();
      const ttlMs = opts?.ttlMs ?? DEFAULT_DELIVERY_TTL_MS;
      const entry: QueuedMessage = { nodeId, text, enqueuedAt: now, expiresAt: now + ttlMs };
      const list = queues.get(nodeId) ?? [];
      list.push(entry);
      // Bound the buffer: drop the oldest beyond the cap.
      while (list.length > MAX_QUEUED_PER_NODE) list.shift();
      queues.set(nodeId, list);
      return entry;
    },

    flush(nodeId, deps, opts) {
      const now = opts?.now ?? Date.now();
      const list = queues.get(nodeId) ?? [];
      const result: FlushResult = { delivered: [], expired: [], stillQueued: 0 };
      if (list.length === 0) return result;

      const ready = handleAccepts(deps.getHandle(nodeId));
      const remaining: QueuedMessage[] = [];
      const handle = deps.getHandle(nodeId);
      for (const entry of list) {
        if (now >= entry.expiresAt) {
          result.expired.push(entry.text);
          continue;
        }
        if (ready && handle) {
          void handle.sendReply(entry.text);
          result.delivered.push(entry.text);
          continue;
        }
        remaining.push(entry);
      }
      result.stillQueued = remaining.length;
      if (remaining.length === 0) queues.delete(nodeId);
      else queues.set(nodeId, remaining);
      return result;
    },

    sweep(opts) {
      const now = opts?.now ?? Date.now();
      const dropped: QueuedMessage[] = [];
      for (const [nodeId, list] of queues) {
        const remaining = list.filter((entry) => {
          if (now >= entry.expiresAt) {
            dropped.push(entry);
            return false;
          }
          return true;
        });
        if (remaining.length === 0) queues.delete(nodeId);
        else queues.set(nodeId, remaining);
      }
      return dropped;
    },

    pending(nodeId) {
      return [...(queues.get(nodeId) ?? [])];
    },

    size() {
      let total = 0;
      for (const list of queues.values()) total += list.length;
      return total;
    },

    clear(nodeId) {
      if (nodeId === undefined) queues.clear();
      else queues.delete(nodeId);
    },
  };
}

/** Process-wide delivery queue shared by the MCP dispatch bridge and the reply-handle wiring. */
export const agentDeliveryQueue: AgentDeliveryQueue = createAgentDeliveryQueue();

export type DeliveryOutcomeKind = "delivered" | "queued" | "skipped";
export type DeliveryReason =
  /** Handed to a ready agent right now. */
  | "delivered"
  /** Live PTY but still starting — the node's own reply handle buffered it and will flush on ready. */
  | "buffered-by-node"
  /** No reply handle yet (agent spawning) — buffered in the TTL queue, flushes when the handle registers. */
  | "agent-starting"
  /** Nothing to send. */
  | "empty";

export interface DeliverOutcome {
  outcome: DeliveryOutcomeKind;
  reason: DeliveryReason;
}

/**
 * Decide how a single dispatch to an *already-resolved, visible* canvas agent is handled, and carry
 * it out. Precondition: `nodeId` came from {@link resolveCanvasDispatchTarget}, so the agent is on
 * the board — a not-ready target is therefore "starting", never "gone", and its message is buffered
 * (node-level or the TTL queue) rather than dropped. A gone target is caught upstream by resolution.
 */
export function deliverToAgent(
  nodeId: string,
  text: string,
  deps: DeliveryQueueDeps,
  queue: AgentDeliveryQueue,
  opts?: { now?: number; ttlMs?: number },
): DeliverOutcome {
  const trimmed = text.trim();
  if (!trimmed) return { outcome: "skipped", reason: "empty" };

  const handle = deps.getHandle(nodeId);
  if (handle?.canReply()) {
    void handle.sendReply(trimmed);
    return { outcome: "delivered", reason: "delivered" };
  }
  if (handle?.accepts?.()) {
    // Live PTY, still starting: the node's own handle buffers and flushes on ready.
    void handle.sendReply(trimmed);
    return { outcome: "queued", reason: "buffered-by-node" };
  }
  // No usable handle yet — the agent node is visible but its runtime hasn't registered. Buffer with
  // a TTL and flush when the reply handle registers (see wireDeliveryQueueFlush).
  queue.enqueue(nodeId, trimmed, { now: opts?.now, ttlMs: opts?.ttlMs });
  return { outcome: "queued", reason: "agent-starting" };
}

export interface DeliveryReceipt {
  /** Node ids delivered to right now. */
  delivered: string[];
  /** Node ids buffered (node-level or TTL queue) — will arrive when the agent is ready. */
  queued: string[];
  /** Node ids nothing was sent to. */
  skipped: string[];
  /** A human-readable, speak-ready line for the dispatching agent — never a silent 404. */
  note: string;
}

/**
 * Turn a single {@link DeliverOutcome} into the receipt the dispatching agent receives back through
 * the MCP round-trip. The `note` is deliberately actionable and speak-ready ("Nova is starting;
 * message queued") so a lead agent reports startup races truthfully instead of claiming the target
 * "does not exist".
 */
export function deliveryReceipt(id: string, name: string, outcome: DeliverOutcome): DeliveryReceipt {
  const base: Omit<DeliveryReceipt, "note"> = { delivered: [], queued: [], skipped: [] };
  switch (outcome.outcome) {
    case "delivered":
      return { ...base, delivered: [id], note: `Delivered to ${name}.` };
    case "queued":
      return {
        ...base,
        queued: [id],
        note: `${name} is starting; message queued and will be delivered when it's ready.`,
      };
    case "skipped":
      return { ...base, skipped: [id], note: "Nothing to deliver (empty message)." };
  }
}

/**
 * Flush buffered dispatches when an agent becomes reachable. The reply handle registers once (on
 * node mount) and flips readiness internally, so "handle registered" is not the moment to flush —
 * "status flipped to ready" is. Every {@link AgentStatusRegistry} emit is exactly such a moment, so
 * we subscribe there and, for each snapshot with a non-empty queue, attempt a flush (which delivers
 * to a now-ready handle and prunes anything past its TTL). Returns an unsubscribe.
 */
export function wireDeliveryQueueFlush(
  queue: AgentDeliveryQueue,
  statusRegistry: Pick<AgentStatusRegistry, "subscribe">,
  deps: DeliveryQueueDeps,
  opts?: { now?: () => number },
): () => void {
  return statusRegistry.subscribe((snapshots) => {
    const now = opts?.now?.() ?? Date.now();
    for (const snapshot of snapshots) {
      if (queue.pending(snapshot.id).length > 0) {
        queue.flush(snapshot.id, deps, { now });
      }
    }
  });
}
