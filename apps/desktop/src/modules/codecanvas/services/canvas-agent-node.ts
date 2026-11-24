import type { Node } from "@xyflow/react";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { AgentDefinition, CanvasAgentNodeRecord, CanvasNodePosition } from "../types/canvas";

export const DEFAULT_AGENT_SIZE = { w: 720, h: 520 };

interface AgentNodeFields {
  agentDefId: string;
  name: string;
  model: string;
  prompt: string;
  cwd: string;
  agentNumber: number;
  executionMode: "headless" | "live";
  appliedSkills: string[];
  effort?: string;
  permissionMode?: string;
  /** CLI runner cached from the definition; the Agent Runtime Kernel resolves it on live spawn. */
  runner?: AgentRunnerType;
  /** Full launch command for a `custom` runner; required by the kernel to spawn it (ADR-0027). */
  runnerCommand?: string;
  /** Persona accent colour cached from the definition (hex). */
  color?: string;
  assignedWorktree?: string | null;
  assignedWorktreePath?: string | null;
  baseBranch?: string | null;
  /** Prior runner session id; relaunched via the runner's resume flag on reopen (ADR-0027 Phase 5). */
  resumeSessionId?: string | null;
  /** Claude account the live agent runs on (issues/07); absent = the globally chosen one. Claude runner only. */
  account?: string | null;
  /** A task to auto-submit once a live persona is ready; transient (not persisted). */
  initialTask?: string;
}

function sizedNode(id: string, position: CanvasNodePosition, fields: AgentNodeFields, w: number, h: number): Node {
  return {
    id,
    type: "agent",
    position,
    data: { ...fields },
    width: w,
    height: h,
    style: { width: w, height: h },
  };
}

/** Instantiates a canvas agent node from a reusable definition, caching its config onto the node. */
export function createAgentNode(
  def: AgentDefinition,
  opts: { id: string; cwd: string; agentNumber: number; position: CanvasNodePosition; initialTask?: string; account?: string | null },
): Node {
  const { w, h } = DEFAULT_AGENT_SIZE;
  return sizedNode(opts.id, opts.position, {
    agentDefId: def.id,
    name: def.name,
    model: def.model,
    prompt: def.prompt,
    cwd: opts.cwd,
    agentNumber: opts.agentNumber,
    // New agents are live personas by default (ADR-0022); promote/toggle can flip to headless.
    executionMode: "live",
    appliedSkills: def.appliedSkills ?? [],
    effort: def.effort,
    permissionMode: def.permissionMode,
    runner: def.runner,
    // Carry the custom runner's command so the kernel can spawn it (else resolveRunnerCommand throws).
    ...(def.runnerCommand ? { runnerCommand: def.runnerCommand } : {}),
    color: def.color,
    // Seeded only on task dispatch; a live persona auto-submits it once ready.
    ...(opts.initialTask?.trim() ? { initialTask: opts.initialTask.trim() } : {}),
    ...(opts.account ? { account: opts.account } : {}),
  }, w, h);
}

/** Rebuilds a canvas agent node from its persisted record on snapshot load. */
export function agentRecordToNode(rec: CanvasAgentNodeRecord, rootDir: string, position: CanvasNodePosition): Node {
  return sizedNode(rec.id, position, {
    agentDefId: rec.agentDefId,
    name: rec.name,
    model: rec.model,
    prompt: rec.prompt,
    cwd: rec.cwd || rootDir,
    agentNumber: rec.agentNumber,
    // Old snapshots predate executionMode → default headless so their behaviour is unchanged (ADR-0022).
    executionMode: rec.executionMode === "live" ? "live" : "headless",
    runner: rec.runner,
    ...(rec.runnerCommand ? { runnerCommand: rec.runnerCommand } : {}),
    color: rec.color,
    appliedSkills: rec.appliedSkills ?? [],
    effort: rec.effort,
    permissionMode: rec.permissionMode,
    // Restore isolation so the agent resumes in its worktree after reload (ADR 0015).
    assignedWorktree: rec.assignedWorktree ?? null,
    assignedWorktreePath: rec.assignedWorktreePath ?? null,
    baseBranch: rec.baseBranch ?? null,
    // Restore the prior session so a reopened live agent resumes instead of starting fresh (ADR-0027 Phase 5).
    resumeSessionId: rec.resumeSessionId ?? null,
    ...(rec.account ? { account: rec.account } : {}),
  }, rec.size.w, rec.size.h);
}
