import type { Node, Edge } from "@xyflow/react";
import type { AgentDefinition, CanvasNodePosition, AcceptanceCriterion, TaskWhen } from "../types/canvas";
import { createAgentNode } from "./canvas-agent-node";
import { buildCanvasWireEdge } from "./canvas-wire-style";

/** The fields of a Canvas Task Node that shape a Task Dispatch Prompt. */
export interface TaskObjective {
  title: string;
  description?: string;
  /** AI-clarified goal (Smart Convert); preferred over description in the brief. */
  intent?: string;
  /** Scheduling signal, surfaced under the "Timeline" label. */
  when?: TaskWhen;
  /** Verifiable done-conditions, rendered as a checklist reflecting `done`. */
  acceptanceCriteria?: AcceptanceCriterion[];
  /** Backend Swarm Task id; with `taskWorkspaceId` it gates the completion callback. */
  taskId?: string;
  /** The task's workspace. The REST route requires it (`?workspaceId=`), so no workspace, no callback. */
  taskWorkspaceId?: string;
}

export interface TaskDispatchContext {
  cwd: string;
  /** The task node's position; dispatched agents fan out to its right. */
  origin: CanvasNodePosition;
  newId: () => string;
  /** Highest agent display number already on the board. */
  startAgentNumber: number;
}

export interface TaskDispatchPlan {
  nodes: Node[];
  edges: Edge[];
  agentIds: string[];
  /** Agents with no upstream — started immediately by the runner. */
  rootIds: string[];
  /** Run dependencies (lead → specialist) honoured by the scheduler. */
  deps: { from: string; to: string }[];
}

const AGENT_OFFSET_X = 420;
const AGENT_GAP_Y = 300;

const WHEN_LABEL: Record<TaskWhen, string> = {
  urgent: "urgent",
  "this-week": "this week",
  "this-month": "this month",
  whenever: "whenever",
};

/** The completion callback an agent runs to hand its Swarm Task back for review. See ADR 0021. */
function completionCallback(taskId: string, workspaceId: string): string {
  return [
    `Task ID: ${taskId}`,
    "When you finish, mark the task ready for review:",
    `curl -s -X PATCH "$AGENT_CANVAS_API/api/tasks/${taskId}?workspaceId=${encodeURIComponent(workspaceId)}" \\`,
    `  -H "Authorization: Bearer $AGENT_CANVAS_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"status":"in-review"}'`,
  ].join("\n");
}

/** The task block of a Task Dispatch Prompt: title, Timeline, Intent, Acceptance criteria. */
export function buildTaskBrief(task: TaskObjective): string {
  const head = [`# ${task.title.trim()}`];
  if (task.when) head.push(`Timeline: ${WHEN_LABEL[task.when]}`);
  const sections = [head.join("\n")];

  const intent = (task.intent ?? task.description ?? "").trim();
  if (intent) sections.push(`## Intent\n${intent}`);

  const criteria = task.acceptanceCriteria ?? [];
  if (criteria.length > 0) {
    sections.push(`## Acceptance criteria\n${criteria.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

/**
 * Assembles a Task Dispatch Prompt: the task brief, then an optional agent persona, then the
 * taskId-gated completion callback — each separated by a `---` rule. Copy Prompt and live-agent
 * dispatch pass no persona (a live persona's role rides its system prompt); a headless fold may
 * pass the base prompt. The callback always comes last so "when you finish" is the closing directive.
 * It needs both the task id and its workspace: `PATCH /api/tasks/:id` answers 400 without
 * `?workspaceId=`, and a callback that can only fail is worse than none.
 */
export function composeTaskPrompt(task: TaskObjective, opts: { persona?: string } = {}): string {
  const parts = [buildTaskBrief(task)];
  const persona = opts.persona?.trim();
  if (persona) parts.push(persona);
  const taskId = task.taskId?.trim();
  const workspaceId = task.taskWorkspaceId?.trim();
  if (taskId && workspaceId) parts.push(completionCallback(taskId, workspaceId));
  return parts.join("\n\n---\n");
}

/** Folds the task into an agent's persona (base prompt). Back-compat alias over composeTaskPrompt. */
export function composeAgentPrompt(task: TaskObjective, basePrompt: string): string {
  return composeTaskPrompt(task, { persona: basePrompt });
}

/**
 * Plans a dual-mode task dispatch into agent nodes + wires. One def → a single
 * autonomous agent (single mode). Many defs → the first is the lead (the run
 * root); the rest are released once the lead completes (orchestrates edges, team
 * mode). The task node wires to every agent with a visible "triggers" edge — the
 * run graph ignores it since its source is not an agent.
 */
export function planTaskDispatch(
  task: TaskObjective,
  defs: AgentDefinition[],
  taskNodeId: string,
  ctx: TaskDispatchContext,
): TaskDispatchPlan {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const agentIds: string[] = [];

  // The task rides initialTask (auto-submitted once the live persona is ready); the agent's own
  // prompt stays its persona/role (injected as the system prompt). Headless agents fold the task in
  // via composeAgentPrompt at run time. See ADR-0022.
  const task_prompt = composeTaskPrompt(task);
  defs.forEach((def, i) => {
    const id = ctx.newId();
    agentIds.push(id);
    nodes.push(
      createAgentNode(def, {
        id,
        cwd: ctx.cwd,
        agentNumber: ctx.startAgentNumber + i + 1,
        position: { x: ctx.origin.x + AGENT_OFFSET_X, y: ctx.origin.y + i * AGENT_GAP_Y },
        initialTask: task_prompt,
      }),
    );
    edges.push(buildCanvasWireEdge({ id: ctx.newId(), source: taskNodeId, target: id, kind: "triggers", animated: true }));
  });

  const deps = agentIds.slice(1).map((to) => ({ from: agentIds[0], to }));
  deps.forEach(({ from, to }) =>
    edges.push(buildCanvasWireEdge({ id: ctx.newId(), source: from, target: to, kind: "orchestrates", animated: true })),
  );

  return { nodes, edges, agentIds, rootIds: agentIds.slice(0, 1), deps };
}

/**
 * Plans a Team launch-set (ADR-0027 Phase 6): spawn N runners AT ONCE as independent live agents —
 * no lead/specialist orchestration, no roles, no auto-submitted task. Each def contributes its cached
 * `runner` (LiveAgentNode is CNVS-pure, so any persona fields are ignored at launch); the task node /
 * NL bar / handoffs drive work afterwards. The team node wires to every agent with a "triggers" edge.
 */
export function planTeamLaunch(
  defs: AgentDefinition[],
  teamNodeId: string,
  ctx: TaskDispatchContext,
): TaskDispatchPlan {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const agentIds: string[] = [];

  defs.forEach((def, i) => {
    const id = ctx.newId();
    agentIds.push(id);
    nodes.push(
      createAgentNode(def, {
        id,
        cwd: ctx.cwd,
        agentNumber: ctx.startAgentNumber + i + 1,
        position: { x: ctx.origin.x + AGENT_OFFSET_X, y: ctx.origin.y + i * AGENT_GAP_Y },
        // launch-set: bare runner, no auto-submitted task — they spawn ready and idle.
      }),
    );
    edges.push(buildCanvasWireEdge({ id: ctx.newId(), source: teamNodeId, target: id, kind: "triggers", animated: true }));
  });

  // Independent: all N spawn at once (no run dependencies between them).
  return { nodes, edges, agentIds, rootIds: agentIds, deps: [] };
}
