"use client";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useReactFlow, useStore, type NodeProps, type ReactFlowState } from "@xyflow/react";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { RunNodeCard, RunNodeGlyph, type RunMember } from "./RunNodeCard";
import { RunGroupOverlay } from "./RunGroupOverlay";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { useCanvasGraphRun } from "../../hooks/useCanvasGraphRun";
import { buildRunGraph, isExecutionEdge } from "../../services/canvas-run-scheduler";
import { decideHumanGate } from "../../services/human-gate-decision";
import {
  normalizeBudgetCap,
  raisedBudgetCap,
  runCardView,
  runChainLabel,
  runGateAuthor,
  runNodeWorkflowId,
  waitingRunGates,
  type RunGateWait,
} from "../../services/run-node";
import { nodeRect, runGroupBox, type RunGroupBox } from "../../services/run-group";
import { setRunNodeActive } from "../../services/run-node-activity";
import type { CanvasRunNodeData, HumanGateNodePatch } from "../../types/canvas";

const MEMBER_SEP = "\u0000";

function memberLabel(data: Record<string, unknown> | undefined, type: string | undefined): string {
  const name = data?.name ?? data?.title;
  return typeof name === "string" && name.trim() ? name : type ?? "node";
}

/** `x,y,w,h` of the members' outline, `|drag` while one of them is being dragged; "" with no member on the board. */
function groupBoxKey(memberIds: readonly string[], s: ReactFlowState): string {
  const rects = [];
  let dragging = false;
  for (const mid of memberIds) {
    const n = s.nodeLookup.get(mid);
    if (!n) continue;
    rects.push(nodeRect(n));
    dragging ||= !!n.dragging;
  }
  const box = runGroupBox(rects);
  return box ? `${box.x},${box.y},${box.w},${box.h}${dragging ? "|drag" : ""}` : "";
}

function sameGates(a: RunGateWait[], b: RunGateWait[]): boolean {
  return a.length === b.length && a.every((g, i) => g.gateId === b[i].gateId && g.title === b[i].title
    && g.instructions === b[i].instructions && g.waitingSince === b[i].waitingSince);
}

/**
 * Run Node: one graph run over its member nodes (plans/canvas-graph-run, S8). Owns its own run
 * controller — records are filed under `run-node:<id>`, and the graph is scoped to `memberIds`,
 * so a node outside the run is never dispatched. All runs share one agent limit (#71).
 */
export const RunNode = memo(function RunNode({ id, data, selected }: NodeProps) {
  const { title, memberIds, brief = "", budgetCap: rawCap, open = false, projectId, dispatchCommand } = data as CanvasRunNodeData;
  const budgetCap = normalizeBudgetCap(rawCap);
  const lodTier = useCanvasLodTier();
  const flow = useReactFlow();

  // One string per render so the card re-renders only when a member's label actually changes.
  const memberKey = useStore(useCallback((s: { nodeLookup: Map<string, { id: string; type?: string; data: Record<string, unknown> }> }) =>
    memberIds.map((mid) => {
      const n = s.nodeLookup.get(mid);
      return n ? `${mid}${MEMBER_SEP}${memberLabel(n.data, n.type)}` : "";
    }).filter(Boolean).join("\n"), [memberIds]));
  const members = useMemo<RunMember[]>(() => (memberKey ? memberKey.split("\n") : []).map((row) => {
    const [mid, label] = row.split(MEMBER_SEP);
    return { id: mid, label };
  }), [memberKey]);

  // The order wires between members, as one string so the card re-renders only when they change.
  const depKey = useStore(useCallback((s: { edges: { source: string; target: string; data?: Record<string, unknown> }[] }) =>
    s.edges.filter((e) => memberIds.includes(e.source) && memberIds.includes(e.target) && isExecutionEdge(e))
      .map((e) => `${e.source}${MEMBER_SEP}${e.target}`).join("\n"), [memberIds]));
  const deps = useMemo(() => (depKey ? depKey.split("\n") : []).map((row) => {
    const [from, to] = row.split(MEMBER_SEP);
    return { from, to };
  }), [depKey]);
  const chain = useMemo(() => runChainLabel(members, deps), [members, deps]);
  const waitingGates = useStore(
    useCallback((s: ReactFlowState) => waitingRunGates(memberIds, (mid) => s.nodeLookup.get(mid)), [memberIds]),
    sameGates,
  );

  // Resolved at run time, so the run takes the members and wires as they are when Run is pressed.
  const scope = useMemo(() => new Set(memberIds), [memberIds]);
  const buildGraph = useCallback(() => buildRunGraph(flow.getNodes(), flow.getEdges(), scope), [flow, scope]);
  const nodeLabel = useCallback((nodeId: string) => {
    const n = flow.getNode(nodeId);
    return n ? memberLabel(n.data, n.type) : nodeId;
  }, [flow]);
  const runInfo = useMemo(() => ({ title, brief }), [title, brief]);
  const run = useCanvasGraphRun(buildGraph, undefined, "No member of this run can be dispatched — add an agent, team, critic or gate.", {
    projectId: projectId ?? undefined,
    workflowId: runNodeWorkflowId(id),
    run: runInfo,
    nodeLabel,
    budgetCap,
  });

  // The meta line's clock ticks only while the run is live (elapsed clamps at 0 until the first tick).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!run.running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.running]);

  // Open (#74): the outline follows its members live, but stays frozen at the box it had when a
  // member's drag started — otherwise it stretches with the node and the node could never leave.
  const boxKey = useStore(useCallback((s: ReactFlowState) => (open ? groupBoxKey(memberIds, s) : ""), [open, memberIds]));
  const [rect, drag] = boxKey.split("|");
  const [restRect, setRestRect] = useState(rect);
  // Adjusting state while rendering (React's "storing information from previous renders").
  if (!drag && rect !== restRect) setRestRect(rect);
  const shown = drag && restRect ? restRect : rect;
  let groupBox: RunGroupBox | null = null;
  if (shown) {
    const [x, y, w, h] = shown.split(",").map(Number);
    groupBox = { x, y, w, h };
  }

  const view = runCardView(run.latestRun, run.running, members.length, now, waitingGates, budgetCap ?? null, run.pausing);
  const gateId = view.gate?.gateId ?? null;
  const author = gateId ? runGateAuthor(gateId, memberIds, deps) : null;
  const patchGate = useCallback((patch: HumanGateNodePatch) => {
    if (gateId) dispatchCommand?.({ kind: "patch-human-gate", nodeId: gateId, patch });
  }, [dispatchCommand, gateId]);
  const ship = useCallback(() => { if (gateId) decideHumanGate(gateId, "approve", patchGate); }, [gateId, patchGate]);
  const { replayFromWhenSettled } = run;
  const sendBack = useCallback(() => {
    if (!gateId || !author) return;
    // Queued before the reject: the reject can settle the session, and the replay must catch that.
    replayFromWhenSettled(author);
    decideHumanGate(gateId, "reject", patchGate);
  }, [gateId, author, replayFromWhenSettled, patchGate]);
  const close = useCallback(() => dispatchCommand?.({ kind: "close-node", nodeId: id }), [dispatchCommand, id]);
  const setBrief = useCallback((next: string) => dispatchCommand?.({ kind: "patch-run", nodeId: id, patch: { brief: next } }), [dispatchCommand, id]);
  const setBudgetCap = useCallback((next: number | undefined) => dispatchCommand?.({ kind: "patch-run", nodeId: id, patch: { budgetCap: next } }), [dispatchCommand, id]);
  const { resumeWithBudget } = run;
  const raiseCap = useCallback(() => {
    if (budgetCap === undefined) return;
    const next = raisedBudgetCap(budgetCap, view.costUsd);
    setBudgetCap(next);
    // The new cap reaches the hook's options only on the next render; this resume cannot wait for it.
    resumeWithBudget(next);
  }, [budgetCap, view.costUsd, setBudgetCap, resumeWithBudget]);

  const active = run.running || run.latestRun?.status === "paused";
  useEffect(() => {
    setRunNodeActive(id, active);
    return () => setRunNodeActive(id, false);
  }, [id, active]);
  const setOpen = useCallback((next: boolean) => dispatchCommand?.({ kind: "patch-run", nodeId: id, patch: { open: next } }), [dispatchCommand, id]);
  const openGroup = useCallback(() => setOpen(true), [setOpen]);
  const collapse = useCallback(() => setOpen(false), [setOpen]);
  // ⋯ (#114): Pause while steps can still start; Abort while there is a run to end.
  const onPause = run.running && !run.pausing ? run.pause : undefined;
  const onAbort = run.running || run.resumable ? run.abort : undefined;

  if (open && groupBox) {
    return (
      <RunGroupOverlay
        box={groupBox} title={title} view={view} memberCount={members.length} hasGoal={brief.trim().length > 0}
        error={run.error} compact={lodTier !== "full"} onCollapse={collapse}
        onRun={run.run} onResume={run.resumable ? run.resume : undefined}
        onRaiseCap={run.resumable ? raiseCap : undefined}
        onShip={ship}
        onSendBack={sendBack}
        sendBackBlocked={gateId && !author ? "Send back needs exactly one member wired into this gate" : undefined}
        onPause={onPause} onAbort={onAbort}
      />
    );
  }

  return (
    <CanvasNodeFrame
      kind="run"
      selected={!!selected}
      minWidth={260}
      minHeight={168}
      header={null}
      lodTier={lodTier}
      statusTone={view.state}
      glyph={<RunNodeGlyph title={title} view={view} />}
    >
      <RunNodeCard
        title={title} view={view} members={members} chain={chain} brief={brief} error={run.error}
        onBriefChange={setBrief} onRun={run.run} onResume={run.resumable ? run.resume : undefined}
        onBudgetCapChange={setBudgetCap}
        onRaiseCap={run.resumable ? raiseCap : undefined}
        onShip={ship}
        onSendBack={sendBack}
        sendBackBlocked={gateId && !author ? "Send back needs exactly one member wired into this gate" : undefined}
        selected={!!selected}
        onClose={close}
        onOpen={members.length > 0 ? openGroup : undefined}
        onPause={onPause} onAbort={onAbort}
      />
    </CanvasNodeFrame>
  );
});
