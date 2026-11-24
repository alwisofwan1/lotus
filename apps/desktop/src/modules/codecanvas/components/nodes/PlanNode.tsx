"use client";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { CanvasNodeGlyph } from "./CanvasNodeGlyph";
import { PlanNodeCard } from "./PlanNodeCard";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { agentStatusRegistry } from "../../services/agent-status-registry";
import { parsePlanMarkdown } from "../../services/plan-md-parser";
import { classifyPlanSync, type PlanSyncStatus } from "../../services/plan-sync";
import { planAgentChain } from "../../services/plan-run";
import { useCanvasGraphRun } from "../../hooks/useCanvasGraphRun";
import { readProjectFile } from "@/lib/tauri/project-files";
import type { CanvasOwnerBindings, CanvasPlanNodeData } from "../../types/canvas";

export const PlanNode = memo(function PlanNode({ id, data, selected }: NodeProps) {
  const { title, steps, cwd, ownerBindings, dispatchCommand, onClose, onPlanChange } = data as CanvasPlanNodeData;
  const [roster, setRoster] = useState(() => agentStatusRegistry.list());
  const [syncStatus, setSyncStatus] = useState<PlanSyncStatus | null>(null);
  const lodTier = useCanvasLodTier();
  useEffect(() => agentStatusRegistry.subscribe(setRoster), []);

  // Run the plan: its steps' owner agents (resolved via binding/name), executed in plan order.
  const buildGraph = useCallback(() => planAgentChain(steps, roster, ownerBindings), [steps, roster, ownerBindings]);
  const runnableCount = useMemo(() => buildGraph().nodeIds.length, [buildGraph]);
  const planRun = useCanvasGraphRun(buildGraph, undefined, "No plan step has a matching agent on the canvas.");

  const patchPlan = useCallback((patch: Parameters<NonNullable<CanvasPlanNodeData["onPlanChange"]>>[1]) => {
    if (dispatchCommand) dispatchCommand({ kind: "patch-plan", nodeId: id, patch });
    else onPlanChange?.(id, patch);
  }, [dispatchCommand, id, onPlanChange]);
  const closePlan = useCallback(() => {
    if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
    else onClose?.(id);
  }, [dispatchCommand, id, onClose]);

  // Pull the plan from the team's docs/agent-team/plan.md (written by the Tech Lead).
  const sync = useCallback(async () => {
    try {
      const file = await readProjectFile(cwd, "docs/agent-team/plan.md");
      const parsed = parsePlanMarkdown(file.content);
      // Only adopt a parse that yielded steps — never wipe a good plan with an empty read.
      if (parsed.length > 0) patchPlan({ steps: parsed });
      setSyncStatus(classifyPlanSync({ found: true, steps: parsed }));
    } catch {
      // plan.md missing or unreadable — keep current steps, but say so.
      setSyncStatus(classifyPlanSync({ found: false, steps: [] }));
    }
  }, [cwd, patchPlan]);

  // Manual owner override: bind a step's owner label to a specific agent node id (null clears it).
  const setOwnerBinding = useCallback((label: string, agentId: string | null) => {
    const next: CanvasOwnerBindings = { ...(ownerBindings ?? {}) };
    if (agentId) next[label] = agentId;
    else delete next[label];
    patchPlan({ ownerBindings: next });
  }, [ownerBindings, patchPlan]);

  return (
    <CanvasNodeFrame kind="plan" selected={!!selected} minWidth={260} minHeight={220} header={null}
      lodTier={lodTier}
      glyph={<CanvasNodeGlyph label={title} tone={planRun.running ? "active" : "neutral"} detail="plan" />}
    >
      <PlanNodeCard
        title={title}
        steps={steps}
        roster={roster}
        bindings={ownerBindings}
        syncStatus={syncStatus}
        onSync={() => void sync()}
        onBindOwner={setOwnerBinding}
        onClose={closePlan}
        onFocus={dispatchCommand ? () => dispatchCommand({ kind: "focus-node", nodeId: id }) : undefined}
        onRunPlan={planRun.run}
        running={planRun.running}
        runError={planRun.error}
        runnableCount={runnableCount}
      />
    </CanvasNodeFrame>
  );
});
