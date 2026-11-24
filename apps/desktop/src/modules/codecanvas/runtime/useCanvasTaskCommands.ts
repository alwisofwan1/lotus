"use client";
import { useCallback, type MutableRefObject } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { UseCanvasTaskDispatchResult } from "../hooks/useCanvasTaskDispatch";
import type { UseCanvasTerminalDispatchResult } from "../hooks/useCanvasTerminalDispatch";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { CanvasTaskNodeData, CanvasTeamNodeData, TaskDispatchMode } from "../types/canvas";
import { canvasRuntimePaneId } from "../services/canvas-runtime-scope";
import { planTaskDispatch, planTeamLaunch } from "../services/task-dispatch";
import { buildSpawnFirstAgentDefinition } from "../services/spawn-first-agent";
import { currentNamePool } from "@/lib/agent-naming";
import {
  buildPromotedAgentCommand,
  buildPromotedAgentPrompt,
  type AgentTerminalPromotionPayload,
} from "../services/agent-terminal-promotion";
import { ENGINEERING_TEAM } from "../services/default-agents";

interface SpawnTerminalChildOptions {
  at: { x: number; y: number };
  cwd: string;
  parentId: string;
  label?: string;
}

interface UseCanvasTaskCommandsOptions {
  nodes: Node[];
  rootDir: string;
  activeProjectId: string | null;
  agentCounterRef: MutableRefObject<number>;
  appendDispatch: (nodes: Node[], edges: Edge[]) => void;
  spawnTerminalChild: (opts: SpawnTerminalChildOptions) => string;
  patchNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  taskDispatch: UseCanvasTaskDispatchResult;
  terminalDispatch: UseCanvasTerminalDispatchResult;
  focusCanvasNodes: (nodeIds: readonly string[], selectedNodeId?: string) => void;
}

/**
 * Canvas task execution commands. Keeps task-to-terminal/team dispatch, worktree
 * terminal spawning, and agent-to-terminal promotion behind one runtime seam.
 */
export function useCanvasTaskCommands({
  nodes,
  rootDir,
  activeProjectId,
  agentCounterRef,
  appendDispatch,
  spawnTerminalChild,
  patchNodeData,
  taskDispatch,
  terminalDispatch,
  focusCanvasNodes,
}: UseCanvasTaskCommandsOptions) {
  const handleTaskDispatch = useCallback(
    (taskNodeId: string, mode: TaskDispatchMode, runner?: AgentRunnerType, runnerCommand?: string) => {
      const node = nodes.find((n) => n.id === taskNodeId);
      if (!node) return;
      const d = node.data as CanvasTaskNodeData;
      const objective = {
        title: d.title,
        description: d.description,
        intent: d.intent,
        when: d.when,
        acceptanceCriteria: d.acceptanceCriteria,
        taskId: d.taskId,
        taskWorkspaceId: d.taskWorkspaceId,
      };

      // single → a runner-first CNVS-pure agent for the chosen CLI (no persona; ADR-0027 Phase 6),
      // auto-named uniquely from the names already on the board. team → the engineering persona team
      // (Phase 6c will re-point this to a launch-set). Both create LIVE agents seeded with the task.
      const takenNames = nodes
        .filter((n) => n.type === "agent")
        .map((n) => String((n.data as { name?: string }).name ?? ""));
      const defs =
        mode === "single"
          ? [buildSpawnFirstAgentDefinition(runner ?? "claude", takenNames, { ...(runnerCommand ? { runnerCommand } : {}), pool: currentNamePool() })]
          : ENGINEERING_TEAM;
      const plan = planTaskDispatch(objective, defs, taskNodeId, {
        cwd: d.cwd || rootDir,
        origin: node.position,
        newId: () => crypto.randomUUID(),
        startAgentNumber: agentCounterRef.current,
      });
      if (plan.agentIds.length === 0) return;
      agentCounterRef.current += plan.agentIds.length;
      appendDispatch(plan.nodes, plan.edges);
      patchNodeData(taskNodeId, { dispatchedAgentIds: plan.agentIds, status: "in-progress" });
      taskDispatch.schedule({ agentIds: plan.agentIds, deps: plan.deps });
      focusCanvasNodes([taskNodeId, ...plan.agentIds], taskNodeId);
    },
    [nodes, rootDir, agentCounterRef, appendDispatch, patchNodeData, taskDispatch, focusCanvasNodes],
  );

  // Team launch-set (ADR-0027 Phase 6): fan out N independent live runner agents from the team's
  // members (each member's cached `runner`; bare CNVS-pure launch, no personas). No Swarm backend.
  const handleTeamLaunch = useCallback(
    (teamNodeId: string) => {
      const node = nodes.find((n) => n.id === teamNodeId);
      if (!node) return;
      const team = node.data as CanvasTeamNodeData;
      if (!team.members.length) return;
      const plan = planTeamLaunch(team.members, teamNodeId, {
        cwd: team.cwd || rootDir,
        origin: node.position,
        newId: () => crypto.randomUUID(),
        startAgentNumber: agentCounterRef.current,
      });
      if (plan.agentIds.length === 0) return;
      agentCounterRef.current += plan.agentIds.length;
      appendDispatch(plan.nodes, plan.edges);
      focusCanvasNodes([teamNodeId, ...plan.agentIds], teamNodeId);
    },
    [nodes, rootDir, agentCounterRef, appendDispatch, focusCanvasNodes],
  );

  const handleSpawnTerminalForWorktree = useCallback(
    (terminalId: string, branch: string, path: string) => {
      const node = nodes.find((n) => n.id === terminalId);
      if (!node) return;
      const newTermId = spawnTerminalChild({
        at: { x: node.position.x + (node.width ?? 300) + 40, y: node.position.y },
        cwd: path,
        parentId: terminalId,
        label: branch,
      });
      patchNodeData(newTermId, { assignedWorktree: branch, assignedWorktreePath: path });
      focusCanvasNodes([terminalId, newTermId], newTermId);
    },
    [nodes, spawnTerminalChild, patchNodeData, focusCanvasNodes],
  );

  const handlePromoteToTerminal = useCallback(
    (agentId: string, payload: AgentTerminalPromotionPayload) => {
      const node = nodes.find((n) => n.id === agentId);
      if (!node) return;
      const termId = spawnTerminalChild({
        at: { x: node.position.x + (node.width ?? 320) + 40, y: node.position.y },
        cwd: payload.runCwd || rootDir,
        parentId: agentId,
      });
      const prompt = buildPromotedAgentPrompt(payload);
      const command = buildPromotedAgentCommand(prompt, {
        model: payload.model,
        effort: payload.effort,
        skipPermissions: payload.skipPermissions,
        submit: false,
      });
      terminalDispatch.schedule({ paneId: canvasRuntimePaneId(activeProjectId, termId), command });
      focusCanvasNodes([agentId, termId], termId);
    },
    [activeProjectId, focusCanvasNodes, nodes, rootDir, spawnTerminalChild, terminalDispatch],
  );

  return { handleTaskDispatch, handleTeamLaunch, handleSpawnTerminalForWorktree, handlePromoteToTerminal };
}
