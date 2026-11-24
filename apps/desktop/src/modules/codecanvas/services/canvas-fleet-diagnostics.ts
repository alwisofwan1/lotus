import type { AgentStatusSnapshot } from "./agent-status-registry";
import type { AgentNodeStatus } from "../types/canvas";

/**
 * Phase 0 — canvas fleet observability. The dispatch-zombie bug kept surfacing as an agent saying
 * a visible teammate "does not exist". This computes a single debug snapshot that names, per visible
 * agent, exactly WHERE the projection breaks — so a failure is a concrete, greppable reason instead
 * of a mystery. Pure and dependency-light: the caller passes the four layers (on-board nodes, status
 * registry, reply handles, last pushed MCP fleet) as plain arrays; nothing here touches globals.
 */

export interface CanvasFleetDebugAgentNode {
  id: string;
  name: string;
}

export interface CanvasFleetDebugInput {
  /** Agent nodes currently on the board. */
  agentNodes: readonly CanvasFleetDebugAgentNode[];
  /** agentStatusRegistry.list(). */
  registry: readonly AgentStatusSnapshot[];
  /** Node ids that have a registered reply handle. */
  replyHandleIds: readonly string[];
  /** Node ids whose reply handle reports canReply()/accepts() (ready to receive now). */
  replyReadyIds?: readonly string[];
  /** Node ids present in the last pushed MCP fleet (the fleet member `address` == node id). */
  pushedFleetNodeIds: readonly string[];
  /** Which Lotus instance this UI belongs to ("lotus" | "lotus-dev"), for the profile invariant. */
  profileKey?: string | null;
  /** ms since the fleet was last pushed to Rust (null = never / unknown). */
  snapshotAgeMs?: number | null;
}

export interface CanvasFleetDebugAgent {
  id: string;
  name: string;
  visible: boolean;
  inRegistry: boolean;
  hasReplyHandle: boolean;
  replyReady: boolean;
  inPushedFleet: boolean;
  status?: AgentNodeStatus;
  /** Human-readable diagnosis — the explicit error copy Phase 0 asks for. */
  reason: string;
}

export interface CanvasFleetDebugSnapshot {
  counts: {
    nodeAgents: number;
    registry: number;
    replyHandles: number;
    pushedFleet: number;
  };
  profileKey: string | null;
  snapshotAgeMs: number | null;
  agents: CanvasFleetDebugAgent[];
  /** Every non-"ok" reason, ready to log/toast — empty means the invariants hold. */
  problems: string[];
}

/** Diagnose one visible agent: the first broken link in node → fleet → handle → ready wins. */
function diagnose(agent: CanvasFleetDebugAgent): string {
  if (!agent.inPushedFleet) return `${agent.name} visible but missing from MCP fleet`;
  if (!agent.hasReplyHandle) return `${agent.name} in fleet but no reply handle`;
  if (!agent.replyReady) return `${agent.name} reply handle exists but not ready, queued`;
  return `${agent.name} ok`;
}

export function computeCanvasFleetDebugSnapshot(input: CanvasFleetDebugInput): CanvasFleetDebugSnapshot {
  const registryById = new Map(input.registry.map((s) => [s.id, s]));
  const replyHandles = new Set(input.replyHandleIds);
  const replyReady = new Set(input.replyReadyIds ?? []);
  const pushedFleet = new Set(input.pushedFleetNodeIds);
  const visibleIds = new Set(input.agentNodes.map((n) => n.id));

  const agents: CanvasFleetDebugAgent[] = input.agentNodes.map((node) => {
    const snapshot = registryById.get(node.id);
    const agent: CanvasFleetDebugAgent = {
      id: node.id,
      name: node.name,
      visible: true,
      inRegistry: registryById.has(node.id),
      hasReplyHandle: replyHandles.has(node.id),
      replyReady: replyReady.has(node.id),
      inPushedFleet: pushedFleet.has(node.id),
      status: snapshot?.status,
      reason: "",
    };
    agent.reason = diagnose(agent);
    return agent;
  });

  const problems = agents.map((a) => a.reason).filter((r) => !r.endsWith(" ok"));

  // Orphans: a fleet entry with no on-board node (a stale push that never got cleared) is the
  // reverse failure — it makes a dead agent look addressable. Surface it too.
  for (const fleetId of pushedFleet) {
    if (!visibleIds.has(fleetId)) {
      problems.push(`fleet entry "${fleetId}" has no visible node (orphan — stale fleet snapshot?)`);
    }
  }

  return {
    counts: {
      nodeAgents: input.agentNodes.length,
      registry: input.registry.length,
      replyHandles: input.replyHandleIds.length,
      pushedFleet: input.pushedFleetNodeIds.length,
    },
    profileKey: input.profileKey ?? null,
    snapshotAgeMs: input.snapshotAgeMs ?? null,
    agents,
    problems,
  };
}

type DiagnosticsLogger = Pick<Console, "debug"> & Partial<Pick<Console, "table">>;

/**
 * Dev-only console/table dump of the fleet projection. Always computes and returns the snapshot
 * (so callers can also react programmatically); only logs when `enabled` — defaults to "not
 * production". Injectable logger keeps it testable. This is the surface that turns "agent says X
 * doesn't exist" into a visible, greppable projection breakdown.
 */
export function logCanvasFleetDiagnostics(
  input: CanvasFleetDebugInput,
  opts?: { enabled?: boolean; logger?: DiagnosticsLogger },
): CanvasFleetDebugSnapshot {
  const snapshot = computeCanvasFleetDebugSnapshot(input);
  const enabled =
    opts?.enabled ??
    (typeof process !== "undefined" && process.env?.NODE_ENV !== "production");
  if (enabled) {
    const log = opts?.logger ?? console;
    log.debug(formatCanvasFleetDiagnostics(snapshot));
    log.table?.(snapshot.agents);
  }
  return snapshot;
}

/** Compact, human/log-friendly rendering of a debug snapshot (used by the dev-only logger). */
export function formatCanvasFleetDiagnostics(snapshot: CanvasFleetDebugSnapshot): string {
  const { counts } = snapshot;
  const header =
    `[canvas-fleet] profile=${snapshot.profileKey ?? "?"} age=${snapshot.snapshotAgeMs ?? "?"}ms ` +
    `nodes=${counts.nodeAgents} registry=${counts.registry} handles=${counts.replyHandles} fleet=${counts.pushedFleet}`;
  const lines = snapshot.agents.map(
    (a) =>
      `  • ${a.name} [${a.id}] node=${a.visible} reg=${a.inRegistry} fleet=${a.inPushedFleet} ` +
      `handle=${a.hasReplyHandle} ready=${a.replyReady} → ${a.reason}`,
  );
  const problems = snapshot.problems.length
    ? ["problems:", ...snapshot.problems.map((p) => `  ! ${p}`)]
    : ["problems: none"];
  return [header, ...lines, ...problems].join("\n");
}
