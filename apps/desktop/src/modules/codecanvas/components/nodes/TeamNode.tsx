"use client";
import { memo, useCallback, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { Users, X, Plus, Play } from "lucide-react";
import { useRunnerRegistry } from "@/lib/hooks/useRunnerRegistry";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";
import { CanvasNodeGlyph } from "./CanvasNodeGlyph";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { buildSpawnFirstAgentDefinition, cliToRunnerSpec } from "../../services/spawn-first-agent";
import { currentNamePool } from "@/lib/agent-naming";
import type { AgentDefinition, CanvasTeamNodeData, TeamNodePatch } from "../../types/canvas";

/**
 * Canvas Team Node (ADR-0027 Phase 6): a saved LAUNCH-SET of runners. "Run Team" fans out one bare
 * live runner agent per member at once — no roles, no Swarm backend. Members are runner slots; each
 * carries a cached `runner` (LiveAgentNode launches it CNVS-pure). Add/remove slots inline.
 */
export const TeamNode = memo(function TeamNode({ id, data, selected }: NodeProps) {
  const team = data as CanvasTeamNodeData;
  const lodTier = useCanvasLodTier();
  const { registry } = useRunnerRegistry();
  const runners = (registry?.runners ?? []).filter((r) => r.installed);
  const [pickedRunnerId, setPickedRunnerId] = useState<string | null>(null);
  const pickedRunner =
    (pickedRunnerId ? runners.find((r) => r.id === pickedRunnerId) : undefined) ??
    runners.find((r) => r.id === "claude") ??
    runners[0];

  const update = useCallback((patch: TeamNodePatch) => {
    if (team.dispatchCommand) team.dispatchCommand({ kind: "patch-team", nodeId: id, patch });
    else team.onChange?.(id, patch);
  }, [id, team]);

  const handleClose = useCallback(() => {
    if (team.dispatchCommand) team.dispatchCommand({ kind: "close-node", nodeId: id });
    else team.onClose?.(id);
  }, [id, team]);

  const addMember = () => {
    if (!pickedRunner) return;
    const spec = cliToRunnerSpec(pickedRunner);
    const member = buildSpawnFirstAgentDefinition(
      spec.runner,
      team.members.map((m) => m.name),
      { ...(spec.runnerCommand ? { runnerCommand: spec.runnerCommand } : {}), pool: currentNamePool() },
    );
    update({ members: [...team.members, member] });
  };

  const removeMember = (memberId: string) => {
    update({ members: team.members.filter((m) => m.id !== memberId) });
  };

  const runTeam = () => {
    if (!team.members.length) return;
    if (team.dispatchCommand) team.dispatchCommand({ kind: "launch-team", nodeId: id });
  };

  const runnerLabel = (member: AgentDefinition) => member.runner ?? "claude";

  return (
    <CanvasNodeFrame
      kind="team"
      selected={!!selected}
      minWidth={280}
      minHeight={200}
      header={null}
      lodTier={lodTier}
      glyph={<CanvasNodeGlyph label={team.name} tone="neutral" detail={`${team.members.length} runners`} />}
    >
      <div className="canvas-critic canvas-team-node nodrag nowheel">
        <div className="canvas-critic-head">
          <Users size={13} aria-hidden className="canvas-critic-icon" />
          <input className="canvas-critic-title" value={team.name} onChange={(event) => update({ name: event.target.value })} aria-label="Team name" />
          {team.dispatchCommand && (
            <CanvasNodeFocusAction
              onFocus={() => team.dispatchCommand?.({ kind: "focus-node", nodeId: id })}
              className="canvas-critic-close canvas-node-focus"
              iconSize={12}
            />
          )}
          <button type="button" className="canvas-critic-close" onClick={handleClose} aria-label="Close team node">
            <X size={12} aria-hidden />
          </button>
        </div>
        <p className="canvas-critic-hint">A launch-set: Run spawns one live runner per slot, all at once.</p>
        <textarea className="canvas-human-gate-instructions" value={team.goal} onChange={(event) => update({ goal: event.target.value })} aria-label="Team goal" />

        <div className="canvas-team-members">
          {team.members.length === 0 && <span className="canvas-team-member-empty">No runners yet — add one below.</span>}
          {team.members.map((member) => (
            <span key={member.id} className="canvas-team-member">
              {member.name}
              <span className="canvas-team-member-runner"> · {runnerLabel(member)}</span>
              <button type="button" className="canvas-team-member-remove" onClick={() => removeMember(member.id)} aria-label={`Remove ${member.name}`}>
                <X size={9} aria-hidden />
              </button>
            </span>
          ))}
        </div>

        <div className="canvas-team-add">
          {runners.length > 0 && (
            <select
              className="canvas-task-agent-select nodrag"
              aria-label="Runner to add"
              value={pickedRunner?.id ?? ""}
              onChange={(e) => setPickedRunnerId(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {runners.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          )}
          <button type="button" className="canvas-critic-btn" onClick={addMember} disabled={!pickedRunner}>
            <Plus size={12} aria-hidden /> Add runner
          </button>
        </div>

        <div className="canvas-critic-foot">
          <button type="button" className="canvas-critic-btn" disabled={team.members.length === 0} onClick={runTeam}>
            <Play size={12} aria-hidden /> Run Team
          </button>
        </div>
      </div>
    </CanvasNodeFrame>
  );
});
