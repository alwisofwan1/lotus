import { agentReplyRegistry, type AgentReplyRegistry } from "./agent-reply-registry";
import type { AgentStatusSnapshot } from "./agent-status-registry";
import { resolveNodeByName } from "./canvas-nl-command";
import type { CanvasFleetAgentNodeRef } from "./canvas-fleet";
import { canvasRuntimePaneId, canvasRuntimeScope } from "./canvas-runtime-scope";

/** Sentinel recipient meaning "every agent on the board". */
export const ALL_RECIPIENTS = "__all__";

/** Minimal node shape for picking a dictation target — a structural subset of an xyflow node. */
export interface SelectableNode {
  id: string;
  type?: string;
  selected?: boolean;
}

/**
 * The single selected live-agent node — Dictate's target ("natural language to the active/selected
 * agent"). Returns null when no agent is selected, or when the selection is ambiguous (more than one
 * agent), so the caller falls back to the command bar instead of guessing who you meant.
 */
export function selectedAgentNodeId(nodes: SelectableNode[]): string | null {
  const agents = nodes.filter((n) => n.selected && n.type === "agent");
  return agents.length === 1 ? agents[0].id : null;
}

/** A structured task brief — the shared envelope for dispatch from the NL bar AND the lead agent. */
export interface TaskEnvelope {
  /** The instruction. Required. */
  task: string;
  /** Optional higher-level goal for context. */
  goal?: string;
  /** Optional verifiable done-condition. */
  doneWhen?: string;
}

/**
 * Renders a {@link TaskEnvelope} into the text delivered to an agent. A bare task stays bare; the
 * optional fields append labelled lines so a worker gets goal/done-when context without a bespoke
 * format per caller. Pure — both `dispatch` (NL bar) and the lead agent's fan-out format the same way.
 */
export function formatTaskEnvelope(env: TaskEnvelope): string {
  const lines = [env.task.trim()];
  const goal = env.goal?.trim();
  const doneWhen = env.doneWhen?.trim();
  if (goal) lines.push("", `Goal: ${goal}`);
  if (doneWhen) lines.push(`Done when: ${doneWhen}`);
  return lines.join("\n");
}

export interface AgentMessagingDeps {
  getHandle: AgentReplyRegistry["get"];
}

export interface SendResult {
  /** Node ids whose session received the message immediately. */
  delivered: string[];
  /** Node ids that are live but still starting — the message was buffered and will flush on ready. */
  queued: string[];
  /** Targeted node ids with no live session at all (nothing was sent or queued). */
  skipped: string[];
}

export function resolveRecipientIds(
  target: string,
  roster: AgentStatusSnapshot[],
  visibleAgents: readonly Pick<CanvasFleetAgentNodeRef, "id">[] = [],
): string[] {
  if (target === ALL_RECIPIENTS) return roster.map((r) => r.id);
  return roster.some((r) => r.id === target) || visibleAgents.some((r) => r.id === target) ? [target] : [];
}

/**
 * Resume each targeted agent's session with the message. A ready agent receives it immediately
 * (`delivered`); an agent that is live but still starting buffers it and flushes on ready
 * (`queued`, via the handle's `sendReply`); an agent with no live session is `skipped`.
 */
export function sendAgentMessage(
  target: string,
  text: string,
  roster: AgentStatusSnapshot[],
  deps: AgentMessagingDeps,
  visibleAgents: readonly Pick<CanvasFleetAgentNodeRef, "id">[] = [],
): SendResult {
  const trimmed = text.trim();
  const result: SendResult = { delivered: [], queued: [], skipped: [] };
  if (!trimmed) return result;
  for (const id of resolveRecipientIds(target, roster, visibleAgents)) {
    const handle = deps.getHandle(id);
    if (handle?.canReply()) {
      void handle.sendReply(trimmed);
      result.delivered.push(id);
    } else if (handle?.accepts?.()) {
      void handle.sendReply(trimmed);
      result.queued.push(id);
    } else {
      result.skipped.push(id);
    }
  }
  return result;
}

export type AgentMessageDeliveryState = "accepted" | "queued" | "written" | "failed";

export interface AgentMessageDeliveryReceipt {
  agentId: string;
  state: AgentMessageDeliveryState;
  error?: string;
}

export interface TrackedSendResult extends SendResult {
  /** Immediate transport truth before asynchronous ready-agent writes settle. */
  initial: AgentMessageDeliveryReceipt[];
  /** Final write truth. Buffered starting agents remain queued until their node owns a flush receipt. */
  completion: Promise<AgentMessageDeliveryReceipt[]>;
}

const WRITE_FAILED_MESSAGE = "Agent session closed before the prompt was written.";

/**
 * Voice-safe delivery variant. Ready-agent writes move from accepted to written/failed when the
 * reply handle settles; startup-buffered agents remain queued rather than being reported as written.
 */
export function sendAgentMessageTracked(
  target: string,
  text: string,
  roster: AgentStatusSnapshot[],
  deps: AgentMessagingDeps,
  visibleAgents: readonly Pick<CanvasFleetAgentNodeRef, "id">[] = [],
): TrackedSendResult {
  const trimmed = text.trim();
  const result: SendResult = { delivered: [], queued: [], skipped: [] };
  const initial: AgentMessageDeliveryReceipt[] = [];
  const completions: Array<Promise<AgentMessageDeliveryReceipt>> = [];
  if (!trimmed) return { ...result, initial, completion: Promise.resolve([]) };

  for (const id of resolveRecipientIds(target, roster, visibleAgents)) {
    const handle = deps.getHandle(id);
    if (handle?.canReply()) {
      result.delivered.push(id);
      initial.push({ agentId: id, state: "accepted" });
      try {
        completions.push(
          Promise.resolve(handle.sendReply(trimmed)).then(
            () => ({ agentId: id, state: "written" as const }),
            () => ({ agentId: id, state: "failed" as const, error: WRITE_FAILED_MESSAGE }),
          ),
        );
      } catch {
        completions.push(Promise.resolve({
          agentId: id,
          state: "failed" as const,
          error: WRITE_FAILED_MESSAGE,
        }));
      }
    } else if (handle?.accepts?.()) {
      result.queued.push(id);
      initial.push({ agentId: id, state: "queued" });
      try {
        completions.push(
          Promise.resolve(handle.sendReply(trimmed)).then(
            () => ({ agentId: id, state: "queued" as const }),
            () => ({ agentId: id, state: "failed" as const, error: WRITE_FAILED_MESSAGE }),
          ),
        );
      } catch {
        completions.push(Promise.resolve({
          agentId: id,
          state: "failed" as const,
          error: WRITE_FAILED_MESSAGE,
        }));
      }
    } else {
      result.skipped.push(id);
      const failed = { agentId: id, state: "failed" as const, error: WRITE_FAILED_MESSAGE };
      initial.push(failed);
      completions.push(Promise.resolve(failed));
    }
  }

  return { ...result, initial, completion: Promise.all(completions) };
}

export interface InsertResult {
  /** True when the text was typed into the agent's prompt (not submitted). */
  inserted: boolean;
  /** Why nothing was inserted: no live prompt, or the agent can't be typed into (headless). */
  reason?: "no-session" | "no-insert-capability";
}

/**
 * Type `text` into a single agent's live prompt WITHOUT submitting it — the dictate-review path
 * (ADR-0034): speech lands in the selected agent's terminal input so the user reviews/edits and
 * presses Enter there. Only live PTY agents expose `insert`; a headless or offline agent yields a
 * reason the caller can fall back on (e.g. keep the text in the command bar).
 */
export function insertAgentMessage(
  target: string,
  text: string,
  roster: AgentStatusSnapshot[],
  deps: AgentMessagingDeps,
): InsertResult {
  const trimmed = text.trim();
  const id = resolveRecipientIds(target, roster)[0];
  if (!trimmed || !id) return { inserted: false, reason: "no-session" };
  const handle = deps.getHandle(id);
  if (!handle?.insert) return { inserted: false, reason: "no-insert-capability" };
  // Unsubmitted insertion needs a writable prompt now. Startup `accepts()` only guarantees that a
  // submitted message can queue, not that raw terminal input has somewhere safe to land.
  if (!handle.canReply()) return { inserted: false, reason: "no-session" };
  handle.insert(trimmed);
  return { inserted: true };
}

export function createAgentMessagingDeps(): AgentMessagingDeps {
  return { getHandle: (nodeId) => agentReplyRegistry.get(nodeId) };
}

export type CanvasDispatchResolution = { ok: true; id: string } | { ok: false; error: string };

/**
 * Resolves an agent→agent dispatch target (ADR-0030) against the live roster. The MCP tool may pass
 * either the canvas node id, the `pane_id` from lotus_list_fleet, a workspace_id, or the agent's
 * display name; any of these can win outright, otherwise we name-resolve (exact → unique substring
 * → ambiguous). Never guesses — an unresolved/ambiguous target is an explicit error, never a
 * silent no-op.
 *
 * Multi-key matching (RC-1 fix): the Rust `dispatch_to_cell` resolves canvas agents by
 * `member.pane_id` and routes the dispatch with `target: member.pane_id` to the frontend.
 * The frontend roster keys agents by their React node id (`a.id`), which uses a different
 * format. We must also match by `hookPaneId` (the Lotus pane ID that the fleet snapshot uses)
 * and `workspace_id` (the `canvas:projectId` namespace) so a dispatch from Rust lands on the
 * correct agent.
 */
export function resolveCanvasDispatchTarget(
  target: string,
  roster: AgentStatusSnapshot[],
  visibleAgents: readonly CanvasFleetAgentNodeRef[] = [],
): CanvasDispatchResolution {
  const query = (target ?? "").trim();
  if (!query) return { ok: false, error: "No target agent specified." };

  // 1. Direct ID match (React node id)
  const byId = roster.find((a) => a.id === query) ?? visibleAgents.find((a) => a.id === query);
  if (byId) return { ok: true, id: byId.id };

  // 2. Hook pane_id match (Lotus pane ID from fleet snapshot)
  const byHook = roster.find((a) => a.hookPaneId === query)
    ?? visibleAgents.find((a) => canvasRuntimePaneId(a.projectId ?? null, a.id) === query);
  if (byHook) return { ok: true, id: byHook.id };

  // 3. Workspace_id match (e.g. "canvas:projA" or "canvas:default")
  if (query.startsWith("canvas:")) {
    const byWorkspace = roster.find((a) => canvasRuntimeScope(a.projectId ?? null) === query)
      ?? visibleAgents.find((a) => canvasRuntimeScope(a.projectId ?? null) === query);
    if (byWorkspace) return { ok: true, id: byWorkspace.id };
  }

  // 4. Name-based resolution (4-tier fuzzy: exact → substring → folded → Levenshtein)
  const seen = new Set<string>();
  const refs = [
    ...roster.map((a) => ({ id: a.id, kind: "agent", name: a.name })),
    ...visibleAgents.map((a) => ({ id: a.id, kind: "agent", name: a.name })),
  ].filter((ref) => {
    if (seen.has(ref.id)) return false;
    seen.add(ref.id);
    return true;
  });
  const r = resolveNodeByName(query, refs);
  if (r.ok) return { ok: true, id: r.id };

  // Phase 7.2 — actionable errors, never a silent dead-end. A not-found lists the visible roster so
  // the caller can retry with a real target; an ambiguous names the collided pane_ids so the caller
  // can disambiguate. (A caller told a teammate is present but absent here should re-list the fleet.)
  const entries = visibleRosterEntries(roster, visibleAgents);
  if (r.reason === "ambiguous") {
    const collisions = entries.filter((e) => e.name.toLowerCase() === query.toLowerCase());
    const paneIds = collisions.map((e) => e.paneId).join(", ");
    return {
      ok: false,
      error: `Multiple agents named "${query}" — dispatch by pane_id instead: ${paneIds}.`,
    };
  }
  const roster_ = entries.length
    ? ` Visible agents: ${entries.map((e) => `${e.name} (${e.paneId})`).join(", ")}.`
    : "";
  return {
    ok: false,
    error: `No agent named "${query}" on the canvas.${roster_}`,
  };
}

interface RosterEntry {
  id: string;
  name: string;
  paneId: string;
}

/** The visible dispatch roster (registry + on-board nodes), de-duped by node id, each with the
 *  pane_id a caller should target — the actionable payload for a not-found/ambiguous error. */
function visibleRosterEntries(
  roster: AgentStatusSnapshot[],
  visibleAgents: readonly CanvasFleetAgentNodeRef[],
): RosterEntry[] {
  const seen = new Set<string>();
  const entries: RosterEntry[] = [];
  for (const a of roster) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    entries.push({ id: a.id, name: a.name, paneId: a.hookPaneId ?? a.id });
  }
  for (const a of visibleAgents) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    entries.push({ id: a.id, name: a.name, paneId: canvasRuntimePaneId(a.projectId ?? null, a.id) });
  }
  return entries;
}

// NOTE: peer-messaging capability awareness is injected ONCE into the agent's SYSTEM PROMPT at spawn
// (see CANVAS_PEER_MESSAGING_CAPABILITY in live-agent-spawn.ts), NOT prepended to user task messages.
// An earlier in-band per-message brief (applyPeerCapabilityBrief) was removed (ADR-0030): tool-usage
// policy belongs in the system prompt; injecting it into task messages polluted normal single-agent
// work and is a documented context-pollution anti-pattern.
