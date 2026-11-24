import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { AgentTerminalPromotionPayload } from "../agent-terminal-promotion";
import type { BrowserNodePatch, CanvasSkillPreview, ContextNodePatch, CriticNodePatch, FileNodePatch, HumanGateNodePatch, MusicNodePatch, NoteNodePatch, PlanNodePatch, RunNodePatch, ShapeNodePatch, SmartConvertDraft, TaskDispatchMode, TaskNodePatch, TeamNodePatch, TerminalNodePatch } from "../../types/canvas";

export type CanvasNodeCommand =
  | { kind: "close-node"; nodeId: string }
  | { kind: "note-change"; nodeId: string; content: string }
  | { kind: "note-convert"; nodeId: string; draft: SmartConvertDraft }
  | { kind: "patch-note"; nodeId: string; patch: NoteNodePatch }
  /** The note's "Agent" chip: spawn a new agent beside the note, wired note → agent. */
  | { kind: "note-spawn-agent"; nodeId: string }
  | { kind: "patch-browser"; nodeId: string; patch: BrowserNodePatch }
  | { kind: "patch-context"; nodeId: string; patch: ContextNodePatch }
  | { kind: "patch-critic"; nodeId: string; patch: CriticNodePatch }
  | { kind: "patch-human-gate"; nodeId: string; patch: HumanGateNodePatch }
  | { kind: "patch-music"; nodeId: string; patch: MusicNodePatch }
  | { kind: "patch-file"; nodeId: string; patch: FileNodePatch }
  | { kind: "patch-plan"; nodeId: string; patch: PlanNodePatch }
  | { kind: "patch-run"; nodeId: string; patch: RunNodePatch }
  | { kind: "patch-task"; nodeId: string; patch: TaskNodePatch }
  | { kind: "patch-team"; nodeId: string; patch: TeamNodePatch }
  | { kind: "patch-terminal"; nodeId: string; patch: TerminalNodePatch }
  | { kind: "patch-shape"; nodeId: string; patch: ShapeNodePatch }
  | { kind: "recover-terminal"; nodeId: string }
  | { kind: "agent-add-skills"; agentId: string; cwd: string }
  | { kind: "rename-agent"; agentId: string; name: string }
  | { kind: "agent-promote-to-terminal"; agentId: string; payload: AgentTerminalPromotionPayload }
  | { kind: "open-skill"; skillsNodeId: string; skill: CanvasSkillPreview }
  /** Apply a skill to the Skills node's parent WITHOUT dragging — the row's Apply button and ⏎. */
  | { kind: "apply-skill"; targetId: string; skill: CanvasSkillPreview }
  | { kind: "reenable-skill"; terminalId: string; skillName: string }
  | { kind: "terminal-add-skills"; terminalId: string; cwd: string }
  | { kind: "terminal-spawn-for-worktree"; terminalId: string; branch: string; path: string }
  | { kind: "toggle-browser"; terminalId: string }
  | { kind: "dispatch-task"; nodeId: string; mode: TaskDispatchMode; runner?: AgentRunnerType; runnerCommand?: string }
  | { kind: "launch-team"; nodeId: string }
  | { kind: "focus-node"; nodeId: string };

export type DispatchCanvasNodeCommand = (command: CanvasNodeCommand) => void;

export interface CanvasNodeCommandHandlers {
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
  /** Toggle focus mode (hero + right rail) on a node — the header Focus action. */
  focusNode: (nodeId: string) => void;
}

/**
 * Narrow command surface for Canvas node views. Node components emit semantic
 * commands; runtime/container adapters decide how those commands affect graph
 * state, terminal dispatch, browser state, or persistence.
 */
export function handleCanvasNodeCommand(command: CanvasNodeCommand, handlers: CanvasNodeCommandHandlers): void {
  if (command.kind === "close-node") {
    handlers.closeNode(command.nodeId);
    return;
  }
  if (command.kind === "note-change") {
    handlers.changeNote(command.nodeId, command.content);
    return;
  }
  if (command.kind === "note-spawn-agent") {
    handlers.spawnAgentForNote(command.nodeId);
    return;
  }
  if (command.kind === "patch-note") {
    handlers.patchNote(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "note-convert") {
    handlers.convertNote(command.nodeId, command.draft);
    return;
  }
  if (command.kind === "patch-browser") {
    handlers.patchBrowser(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "patch-context") {
    handlers.patchContext(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "patch-critic") {
    handlers.patchCritic(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "patch-human-gate") {
    handlers.patchHumanGate(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "patch-file") {
    handlers.patchFile(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "patch-music") {
    handlers.patchMusic(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "patch-plan") {
    handlers.patchPlan(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "patch-run") {
    handlers.patchRun(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "patch-task") {
    handlers.patchTask(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "patch-team") {
    handlers.patchTeam(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "patch-terminal") {
    handlers.patchTerminal(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "patch-shape") {
    handlers.patchShape(command.nodeId, command.patch);
    return;
  }
  if (command.kind === "recover-terminal") {
    handlers.recoverTerminal(command.nodeId);
    return;
  }
  if (command.kind === "agent-add-skills") {
    handlers.addAgentSkills(command.agentId, command.cwd);
    return;
  }
  if (command.kind === "rename-agent") {
    handlers.renameAgent(command.agentId, command.name);
    return;
  }
  if (command.kind === "agent-promote-to-terminal") {
    handlers.promoteAgentToTerminal(command.agentId, command.payload);
    return;
  }
  if (command.kind === "open-skill") {
    handlers.openSkill(command.skillsNodeId, command.skill);
    return;
  }
  if (command.kind === "apply-skill") {
    handlers.applySkill(command.targetId, command.skill);
    return;
  }
  if (command.kind === "reenable-skill") {
    handlers.reenableSkill(command.terminalId, command.skillName);
    return;
  }
  if (command.kind === "terminal-add-skills") {
    handlers.addTerminalSkills(command.terminalId, command.cwd);
    return;
  }
  if (command.kind === "terminal-spawn-for-worktree") {
    handlers.spawnTerminalForWorktree(command.terminalId, command.branch, command.path);
    return;
  }
  if (command.kind === "toggle-browser") {
    handlers.toggleBrowser(command.terminalId);
    return;
  }
  if (command.kind === "launch-team") {
    handlers.launchTeam(command.nodeId);
    return;
  }
  if (command.kind === "focus-node") {
    handlers.focusNode(command.nodeId);
    return;
  }
  handlers.dispatchTask(command.nodeId, command.mode, command.runner, command.runnerCommand);
}
