"use client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow, type NodeProps } from "@xyflow/react";
import { useDroppable } from "@dnd-kit/core";
import { AGENT_DROP_PREFIX } from "../../hooks/useCanvasSkillDnd";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { useCanvasDropTarget } from "../../services/canvas-drop-target-store";
import { CanvasNodeGlyph, glyphToneForAgentStatus } from "./CanvasNodeGlyph";
import { CanvasAttachmentStrip } from "./CanvasAttachmentStrip";
import { AgentNodeCard } from "./AgentNodeCard";
import { AgentRunHistory } from "./AgentRunHistory";
import { CanvasWorktreePanel } from "../panels/CanvasWorktreePanel";
import { AgentDiffPanel } from "../panels/AgentDiffPanel";
import { openPathInEditor } from "@/lib/tauri/app";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { useAgentNodeState } from "../../hooks/useAgentNodeState";
import { useAgentNodeActions } from "../../hooks/useAgentNodeActions";
import { useAgentRunRegistration } from "../../hooks/useAgentRunRegistration";
import { useAgentReplyRegistration } from "../../hooks/useAgentReplyRegistration";
import { useCanvasGraphRunContext, useCanvasProjectId } from "../CanvasGraphRunProvider";
import { useCanvasAttachments } from "../../hooks/useCanvasAttachments";
import { agentStatusRegistry } from "../../services/agent-status-registry";
import { agentRunStore } from "../../services/agent-run-store";
import { canvasRuntimePaneId } from "../../services/canvas-runtime-scope";
import { agentRunRegistry } from "../../services/agent-run-registry";
import type { AgentRunRecord } from "../../services/agent-run-record";
import { canvasAttachmentStore } from "../../services/canvas-attachment-store";
import { canvasHandoffStore } from "../../services/canvas-handoff-store";
import { contextBusRegistry } from "../../services/context-bus-registry";
import { contextBusStore } from "../../services/context-bus-store";
import { buildArtifact, nextVersion } from "../../services/context-bus-record";
import { resolveUpstreamContext } from "../../services/canvas-upstream-context";
import type { CanvasImageRef } from "../../services/canvas-intake";
import { resolveNoteAssetImageRefs } from "../../services/note-assets";
import type { AgentContextSource } from "../../services/agent-run-prompt";
import { resolveGovernance } from "../../services/agent-governance";
import type { CanvasAgentNodeData } from "../../types/canvas";
import type { AgentTerminalPromotionPayload } from "../../services/agent-terminal-promotion";

export const HeadlessAgentNode = memo(function HeadlessAgentNode({ id, data, selected }: NodeProps) {
  const {
    name, model, cwd, prompt, appliedSkills, effort, permissionMode,
    dispatchCommand, onClose, onAddSkillsNode, hasSkillsNode, onPromoteToTerminal,
  } = data as CanvasAgentNodeData;
  const governance = resolveGovernance({ effort: effort as never, permissionMode: permissionMode as never });
  const [historyOpen, setHistoryOpen] = useState(false);
  const dropActive = useCanvasDropTarget(id);
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `${AGENT_DROP_PREFIX}${id}` });
  const lodTier = useCanvasLodTier();
  const flow = useReactFlow();
  const projectId = useCanvasProjectId();
  // Upstream context (Note text + N2 handoff + N3 bus artifacts), resolved at run time.
  const getContext = useCallback((activeGraphRunId?: string | null): AgentContextSource[] =>
    resolveUpstreamContext(flow, id, activeGraphRunId), [flow, id]);
  // Image attachments fed to the run: dropped/pasted on this agent + on connected upstream nodes.
  const getAttachments = useCallback(async (): Promise<CanvasImageRef[]> => {
    const upstreamContext = resolveUpstreamContext(flow, id, null);
    const noteAssetIds = upstreamContext.flatMap((source) => source.assets?.map((asset) => asset.id) ?? []);
    return [
      ...canvasAttachmentStore.list(id),
      ...flow.getEdges().filter((e) => e.target === id).flatMap((e) => canvasAttachmentStore.list(e.source)),
      ...await resolveNoteAssetImageRefs(noteAssetIds),
    ];
  }, [flow, id]);
  // The canvas roster — names the Lead must use verbatim when assigning plan owners.
  const getRoster = useCallback(() => agentStatusRegistry.list().map((a) => a.name), []);
  const rawBranch = (data as Record<string, unknown>).assignedWorktree;
  const rawPath = (data as Record<string, unknown>).assignedWorktreePath;
  const initialWorktree =
    typeof rawBranch === "string" && typeof rawPath === "string"
      ? { branch: rawBranch, path: rawPath }
      : null;
  const actions = useAgentNodeActions({ cwd, initialWorktree });
  const ownAttachments = useCanvasAttachments(id);
  const contextCount = getContext().filter((source) => typeof source.content === "string" && source.content.trim()).length;
  const skillCount = Array.isArray(appliedSkills) ? appliedSkills.length : 0;
  const lastRunRef = useRef<AgentRunRecord | null>(null);
  const { status, view, sessionId, canReply, start, stop, sendReply } = useAgentNodeState({
    prompt, model, cwd: actions.runCwd, appliedSkills, getContext, getAttachments, getRoster, effort: governance.effort, skipPermissions: governance.skipPermissions,
    agentId: id, runtimePaneId: canvasRuntimePaneId(projectId, id), onRunComplete: (record) => {
      lastRunRef.current = record;
      void agentRunStore.append(record);
      if (record.outcome === "completed" && record.summary?.trim()) {
        // N2 handoff: a direct downstream agent picks this up via its edge.
        canvasHandoffStore.set(id, { name, summary: record.summary, sessionId: record.sessionId });
        // N3 bus: publish to every Context Node this agent feeds (data-flow edge), keyed by name.
        const summary = record.summary;
        flow.getEdges()
          .filter((e) => e.source === id)
          .map((e) => flow.getNode(e.target))
          .filter((n): n is NonNullable<typeof n> => n?.type === "context")
          .forEach((n) => {
            const artifact = buildArtifact({
              projectId: projectId ?? "", busNodeId: n.id, key: name, value: summary, producer: name,
              graphRunId: record.graphRunId ?? null, now: Date.now(),
              version: nextVersion(contextBusRegistry.get(n.id, name)),
            });
            contextBusRegistry.publish(artifact);
            if (projectId) void contextBusStore.save(artifact);
          });
      }
    },
  });
  useAgentRunRegistration(id, status, start, agentRunRegistry, () => {
    const r = lastRunRef.current;
    return r ? { outcome: r.outcome, sessionId: r.sessionId, nodeRunId: r.id, usage: r.usage } : null;
  });
  useAgentReplyRegistration(id, canReply, sendReply);
  const graphRun = useCanvasGraphRunContext();

  // Publish live status to the Inbox; drop the entry when the node is removed.
  useEffect(() => { agentStatusRegistry.publish({ id, name, status }); }, [id, name, status]);
  useEffect(() => () => agentStatusRegistry.remove(id), [id]);

  // Closing a node kills its agent (ADR: kill on onClose only).
  const handleClose = useCallback(() => {
    if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
    else onClose?.(id);
  }, [dispatchCommand, onClose, id]);

  const handlePromoteToTerminal = useCallback(() => {
    if (!dispatchCommand && !onPromoteToTerminal) return;
    const payload: AgentTerminalPromotionPayload = {
      name,
      model,
      rolePrompt: prompt,
      runCwd: actions.runCwd,
      appliedSkills: Array.isArray(appliedSkills) ? appliedSkills : [],
      effort: governance.effort,
      skipPermissions: governance.skipPermissions,
      context: getContext(null),
      roster: getRoster(),
    };
    if (dispatchCommand) dispatchCommand({ kind: "agent-promote-to-terminal", agentId: id, payload });
    else if (onPromoteToTerminal) onPromoteToTerminal(id, payload);
  }, [actions.runCwd, appliedSkills, dispatchCommand, getContext, getRoster, governance.effort, governance.skipPermissions, id, model, name, onPromoteToTerminal, prompt]);

  const overlay = historyOpen ? (
    <AgentRunHistory
      agentId={id}
      onClose={() => setHistoryOpen(false)}
      canReplay={graphRun.replayable && !graphRun.running}
      onReplayFrom={() => { graphRun.replayFrom(id); setHistoryOpen(false); }}
    />
  ) : actions.activePanel === "wt" ? (
    <CanvasWorktreePanel
      cwd={cwd}
      assignedWorktree={actions.worktree?.branch ?? null}
      onAssign={actions.assignWorktree}
      onUnassign={actions.unassignWorktree}
      onClose={actions.closePanel}
    />
  ) : actions.activePanel === "diff" ? (
    <AgentDiffPanel cwd={actions.runCwd} onClose={actions.closePanel} />
  ) : undefined;

  return (
    <CanvasNodeFrame kind="agent" selected={!!selected} minWidth={260} minHeight={200}
      header={null}
      overlay={overlay}
      lodTier={lodTier}
      dropActive={dropActive}
      dropLabel={name ? `Drop to attach to ${name}` : "Drop to attach"}
      glyph={<CanvasNodeGlyph label={name} tone={glyphToneForAgentStatus(status)} detail={model} />}
    >
      <div
        ref={setDropRef}
        className={`agent-drop-zone${isOver ? " canvas-node-body--drop-over" : ""}`}
        data-testid="agent-drop-zone"
      >
        <AgentNodeCard
          name={name}
          model={model}
          readonly={!governance.skipPermissions}
          status={status}
          view={view}
          canReply={canReply}
          onRun={() => void start()}
          onStop={() => void stop()}
          onClose={handleClose}
          onFocus={dispatchCommand ? () => dispatchCommand({ kind: "focus-node", nodeId: id }) : undefined}
          onReply={(text) => void sendReply(text)}
          onShowHistory={() => setHistoryOpen((v) => !v)}
          sessionId={sessionId}
          contextCount={contextCount}
          skillCount={skillCount}
          imageCount={ownAttachments.length}
          worktreeBranch={actions.worktree?.branch ?? null}
          onToggleWT={actions.toggleWT}
          wtActive={actions.activePanel === "wt"}
          onToggleDiff={actions.toggleDiff}
          diffActive={actions.activePanel === "diff"}
          onOpenIde={() => void openPathInEditor(actions.runCwd, actions.runCwd)}
          onToggleSkills={dispatchCommand || onAddSkillsNode ? () => {
            if (dispatchCommand) dispatchCommand({ kind: "agent-add-skills", agentId: id, cwd: actions.runCwd });
            else onAddSkillsNode?.(id, actions.runCwd);
          } : undefined}
          skillsActive={hasSkillsNode}
          onPromoteToTerminal={dispatchCommand || onPromoteToTerminal ? handlePromoteToTerminal : undefined}
          deliveryTargetId={id}
        />
        <CanvasAttachmentStrip nodeId={id} />
      </div>
    </CanvasNodeFrame>
  );
});
