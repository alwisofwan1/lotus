import type { SpawnTaskStamp } from "../services/commands/canvas-command";
import { useCallback, useLayoutEffect, useRef } from "react";
import {
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type XYPosition,
  type OnNodesChange,
  type OnEdgesChange,
} from "@xyflow/react";
import type { CanvasSnapshot, CanvasNoteNodeRecord, CanvasTerminalNodeRecord, CanvasSkillPreview, AgentDefinition, PlanNodePatch, SmartConvertDraft } from "../types/canvas";
import { buildCanvasWireEdge } from "../services/canvas-wire-style";
import { restoredEdgeKind } from "../services/canvas-edge-semantics";
import { reorderNodes, reorderNodesMany, type ArrangeDirection } from "../services/canvas-node-order";
import { frameFocusLayout, frameNodeFocusLayout } from "../services/canvas-frame-focus";
import { layoutSnapshotOf } from "../services/canvas-canonical-layout";
import { restoreMemberGeometry, restoreShapeEdges, restoreShapes, type ShapeSnapshot } from "../services/canvas-shape-history";
import { markLayoutBoard, markRestoreBoard } from "../services/canvas-board-marks";
import { snapDragChanges, SNAP_THRESHOLD_PX } from "../services/canvas-snapping";
import { canvasSnapStore } from "../services/canvas-snap-store";
import { arrangeCanvasNodes, type ArrangeBox } from "../services/canvas-arrange";
import { focusCanvasLayout } from "../services/canvas-focus-layout";
import { canonicalCanvasNodes } from "../services/canvas-canonical-layout";
import {
  CANVAS_MOTION,
  ENTER_BURST_WINDOW_MS,
  ENTER_STAGGER_MAX_SLOTS,
  ENTER_STAGGER_STEP_MS,
  LEAVE_STAGGER_MAX_TOTAL_MS,
  LEAVE_STAGGER_STEP_MS,
  canvasMotionEnabled,
  holdCanvasNodeEnter,
} from "../services/canvas-motion";
import { frameGridLayout, renumberAutoFrameTitles, swapFramesInOrder } from "../services/canvas-frame-grid";
import { clampFrameChanges, detachOrphanedMembers, frameDragChanges, frameIdOf, restoreMemberships } from "../services/canvas-frames";
import { activeFrameCanvasKey, canvasActiveFrameStore } from "../services/canvas-active-frame";
import { canvasFrameRetileStore } from "../services/canvas-frame-retile-store";
import { placeNewWindowNode, wrapLooseWindowsInFrame, type NewNodeFrameHints } from "../services/canvas-frame-target";
import { frameBoxOf } from "../services/canvas-frame-space";
import { useCanvasNodeClose } from "./useCanvasNodeClose";
import { useCanvasFrameOps } from "./useCanvasFrameOps";
import { createAgentNode } from "../services/canvas-agent-node";
import { shuffled, uniqueAgentName } from "@/lib/agent-catalog";
import { currentNamePool } from "@/lib/agent-naming";
import { isolateAgentNode, gitIsolationDepsFor } from "../services/agent-isolation";
import { getActiveProjectLocation } from "../services/canvas-active-project";
import { childPositionNear, cascadePosition, DEFAULT_SKILLS_SIZE, DEFAULT_SKILL_SIZE, DEFAULT_TERMINAL_SIZE } from "../services/canvas-node-placement";
import { claimRunMembers, runNodePlacement } from "../services/run-node";
import { contextNode, criticNode, factoryNode, fileNode, hostCellNode, humanGateNode, musicNode, noteNode, planNode, recordToNode, runNode, shapeNode, skillNode, skillPreviewData, skillsNode, taskNode, teamNode, terminalNode } from "../services/canvas-node-factory";
import type { CanvasShapeKind, CanvasShapeStyle } from "../types/canvas";
import { markNoteSpawned } from "../services/nodes/note-spawn-focus";
import { useCanvasEdgeOps } from "./useCanvasEdgeOps";
import { useCanvasBrowserNodes } from "./useCanvasBrowserNodes";
import type { DrawApplication } from "../services/agent-draw/canvas-draw-runtime";
import { applyDrawApplication, captureRestore, clearDraftFlags, revertDraftBatch } from "../services/agent-draw/canvas-draw-commit";
import { recordDraftBatch, resolveDraftBatch, type DraftBatch } from "../services/agent-draw/agent-draw-ledger";

/** Human summary of a draw batch for the Apply/Discard pill, e.g. "5 shapes · 4 connectors". */
function summarizeDrawReceipt({ receipt }: DrawApplication): string {
  const parts: string[] = [];
  if (receipt.created) parts.push(`${receipt.created} shape${receipt.created === 1 ? "" : "s"}`);
  if (receipt.connectors) parts.push(`${receipt.connectors} connector${receipt.connectors === 1 ? "" : "s"}`);
  if (receipt.updated) parts.push(`${receipt.updated} updated`);
  if (receipt.deleted) parts.push(`${receipt.deleted} deleted`);
  return parts.join(" · ") || "0 changes";
}

function isCanvasPoint(value: unknown): value is { x: number; y: number } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if ("nativeEvent" in candidate || "currentTarget" in candidate || "preventDefault" in candidate) return false;
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

export function useCanvasNodes(
  rootDirRef: { current: string },
  scheduleAutosave: (nodes: Node[], edges: Edge[]) => void,
  activeProjectIdRef: { current: string | null } = { current: null },
) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Monotonically increasing counters for terminal/agent display numbers.
  const terminalCounterRef = useRef(0);
  const agentCounterRef = useRef(0);
  const noteCounterRef = useRef(0);
  const shapeCounterRef = useRef(0);

  // Mirror into refs so callbacks always see current values without stale closures.
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const autosaveRef = useRef(scheduleAutosave);
  const noteContentRef = useRef<Map<string, string>>(new Map());

  useLayoutEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
    autosaveRef.current = scheduleAutosave;
  }, [nodes, edges, scheduleAutosave]);

  const { removeNode, removeAllNodes, closeError, waitForNodeCloses, onBeforeDelete } = useCanvasNodeClose({
    nodesRef, edgesRef, projectIdRef: activeProjectIdRef, autosaveRef, setNodes, setEdges,
  });

  // ── Change handlers ────────────────────────────────────────────────────────

  const handleNodesChange = useCallback<OnNodesChange>(
    (changes) => {
      // Alignment snapping: a single dragged shape magnetizes to its peers' edges/centers
      // BEFORE group propagation, so grouped siblings follow the snapped position. Threshold is
      // screen-space (÷ zoom); holding ⌘/Ctrl bypasses (canvasSnapStore.config, set by CanvasPage).
      for (const change of changes) {
        if (change.type === "remove") void removeNode(change.id);
      }
      let effective: typeof changes = changes.filter((change) => change.type !== "remove");
      if (canvasSnapStore.config.bypass) {
        canvasSnapStore.setGuides([]);
      } else {
        const snap = snapDragChanges(effective, nodesRef.current, SNAP_THRESHOLD_PX / canvasSnapStore.config.zoom);
        effective = snap.changes;
        canvasSnapStore.setGuides(snap.guides, snap.gaps);
      }
      // Frames never overlap: a dragged or resized Frame stops at another Frame's edge (before the carry).
      effective = clampFrameChanges(nodesRef.current, effective);
      // Frame cohesion: dragging a Frame carries its members (any kind) by the same delta.
      const synthetic = frameDragChanges(nodesRef.current, effective);
      onNodesChange(synthetic.length > 0 ? [...effective, ...synthetic] : effective);
      setNodes((nds) => {
        autosaveRef.current(nds, edgesRef.current);
        return nds;
      });
    },
    [onNodesChange, setNodes, removeNode],
  );

  const handleEdgesChange = useCallback<OnEdgesChange>(
    (changes) => {
      onEdgesChange(changes);
      setEdges((eds) => { autosaveRef.current(nodesRef.current, eds); return eds; });
    },
    [onEdgesChange, setEdges],
  );

  const edgeOps = useCanvasEdgeOps({ setEdges, nodesRef, edgesRef, autosaveRef });

  // ── Node CRUD ───────────────────────────────────────────────────────────────

  // Enter-burst stagger: nodes created in one rapid burst ("open 3 agents") cascade in
  // instead of popping simultaneously. Each creation within the burst window gets an
  // increasing --canvas-enter-delay, which node-shell.css feeds to the mount animation.
  // The style var is transient — snapshot records don't persist node style, so a reload
  // mounts clean. Called OUTSIDE setNodes updaters (it mutates the burst ref).
  const enterBurstRef = useRef({ last: Number.NEGATIVE_INFINITY, count: 0 });
  const nextEnterDelayMs = useCallback((): number => {
    if (!canvasMotionEnabled()) return 0;
    const now = performance.now();
    const burst = enterBurstRef.current;
    burst.count = now - burst.last < ENTER_BURST_WINDOW_MS ? burst.count + 1 : 0;
    burst.last = now;
    const delay = Math.min(burst.count, ENTER_STAGGER_MAX_SLOTS) * ENTER_STAGGER_STEP_MS;
    // Impure by design (same reason the burst ref is read here): this is the one moment we know an
    // enter animation is about to start, so it's where the glass-blur hold is armed.
    holdCanvasNodeEnter(delay);
    return delay;
  }, []);
  const applyEnterStagger = useCallback(
    <T extends Node>(node: T, delay = nextEnterDelayMs()): T =>
      delay > 0
        ? { ...node, style: { ...node.style, "--canvas-enter-delay": `${delay}ms` } as typeof node.style }
        : node,
    [nextEnterDelayMs],
  );

  /**
   * The ONE place a new node picks its Frame (decisions 37/38): it joins the canvas's active Frame (or an
   * explicit one), or wraps itself in "Frame 1" when there is none. Pure in `nds`; the active-Frame store
   * write and the re-tile request are deferred to a microtask because a functional state updater can run
   * during render, where notifying subscribers is not allowed (both effects are idempotent).
   */
  const placeNew = useCallback(
    (nds: Node[], node: Node, hints: Omit<NewNodeFrameHints, "activeFrameId"> = {}): Node[] => {
      const canvasKey = activeFrameCanvasKey(activeProjectIdRef.current);
      const placement = placeNewWindowNode(nds, node, { ...hints, activeFrameId: canvasActiveFrameStore.get(canvasKey) });
      const { frameId, createdFrame } = placement;
      if (frameId) {
        queueMicrotask(() => {
          if (createdFrame) canvasActiveFrameStore.set(canvasKey, frameId);
          canvasFrameRetileStore.request(frameId, { kind: "open", isNote: node.type === "note" });
        });
      }
      return placement.nodes;
    },
    [activeProjectIdRef],
  );

  const appendNode = useCallback(
    (node: Node, hints?: Omit<NewNodeFrameHints, "activeFrameId">) => {
      const staggered = applyEnterStagger(node);
      setNodes((nds) => {
        const next = placeNew(nds, staggered, hints);
        autosaveRef.current(next, edgesRef.current);
        return next;
      });
    },
    [applyEnterStagger, setNodes, placeNew],
  );

  const appendChildNode = useCallback(
    (node: Node, edge: Edge) => {
      const fromParent = {
        ...node,
        style: {
          ...node.style,
          "--canvas-enter-x": "-18px",
          "--canvas-enter-y": "0px",
          "--canvas-enter-scale": "0.96",
        } as typeof node.style,
      };
      const staggered = applyEnterStagger(fromParent);
      const nextEdges = [...edgesRef.current, edge];
      setEdges(nextEdges);
      setNodes((nds) => {
        // A child (browser, task…) opens in its parent's Frame; a loose parent leaves it to the active Frame.
        const parent = nds.find((n) => n.id === edge.source);
        const next = placeNew(nds, staggered, { explicitFrameId: parent ? frameIdOf(parent) : undefined });
        autosaveRef.current(next, nextEdges);
        return next;
      });
    },
    [applyEnterStagger, setEdges, setNodes, placeNew],
  );

  const { browserCounterRef, spawnBrowserNode, spawnStandaloneBrowserNode, closeBrowserNode } = useCanvasBrowserNodes({
    appendNode, appendChildNode, nodesRef, edgesRef, setNodes, setEdges, autosaveRef,
  });

  const patchNodeData = useCallback(
    (nodeId: string, patch: Record<string, unknown>) =>
      setNodes((nds) => {
        const next = nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n));
        autosaveRef.current(next, edgesRef.current);
        return next;
      }),
    [setNodes],
  );

  /** Commit an agent draw batch to the board in ONE functional update (removes + patches +
   *  appends), so it lands atomically alongside the user's own edits and autosaves once. A
   *  draft batch is also recorded in the ledger so the Apply/Discard pill can revert it. */
  const commitAgentDraw = useCallback(
    (application: DrawApplication, opts?: { agentName?: string; summary?: string }) => {
      // Snapshot removed/patched pre-existing content BEFORE applying, so a Discard can fully undo it.
      const restore = captureRestore(nodesRef.current, edgesRef.current, application);
      const merged = applyDrawApplication(nodesRef.current, edgesRef.current, application);
      setEdges(merged.edges);
      setNodes(() => { autosaveRef.current(merged.nodes, merged.edges); return merged.nodes; });
      if (application.draft) {
        recordDraftBatch({
          batchId: application.batchId,
          nodeIds: application.createdIds,
          edgeIds: application.edgeIds,
          summary: opts?.summary ?? summarizeDrawReceipt(application),
          ...(opts?.agentName ? { agentName: opts.agentName } : {}),
          restore,
        });
      }
    },
    [setNodes, setEdges],
  );

  /** Accept a draft batch: un-dim its nodes/edges (strip the draft flag) and clear the ledger entry. */
  const applyDraftBatch = useCallback(
    (batch: DraftBatch) => {
      const next = clearDraftFlags(nodesRef.current, edgesRef.current, batch);
      setEdges(next.edges);
      setNodes(() => { autosaveRef.current(next.nodes, next.edges); return next.nodes; });
      resolveDraftBatch(batch.batchId);
    },
    [setNodes, setEdges],
  );

  /** Discard a draft batch: undo everything it did — remove what it created AND restore what it
   *  removed or patched (the true inverse) — then clear the ledger entry. */
  const discardDraftBatch = useCallback(
    (batch: DraftBatch) => {
      const next = revertDraftBatch(nodesRef.current, edgesRef.current, batch);
      setEdges(next.edges);
      setNodes(() => { autosaveRef.current(next.nodes, next.edges); return next.nodes; });
      resolveDraftBatch(batch.batchId);
    },
    [setNodes, setEdges],
  );

  /** Tag a node's ReactFlow wrapper with the leaving class so its close animation plays
   *  before removal (CSS: `.canvas-node-leaving .canvas-node`). Transient — not autosaved. */
  const markNodeLeaving = useCallback(
    (nodeId: string) =>
      setNodes((nds) => nds.map((n) =>
        n.id === nodeId && !(n.className ?? "").split(" ").includes("canvas-node-leaving")
          ? { ...n, className: [n.className, "canvas-node-leaving"].filter(Boolean).join(" ") }
          : n,
      )),
    [setNodes],
  );

  /** Tag EVERY node as leaving with a cascading per-node delay (close-all). Each wrapper gets
   *  `canvas-node-leaving` plus a `--canvas-leave-delay` style var the CSS feeds to the leave
   *  animation. Returns the total ms until the LAST node finishes, so the dispatcher knows when
   *  to actually clear the graph (0 = nothing to animate). Transient — not autosaved. */
  const markAllNodesLeaving = useCallback((): number => {
    const count = nodesRef.current.length;
    if (count === 0) return 0;
    const step = Math.min(LEAVE_STAGGER_STEP_MS, LEAVE_STAGGER_MAX_TOTAL_MS / count);
    setNodes((nds) => nds.map((n, i) => ({
      ...n,
      className: (n.className ?? "").split(" ").includes("canvas-node-leaving")
        ? n.className
        : [n.className, "canvas-node-leaving"].filter(Boolean).join(" "),
      style: { ...n.style, "--canvas-leave-delay": `${Math.round(i * step)}ms` } as typeof n.style,
    })));
    return Math.round((count - 1) * step) + CANVAS_MOTION.leaveMs;
  }, [setNodes]);

  const handleNoteChange = useCallback(
    (nodeId: string, content: string, editedBy?: string, editedAt: number = Date.now()) => {
      noteContentRef.current.set(nodeId, content);
      // editedAt / editedBy feed the note footer's "Edited by …" line and are persisted with the
      // note. A user edit passes no author, which clears an agent's name from the footer. An agent
      // write passes its own editedAt so the value it reports back is exactly the stored one.
      patchNodeData(nodeId, { content, editedAt, editedBy });
    },
    [patchNodeData],
  );
  const handleCwdChange = useCallback((nodeId: string, cwd: string) => patchNodeData(nodeId, { cwd }), [patchNodeData]);
  const handleWorktreeChange = useCallback(
    (nodeId: string, branch: string | null, path: string | null) =>
      patchNodeData(nodeId, { assignedWorktree: branch, assignedWorktreePath: path }),
    [patchNodeData],
  );
  const handlePlanChange = useCallback((nodeId: string, patch: PlanNodePatch) => patchNodeData(nodeId, patch as Record<string, unknown>), [patchNodeData]);

  const focusNode = useCallback(
    (nodeId: string) =>
      setNodes((nds) => nds.map((node) => {
        const selected = node.id === nodeId;
        return node.selected === selected ? node : { ...node, selected };
      })),
    [setNodes],
  );

  const addTerminalNode = useCallback((at?: { x: number; y: number }, frameId?: string) => {
    terminalCounterRef.current += 1;
    const id = crypto.randomUUID();
    const created = terminalNode({
      id,
      cwd: rootDirRef.current,
      terminalNumber: terminalCounterRef.current,
      position: isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length),
      activeProjectId: activeProjectIdRef.current,
    });
    // A named Frame wins; otherwise the active one (decision 38). Same first-free-slot placement either way.
    appendNode(created, { explicitFrameId: frameId });
    return id;
  }, [activeProjectIdRef, appendNode, rootDirRef]);

  /**
   * A terminal that runs a program rather than a shell: a task delegated from the Dock's Tasks
   * (S4b). Returns the runtime pane id beside the node id, because that is the key the terminal
   * session registry knows it by, and so what delegation waits on.
   */
  const addLaunchedTerminalNode = useCallback(
    (opts: { cwd: string; launchCommand: string[]; label?: string; frameId?: string; spawnTaskKey?: string; claudeAccount?: string }) => {
      terminalCounterRef.current += 1;
      const id = crypto.randomUUID();
      const created = terminalNode({
        id,
        cwd: opts.cwd,
        terminalNumber: terminalCounterRef.current,
        label: opts.label,
        position: cascadePosition(nodesRef.current.length),
        activeProjectId: activeProjectIdRef.current,
        launchCommand: opts.launchCommand,
        spawnTaskKey: opts.spawnTaskKey,
        claudeAccount: opts.claudeAccount,
      });
      // A task's cell stays loose until its Frame exists, as an agent's task spawn does.
      appendNode(created, { explicitFrameId: opts.frameId, hasTask: Boolean(opts.spawnTaskKey) });
      return { id, runtimePaneId: (created.data as { runtimePaneId: string }).runtimePaneId };
    },
    [activeProjectIdRef, appendNode],
  );

  /**
   * Take over a cell the machine's Standalone Host is already running.
   *
   * Nothing is started: the node attaches to that cell's tmux session, so the cell keeps the life it
   * had — including the one it was given from a phone. That is the whole of adoption, and it is why
   * the node carries the pane id rather than a command.
   */
  const addAdoptedCellNode = useCallback(
    (cell: { paneId: string; cwd: string; label: string }, at?: { x: number; y: number }) => {
      terminalCounterRef.current += 1;
      const id = crypto.randomUUID();
      appendNode(terminalNode({
        id,
        // The host's own cwd, not the board's: an adopted cell may be in a different directory on
        // that machine, and the node's header is the only place the operator can see which.
        cwd: cell.cwd || rootDirRef.current,
        terminalNumber: terminalCounterRef.current,
        label: cell.label,
        position: isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length),
        activeProjectId: activeProjectIdRef.current,
        adoptedPaneId: cell.paneId,
      }));
      return id;
    },
    [activeProjectIdRef, appendNode, rootDirRef],
  );

  /**
   * Adopt a cell the machine's host runs **without** a terminal, as a conversation node.
   *
   * The sibling of `addAdoptedCellNode`, and a separate one because there is nothing to attach
   * to: such a cell is run in memory by the host, so the node reads its turns and sends prompts
   * rather than owning a PTY. It does not increment the terminal counter — it is not one.
   */
  const addHostCellNode = useCallback(
    (cell: { paneId: string; cwd: string; label: string; provider: string }, at?: { x: number; y: number }) => {
      const id = crypto.randomUUID();
      appendNode(hostCellNode({
        id,
        position: isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length),
        adoptedPaneId: cell.paneId,
        cwd: cell.cwd,
        label: cell.label,
        provider: cell.provider,
      }));
      return id;
    },
    [appendNode],
  );

  // Instantiate a reusable Agent Definition as a headless agent node. `at` (viewport-centre
  // flow coords) keeps it in view; falls back to a cascade.
  const addAgentNode = useCallback(
    (def: AgentDefinition, at?: { x: number; y: number }, options?: { isolate?: boolean; teamLabel?: string; initialTask?: string; frameId?: string; spawnTask?: SpawnTaskStamp; account?: string }) => {
      const id = crypto.randomUUID();
      agentCounterRef.current += 1;
      const cwd = rootDirRef.current;
      // Burst delay is drawn OUTSIDE the updater (impure ref) — applyEnterStagger with an
      // explicit delay is pure, so it's safe under a double-invoked StrictMode updater.
      const enterDelay = nextEnterDelayMs();
      // (Slice 03) Same reasoning as enterDelay above: the pool is now shuffled, so calling
      // currentNamePool()/shuffled() INSIDE the updater would let a double-invoked
      // StrictMode updater draw two different orders and land on two different names for one
      // spawn. Drawn once here instead; `uniqueAgentName` is pure, so using this same `pool`
      // inside the updater below is safe either way.
      const pool = shuffled(currentNamePool());
      setNodes((nds) => {
        // Dedup the handle against everything already on the canvas — including agents added earlier in
        // this SAME render tick (batch spawn, e.g. "spawn 3 cursor agents") — so two agents never share
        // a display name, which would make `target:"Rowan"` dispatch ambiguous. Computed inside the
        // updater for batch-correctness (the second/third updater sees the prior additions in `nds`).
        const taken = nds.filter((n) => n.type === "agent").map((n) => (n.data as { name?: string }).name ?? "");
        // Auto-name falls back to the user's locale-resolved pool (voice-friendly handles), while an
        // explicit def.name is still honored when free.
        const name = uniqueAgentName(def.name, taken, pool);
        const position = at ?? cascadePosition(nds.length);
        const created = applyEnterStagger(
          createAgentNode({ ...def, name }, { id, cwd, agentNumber: agentCounterRef.current, position, initialTask: options?.initialTask, account: options?.account }),
          enterDelay,
        );
        const node = options?.spawnTask
          ? { ...created, data: { ...created.data, spawnTaskKey: options.spawnTask.key, ...(options.spawnTask.title ? { spawnTaskTitle: options.spawnTask.title } : {}) } }
          : created;
        // Explicit Frame wins; a task spawn stays loose for the task grouping; else the active Frame.
        const next = placeNew(nds, node, { explicitFrameId: options?.frameId, hasTask: Boolean(options?.spawnTask) });
        autosaveRef.current(next, edgesRef.current);
        return next;
      });
      // ADR 0015: opt-in per-agent worktree isolation. Run after the node mounts
      // and patch its assignment in — git is async; the agent run reads runCwd.
      if (options?.isolate && cwd) {
        void isolateAgentNode(
          { repoPath: cwd, teamLabel: options.teamLabel ?? "agents", agentLabel: def.name },
          // The repo is wherever the project is, so the worktree has to be cut there too.
          gitIsolationDepsFor(getActiveProjectLocation()),
        )
          .then(({ branch, path, baseBranch }) =>
            patchNodeData(id, { assignedWorktree: branch, assignedWorktreePath: path, baseBranch }))
          .catch((error) => console.warn("[canvas] agent isolation failed:", error));
      }
      return id;
    },
    [applyEnterStagger, nextEnterDelayMs, setNodes, rootDirRef, patchNodeData, placeNew],
  );

  // Spawn (or focus) a Canvas Skills Node wired dashed from its parent terminal.
  const addSkillsNode = useCallback(
    (parentTerminalId: string, cwd: string) => {
      const existing = nodesRef.current.find(
        (n) => n.type === "skills" && edgesRef.current.some((e) => e.source === parentTerminalId && e.target === n.id),
      );
      if (existing) { focusNode(existing.id); return existing.id; }

      const id = crypto.randomUUID();
      const parent = nodesRef.current.find((n) => n.id === parentTerminalId);
      const pos = childPositionNear(parent, DEFAULT_SKILLS_SIZE, nodesRef.current, nodesRef.current.length);
      appendChildNode(
        skillsNode({ id, position: pos, parentTerminalId, cwd }),
        buildCanvasWireEdge({ source: parentTerminalId, target: id, kind: "skills", animated: true }),
      );
      return id;
    },
    [appendChildNode, focusNode],
  );

  // Open a Canvas Skill Node preview wired dashed from its parent (a Skills Node).
  // One preview per Skills Node: opening another skill replaces the content in place.
  const addSkillNode = useCallback(
    (skill: CanvasSkillPreview, parentId: string) => {
      const existing = nodesRef.current.find(
        (n) => n.type === "skill" && edgesRef.current.some((e) => e.source === parentId && e.target === n.id),
      );
      if (existing) {
        setNodes((nds) => nds.map((n) => {
          if (n.id === existing.id) return { ...n, selected: true, data: { ...n.data, ...skillPreviewData(skill) } };
          return n.selected ? { ...n, selected: false } : n;
        }));
        return existing.id;
      }

      const id = crypto.randomUUID();
      const parent = nodesRef.current.find((n) => n.id === parentId);
      const pos = childPositionNear(parent, DEFAULT_SKILL_SIZE, nodesRef.current, nodesRef.current.length);
      appendChildNode(
        skillNode({ id, position: pos, skill }),
        buildCanvasWireEdge({ source: parentId, target: id, kind: "skill-preview", animated: true }),
      );
      return id;
    },
    [appendChildNode, setNodes],
  );

  const addNoteNode = useCallback((at?: { x: number; y: number }, content = "", options?: { id?: string; takeCaret?: boolean }) => {
    const id = options?.id ?? crypto.randomUUID();
    noteCounterRef.current += 1;
    noteContentRef.current.set(id, content);
    // Every note the USER creates is created to be typed in — let this one take the caret. A note
    // an agent writes (takeCaret: false) must never pull the keyboard away from the user.
    if (options?.takeCaret !== false) markNoteSpawned(id);
    const position = isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length);
    appendNode(noteNode(id, position, content, undefined, noteCounterRef.current));
    return id;
  }, [appendNode]);

  const reorderNode = useCallback((id: string, direction: ArrangeDirection) => {
    setNodes((nds) => { const next = reorderNodes(nds, id, direction); autosaveRef.current(next, edgesRef.current); return next; });
  }, [setNodes]);

  // Arrange a multi-selection / group as one contiguous block (preserves relative order).
  const reorderNodesByIds = useCallback((ids: string[], direction: ArrangeDirection) => {
    setNodes((nds) => { const next = reorderNodesMany(nds, ids, direction); autosaveRef.current(next, edgesRef.current); return next; });
  }, [setNodes]);

  // Apply a layout box map (position + size) in ONE state update. ReactFlow owns node-position
  // animation via a temporary shell attribute in CanvasPage: the node wrapper's transform
  // transitions once from old→final position. We therefore commit final positions in one state
  // update instead of rAF-updating React state every frame, which was the source of
  // blink/teleport frames when xterm/browser nodes re-rendered mid-glide. Shared by arrange,
  // focus mode, and the focus-exit snapshot restore so all three morphs behave identically.
  // `automatic` (re-tile, node focus and its exit, Grid snap) keeps the write out of undo history; an arrange or a
  // Frame swap the user asked for stays one undo step.
  const applyLayoutBoxes = useCallback((targets: Map<string, ArrangeBox>, prepare?: (nds: Node[]) => Node[], automatic = true) => {
    if (targets.size === 0) return null;
    // Layout bounding box (flow coords) so the caller can frame the camera precisely.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    targets.forEach((b) => {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
    });
    const bounds = { minX, minY, width: maxX - minX, height: maxY - minY };
    const sizedToCell = (n: Node, box: ArrangeBox, position: XYPosition): Node => ({
      ...n,
      position,
      width: box.width,
      height: box.height,
      style: { ...n.style, width: box.width, height: box.height },
    });
    setNodes((nds) => {
      const next = (prepare ? prepare(nds) : nds).map((n) => {
        const tg = targets.get(n.id);
        return tg ? sizedToCell(n, tg, { x: tg.x, y: tg.y }) : n;
      });
      if (automatic) markLayoutBoard(next);
      autosaveRef.current(next, edgesRef.current);
      return next;
    });
    return bounds;
  }, [setNodes]);

  // "Arrange the canvas" (NL bar): pack nodes into an adaptive grid.
  const arrangeNodes = useCallback(
    (fit?: { width: number; height: number }) =>
      applyLayoutBoxes(arrangeCanvasNodes(nodesRef.current, fit ? { fit } : undefined), undefined, false),
    [applyLayoutBoxes],
  );

  // Focus a Frame (decision 35): tile ONLY its members to fill `fit`, the Frame box hugging them.
  // Null when there is nothing to tile; the caller then just flies the camera to the Frame.
  const arrangeFrameMembers = useCallback(
    (frameId: string, fit: { width: number; height: number }) => {
      const layout = frameFocusLayout(nodesRef.current, frameId, fit);
      return layout ? applyLayoutBoxes(layout.boxes) : null;
    },
    [applyLayoutBoxes],
  );

  // A member was added or closed in a Frame that is not focused (decision 39): tile its members inside the
  // Frame's current box. Grows when the cells cannot shrink further and steps aside from other Frames, both
  // through the same rule as focusing. The camera is the caller's business and stays where it is.
  const retileFrameMembers = useCallback(
    (frameId: string) => {
      const frame = nodesRef.current.find((n) => n.id === frameId && n.type === "frame");
      if (!frame) return null;
      const box = frameBoxOf(frame);
      if (!(box.w > 0 && box.h > 0)) return null;
      const layout = frameFocusLayout(nodesRef.current, frameId, { width: box.w, height: box.h });
      return layout ? applyLayoutBoxes(layout.boxes) : null;
    },
    [applyLayoutBoxes],
  );

  // Frame Grid (decisions 43-44): snap every Frame into its slot, members tiled like focus. `swap` first
  // exchanges two Frames' numbers (a drag onto another slot), so the move and the renumbering land in ONE update.
  const applyFrameGrid = useCallback(
    (slot: { width: number; height: number }, swap?: readonly [string, string]) => {
      const base = swap ? swapFramesInOrder(nodesRef.current, swap[0], swap[1]) : nodesRef.current;
      const layout = frameGridLayout(base, slot);
      if (!layout) return null;
      // Auto-named Frames are renumbered in the same update, so "Frame N" always matches chip N.
      applyLayoutBoxes(layout.boxes, (nds) => renumberAutoFrameTitles(swap ? swapFramesInOrder(nds, swap[0], swap[1]) : nds), !swap);
      return layout.bounds;
    },
    [applyLayoutBoxes],
  );

  // Focus mode: hero + right-rail thumbnails (canvas-focus-layout.ts).
  const applyFocusLayout = useCallback(
    (heroId: string, fit: { width: number; height: number }) =>
      // A hero inside a Frame focuses within that Frame only (decision 41).
      applyLayoutBoxes(
        frameNodeFocusLayout(nodesRef.current, heroId, fit)?.boxes ?? focusCanvasLayout(nodesRef.current, heroId, { fit }),
      ),
    [applyLayoutBoxes],
  );

  // Snapshot every tiled node's position + size so focus-exit can put the board back exactly.
  const captureLayoutSnapshot = useCallback((): Map<string, ArrangeBox> => {
    // Frame boxes too: node focus inside a Frame resizes it (decision 41).
    return layoutSnapshotOf(nodesRef.current, DEFAULT_TERMINAL_SIZE);
  }, []);

  // Restore a snapshot; nodes created after the snapshot keep their current (focus-layout) spot.
  // Bounds are the hero's Frame box when it has one: focus inside a Frame never left it (decision 41), so
  // the exit must not frame the snapshot's every Frame — that parked the Frame top-left at ~48% zoom.
  const restoreLayoutSnapshot = useCallback(
    (snapshot: Map<string, ArrangeBox>, heroId?: string) => {
      const bounds = applyLayoutBoxes(snapshot);
      const hero = heroId ? nodesRef.current.find((n) => n.id === heroId) : undefined;
      const frameId = hero ? frameIdOf(hero) : undefined;
      const frameBox = frameId ? snapshot.get(frameId) : undefined;
      if (!bounds || !frameBox) return bounds;
      return { minX: frameBox.x, minY: frameBox.y, width: frameBox.width, height: frameBox.height };
    },
    [applyLayoutBoxes],
  );

  /**
   * Put the board back to a pre-focus snapshot **synchronously**, and hand back the result.
   *
   * Exists for the project switch. Focus mode is a temporary view: the hero is stretched to the
   * viewport and everyone else is veiled. Older saves captured that projection exactly as it stood,
   * so the disk copy reopened with a fleet-sized hero beside unveiled neighbours. Fleet projection
   * no longer schedules autosave, and the save adapter canonicalizes defensively as well.
   *
   * `setNodes` alone is not enough here: the save reads `board.nodes` from the closure, one render
   * behind, so the caller needs the settled array in hand. No autosave — the caller IS the save.
   */
  const settleLayoutSnapshot = useCallback((snapshot: Map<string, ArrangeBox> | null): Node[] => {
    const next = canonicalCanvasNodes(nodesRef.current, snapshot);
    nodesRef.current = next;
    setNodes(next);
    return next;
  }, [setNodes]);

  const {
    createFrame, addEmptyFrame, addFrameInBox, applyFrameMembership, sendNodesToFrame,
    renameFrameNode, recolorFrameNode, fitFrameNode, deleteFrameAndContents, dissolveFrame,
  } = useCanvasFrameOps({ setNodes, nodesRef, edgesRef, autosaveRef, removeNode });

  // Replace the current selection set (used to grow a click into a whole group).
  const setSelectedNodes = useCallback((ids: Set<string>) => {
    setNodes((nds) => nds.map((n) => {
      const selected = ids.has(n.id);
      return n.selected === selected ? n : { ...n, selected };
    }));
  }, [setNodes]);

  // Undo/redo restore path (useShapeHistory): swap the shape subset — nodes AND the connectors
  // between them — back in, through the same autosave choke point as every other mutation.
  const restoreShapeSnapshot = useCallback((snapshot: ShapeSnapshot) => {
    const nextEdges = restoreShapeEdges(edgesRef.current, nodesRef.current, snapshot.edges);
    setEdges(nextEdges);
    setNodes((nds) => {
      // An undo that takes a Frame away (its create undone) must not leave members pointing at it.
      const next = markRestoreBoard(detachOrphanedMembers(restoreMemberGeometry(
        restoreMemberships(restoreShapes(nds, snapshot.placements), snapshot.memberships),
        snapshot.geometry,
      )));
      autosaveRef.current(next, nextEdges);
      return next;
    });
  }, [setEdges, setNodes]);

  const addShapeNode = useCallback((shape: CanvasShapeKind, at?: { x: number; y: number }, size?: { w: number; h: number }, points?: Array<[number, number]>, style?: CanvasShapeStyle) => {
    const id = crypto.randomUUID();
    shapeCounterRef.current += 1;
    const position = isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length);
    appendNode(shapeNode({ id, position, shape, shapeNumber: shapeCounterRef.current, ...(size ? { size } : {}), ...(points ? { points } : {}), ...(style ? { style } : {}) }));
    return id;
  }, [appendNode]);

  // Append pre-built shape nodes (Duplicate) in ONE state update, numbering each from the counter.
  const addShapeNodes = useCallback((shapes: Node[]) => {
    if (shapes.length === 0) return;
    const numbered = shapes.map((n) => {
      shapeCounterRef.current += 1;
      return { ...n, data: { ...(n.data as Record<string, unknown>), shapeNumber: shapeCounterRef.current } };
    });
    setNodes((nds) => { const next = [...nds, ...numbered]; autosaveRef.current(next, edgesRef.current); return next; });
  }, [setNodes]);

  // A pasted/dropped image becomes an Excalidraw-style image shape (bitmap held in the note-asset
  // store, keyed by imageAssetUri). Sized by the caller from the image's intrinsic dimensions.
  const addImageShapeNode = useCallback((opts: {
    assetUri: string;
    alt?: string;
    naturalWidth?: number;
    naturalHeight?: number;
    size: { w: number; h: number };
    position: { x: number; y: number };
  }) => {
    const id = crypto.randomUUID();
    shapeCounterRef.current += 1;
    appendNode(shapeNode({
      id,
      position: opts.position,
      shape: "image",
      shapeNumber: shapeCounterRef.current,
      imageAssetUri: opts.assetUri,
      ...(opts.alt !== undefined ? { imageAlt: opts.alt } : {}),
      ...(opts.naturalWidth !== undefined ? { imageNaturalWidth: opts.naturalWidth } : {}),
      ...(opts.naturalHeight !== undefined ? { imageNaturalHeight: opts.naturalHeight } : {}),
      size: opts.size,
    }));
    return id;
  }, [appendNode]);

  // Morph a NoteNode into a TaskNode in-place: same ID and position, type changes to "task".
  // Edges connected to the note are preserved because the node ID does not change.
  const morphNoteToTask = useCallback(
    (noteId: string, draft: SmartConvertDraft) => {
      setNodes((nds) => {
        const note = nds.find((n) => n.id === noteId);
        if (!note) return nds;
        const size = note.width && note.height ? { w: note.width, h: note.height } : undefined;
        const morphed = taskNode({
          id: note.id,
          position: note.position,
          cwd: rootDirRef.current,
          title: draft.title,
          description: typeof note.data.content === "string" ? note.data.content : "",
          intent: draft.intent,
          taskClass: draft.taskClass,
          when: draft.when,
          acceptanceCriteria: draft.acceptanceCriteria,
          size,
        });
        const next = nds.map((n) => (n.id === noteId ? morphed : n));
        autosaveRef.current(next, edgesRef.current);
        return next;
      });
    },
    [setNodes, rootDirRef],
  );

  const addPlanNode = useCallback((at?: { x: number; y: number }) => {
    const id = crypto.randomUUID();
    appendNode(planNode({ id, position: isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length), cwd: rootDirRef.current }));
    return id;
  }, [appendNode, rootDirRef]);

  // `taskId` + `taskWorkspaceId` link the node to a stored BridgeTask (the "From Tasks…" picker, S4);
  // without both the node stays canvas-only and its dispatch prompt carries no completion callback.
  const addTaskNode = useCallback((seed?: { title?: string; description?: string; taskId?: string; taskWorkspaceId?: string }, at?: { x: number; y: number }) => {
    const id = crypto.randomUUID();
    appendNode(taskNode({
      id,
      position: isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length),
      cwd: rootDirRef.current,
      title: seed?.title,
      description: seed?.description,
      taskId: seed?.taskId,
      taskWorkspaceId: seed?.taskWorkspaceId,
    }));
    return id;
  }, [appendNode, rootDirRef]);

  const addContextNode = useCallback((at?: { x: number; y: number }) => {
    const id = crypto.randomUUID();
    appendNode(contextNode({ id, position: isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length) }));
    return id;
  }, [appendNode]);

  const addCriticNode = useCallback((at?: { x: number; y: number }) => {
    const id = crypto.randomUUID();
    appendNode(criticNode({ id, position: isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length), cwd: rootDirRef.current }));
    return id;
  }, [appendNode, rootDirRef]);

  // A Run Node sits above the members it owns. Membership is re-claimed here, at the write, so a
  // node already in another run is never added twice even if the caller's list was stale.
  const addRunNode = useCallback((memberIds: string[]) => {
    const current = nodesRef.current;
    const claimed = claimRunMembers(current, memberIds);
    if (claimed.length === 0) return null;
    const members = current.filter((n) => claimed.includes(n.id));
    const id = crypto.randomUUID();
    appendNode(runNode({ id, position: runNodePlacement(members), memberIds: claimed }));
    return id;
  }, [appendNode]);

  const addMusicNode = useCallback((at?: { x: number; y: number }) => {
    const id = crypto.randomUUID();
    appendNode(musicNode({ id, position: isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length) }));
    return id;
  }, [appendNode]);

  const addFactoryNode = useCallback((run: { repo: string; issue: number | string; title: string }, at?: { x: number; y: number }) => {
    const id = crypto.randomUUID();
    appendNode(factoryNode({ id, position: isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length), ...run }));
    return id;
  }, [appendNode]);

  /** A File Node for `path`; a file already on the board is not duplicated, its node id comes back instead. */
  const addFileNode = useCallback((path: string, at?: { x: number; y: number }) => {
    const existing = nodesRef.current.find((n) => n.type === "file" && n.data?.path === path);
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    appendNode(fileNode({ id, position: isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length), path }));
    return id;
  }, [appendNode]);

  const addHumanGateNode = useCallback((at?: { x: number; y: number }) => {
    const id = crypto.randomUUID();
    appendNode(humanGateNode({ id, position: isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length) }));
    return id;
  }, [appendNode]);

  const addTeamNode = useCallback((at?: { x: number; y: number }) => {
    const id = crypto.randomUUID();
    appendNode(teamNode({ id, position: isCanvasPoint(at) ? at : cascadePosition(nodesRef.current.length), cwd: rootDirRef.current }));
    return id;
  }, [appendNode, rootDirRef]);

  // Spawn a terminal node wired from a parent (e.g. a task) with a triggers edge, in one commit.
  const spawnTerminalChild = useCallback(
    (opts: { at: { x: number; y: number }; cwd: string; parentId: string; label?: string }) => {
      terminalCounterRef.current += 1;
      const id = crypto.randomUUID();
      appendChildNode(
        terminalNode({
          id,
          cwd: opts.cwd,
          terminalNumber: terminalCounterRef.current,
          position: opts.at,
          activeProjectId: activeProjectIdRef.current,
        }),
        // Default label to "" (no label) for terminal spawns — "triggers" is agent-harness semantics,
        // not meaningful for terminal lineage. Callers can pass a custom label (e.g. worktree branch).
        buildCanvasWireEdge({ source: opts.parentId, target: id, kind: "triggers", animated: true, label: opts.label ?? "" }),
      );
      return id;
    },
    [appendChildNode, activeProjectIdRef],
  );

  // Append a dispatched subgraph (agent nodes + wires) in one commit so autosave runs once.
  const appendDispatch = useCallback(
    (newNodes: Node[], newEdges: Edge[]) => {
      // One burst slot per node so a dispatched team cascades in like a manual batch.
      const staggered = newNodes.map((n) => applyEnterStagger(n));
      const nextEdges = [...edgesRef.current, ...newEdges];
      setEdges(nextEdges);
      setNodes((nds) => {
        const next = staggered.reduce<Node[]>((acc, n) => placeNew(acc, n), nds);
        autosaveRef.current(next, nextEdges);
        return next;
      });
    },
    [applyEnterStagger, setEdges, setNodes, placeNew],
  );

  // ── Snapshot hydration ────────────────────────────────────────────────────

  const loadSnapshot = useCallback(
    (snap: CanvasSnapshot) => {
      noteContentRef.current = new Map(
        snap.nodes.filter((n): n is CanvasNoteNodeRecord => n.type === "note").map((n) => [n.id, n.content]),
      );
      // Restore counters to the max number in the snapshot so new nodes never duplicate one.
      const maxNum = snap.nodes
        .filter((n) => n.type === "terminal")
        .reduce((acc, n) => Math.max(acc, (n as CanvasTerminalNodeRecord).terminalNumber ?? 0), 0);
      terminalCounterRef.current = Number("terminalCounter" in snap ? snap.terminalCounter : maxNum);
      const maxAgentNum = snap.nodes
        .filter((n) => n.type === "agent")
        .reduce((acc, n) => Math.max(acc, (n as { agentNumber?: number }).agentNumber ?? 0), 0);
      agentCounterRef.current = Number(snap.agentCounter ?? maxAgentNum);
      let nextLegacyNoteNumber = 1;
      const numberedNodes = snap.nodes.map((record) => {
        if (record.type !== "note") return record;
        const noteNumber = record.noteNumber ?? nextLegacyNoteNumber;
        nextLegacyNoteNumber = Math.max(nextLegacyNoteNumber, noteNumber + 1);
        return { ...record, noteNumber };
      });
      noteCounterRef.current = Number(snap.noteCounter ?? Math.max(0, nextLegacyNoteNumber - 1));
      const maxBrowserNum = snap.nodes
        .filter((n) => n.type === "browser")
        .reduce((acc, n) => Math.max(acc, (n as { browserNumber?: number }).browserNumber ?? 0), 0);
      browserCounterRef.current = Number(snap.browserCounter ?? maxBrowserNum);
      const maxShapeNum = snap.nodes
        .filter((n) => n.type === "shape")
        .reduce((acc, n) => Math.max(acc, (n as { shapeNumber?: number }).shapeNumber ?? 0), 0);
      shapeCounterRef.current = Number(snap.shapeCounter ?? maxShapeNum);

      // Always a Frame (decision 37): a canvas that opens with loose windows and no Frame gets them wrapped
      // in "Frame 1", fit, no toast. It is saved with the next autosave; until then it is derived again
      // identically (deterministic id), so a reload without changes cannot drift.
      // Every node, the wrapping Frame included, is tagged restored so none replays the enter choreography.
      setNodes(wrapLooseWindowsInFrame(numberedNodes.map((record) => recordToNode(record, snap.rootDir, activeProjectIdRef.current)))
        .map((node) => ({ ...node, className: [node.className, "canvas-node-restored"].filter(Boolean).join(" ") })));
      const typeById = new Map(snap.nodes.map((n) => [n.id, n.type]));
      setEdges(snap.edges.map((e) => {
        const kind = restoredEdgeKind(e.kind, typeById.get(e.source), typeById.get(e.target));
        return buildCanvasWireEdge({
          id: e.id,
          source: e.source,
          target: e.target,
          kind,
          // Restore the dash-flow animation — non-default wires animate (mirrors edge ops).
          animated: kind !== "default",
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
          // Restore user-set label override (present means caller explicitly chose it, even "").
          ...(typeof e.label === "string" ? { label: e.label } : {}),
        });
      }));
    },
    [activeProjectIdRef, browserCounterRef, setNodes, setEdges],
  );

  return {
    nodes, edges,
    onNodesChange: handleNodesChange, onBeforeDelete,
    onEdgesChange: handleEdgesChange,
    ...edgeOps,
    removeNode, markNodeLeaving, markAllNodesLeaving, removeAllNodes, closeError, waitForNodeCloses, handleNoteChange, handleCwdChange, handleWorktreeChange, handlePlanChange, focusNode,
    addTerminalNode, addLaunchedTerminalNode, addAdoptedCellNode, addHostCellNode, addNoteNode, addShapeNode, addShapeNodes, addImageShapeNode, reorderNode, reorderNodesByIds, arrangeNodes, arrangeFrameMembers, retileFrameMembers, applyFrameGrid, applyFocusLayout, captureLayoutSnapshot, restoreLayoutSnapshot, settleLayoutSnapshot, createFrame, addEmptyFrame, addFrameInBox, renameFrameNode, recolorFrameNode, fitFrameNode, deleteFrameAndContents, dissolveFrame, applyFrameMembership, sendNodesToFrame, setSelectedNodes, addSkillsNode, addSkillNode, addAgentNode, addPlanNode, addTaskNode, addContextNode, addCriticNode, addHumanGateNode, addTeamNode, addMusicNode, addFactoryNode, addFileNode, addRunNode,
    morphNoteToTask,
    restoreShapeSnapshot,
    commitAgentDraw, applyDraftBatch, discardDraftBatch,
    appendDispatch, spawnTerminalChild, patchNodeData,
    spawnBrowserNode, spawnStandaloneBrowserNode, closeBrowserNode,
    loadSnapshot,
    noteContentRef,
    terminalCounterRef,
    agentCounterRef,
    noteCounterRef,
    browserCounterRef,
    shapeCounterRef,
  };
}
