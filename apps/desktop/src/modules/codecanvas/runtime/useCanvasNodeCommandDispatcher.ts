"use client";
import { useCallback } from "react";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { AgentTerminalPromotionPayload } from "../services/agent-terminal-promotion";
import type { BrowserNodePatch, CanvasSkillPreview, ContextNodePatch, CriticNodePatch, FileNodePatch, HumanGateNodePatch, MusicNodePatch, NoteNodePatch, PlanNodePatch, RunNodePatch, ShapeNodePatch, SmartConvertDraft, TaskDispatchMode, TaskNodePatch, TeamNodePatch, TerminalNodePatch } from "../types/canvas";
import {
  handleCanvasNodeCommand,
  type CanvasNodeCommand,
  type DispatchCanvasNodeCommand,
} from "../services/nodes/canvas-node-command";

interface UseCanvasNodeCommandDispatcherOptions {
  closeNode: (nodeId: string) => void;
  changeNote: (nodeId: string, content: string) => void;
  convertNote: (nodeId: string, draft: SmartConvertDraft) => void;
  patchNote: (nodeId: string, patch: NoteNodePatch) => void;
  spawnAgentForNote: (nodeId: string) => void;
  patchBrowser: (nodeId: string, patch: BrowserNodePatch) => void;
  patchContext: (nodeId: string, patch: ContextNodePatch) => void;
  patchCritic: (nodeId: string, patch: CriticNodePatch) => void;
  patchHumanGate: (nodeId: string, patch: HumanGateNodePatch) => void;
  patchMusic: (nodeId: string, patch: MusicNodePatch) => void;
  patchFile: (nodeId: string, patch: FileNodePatch) => void;
  patchPlan: (nodeId: string, patch: PlanNodePatch) => void;
  patchRun: (nodeId: string, patch: RunNodePatch) => void;
  patchTask: (nodeId: string, patch: TaskNodePatch) => void;
  patchTeam: (nodeId: string, patch: TeamNodePatch) => void;
  patchTerminal: (nodeId: string, patch: TerminalNodePatch) => void;
  patchShape: (nodeId: string, patch: ShapeNodePatch) => void;
  recoverTerminal: (nodeId: string) => void;
  addAgentSkills: (agentId: string, cwd: string) => void;
  renameAgent: (agentId: string, name: string) => void;
  promoteAgentToTerminal: (agentId: string, payload: AgentTerminalPromotionPayload) => void;
  openSkill: (skillsNodeId: string, skill: CanvasSkillPreview) => void;
  applySkill: (targetId: string, skill: CanvasSkillPreview) => void;
  reenableSkill: (terminalId: string, skillName: string) => void;
  addTerminalSkills: (terminalId: string, cwd: string) => void;
  spawnTerminalForWorktree: (terminalId: string, branch: string, path: string) => void;
  toggleBrowser: (terminalId: string) => void;
  dispatchTask: (nodeId: string, mode: TaskDispatchMode, runner?: AgentRunnerType, runnerCommand?: string) => void;
  launchTeam: (nodeId: string) => void;
  focusNode: (nodeId: string) => void;
}

/** Runtime adapter from node-view commands to existing Canvas state handlers. */
export function useCanvasNodeCommandDispatcher({
  closeNode,
  changeNote,
  convertNote,
  patchNote,
  spawnAgentForNote,
  patchBrowser,
  patchContext,
  patchCritic,
  patchHumanGate,
  patchMusic,
  patchFile,
  patchPlan,
  patchRun,
  patchTask,
  patchTeam,
  patchTerminal,
  patchShape,
  recoverTerminal,
  addAgentSkills,
  renameAgent,
  promoteAgentToTerminal,
  openSkill,
  applySkill,
  reenableSkill,
  addTerminalSkills,
  spawnTerminalForWorktree,
  toggleBrowser,
  dispatchTask,
  launchTeam,
  focusNode,
}: UseCanvasNodeCommandDispatcherOptions): DispatchCanvasNodeCommand {
  return useCallback(
    (command: CanvasNodeCommand) => handleCanvasNodeCommand(command, {
      closeNode,
      changeNote,
      convertNote,
      patchNote,
      spawnAgentForNote,
      patchBrowser,
      patchContext,
      patchCritic,
      patchHumanGate,
      patchMusic,
      patchFile,
      patchPlan,
      patchRun,
      patchTask,
      patchTeam,
      patchTerminal,
      patchShape,
      recoverTerminal,
      addAgentSkills,
      renameAgent,
      promoteAgentToTerminal,
      openSkill,
      applySkill,
      reenableSkill,
      addTerminalSkills,
      spawnTerminalForWorktree,
      toggleBrowser,
      dispatchTask,
      launchTeam,
      focusNode,
    }),
    [closeNode, changeNote, convertNote, patchNote, spawnAgentForNote, patchBrowser, patchContext, patchCritic, patchHumanGate, patchMusic, patchFile, patchPlan, patchRun, patchTask, patchTeam, patchTerminal, patchShape, recoverTerminal, addAgentSkills, renameAgent, promoteAgentToTerminal, openSkill, applySkill, reenableSkill, addTerminalSkills, spawnTerminalForWorktree, toggleBrowser, dispatchTask, launchTeam, focusNode],
  );
}
