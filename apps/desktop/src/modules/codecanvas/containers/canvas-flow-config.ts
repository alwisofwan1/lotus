import type { Edge, EdgeTypes, Node, NodeTypes } from "@xyflow/react";
import { NoteNode } from "../components/nodes/NoteNode";
import { TerminalNode } from "../components/nodes/TerminalNode";
import { CanvasSkillsNode } from "../components/nodes/CanvasSkillsNode";
import { CanvasSkillNode } from "../components/nodes/CanvasSkillNode";
import { AgentNode } from "../components/nodes/AgentNode";
import { PlanNode } from "../components/nodes/PlanNode";
import { RunNode } from "../components/nodes/RunNode";
import { TaskNode } from "../components/nodes/TaskNode";
import { ContextNode } from "../components/nodes/ContextNode";
import { CriticNode } from "../components/nodes/CriticNode";
import { HumanGateNode } from "../components/nodes/HumanGateNode";
import { TeamNode } from "../components/nodes/TeamNode";
import { BrowserNode } from "../components/nodes/BrowserNode";
import { ShapeNode } from "../components/nodes/ShapeNode";
import { MusicNode } from "../components/nodes/MusicNode";
import { HostCellNode } from "../components/nodes/HostCellNode";
import { FactoryNode } from "../components/nodes/FactoryNode";
import { FileNode } from "../components/nodes/FileNode";
import { FrameNode } from "../components/nodes/FrameNode";
import { CanvasWireEdge } from "../components/edges/CanvasWireEdge";
import type { DispatchCanvasNodeCommand } from "../services/nodes/canvas-node-command";

export const CANVAS_NODE_TYPES: NodeTypes = {
  terminal: TerminalNode,
  note: NoteNode,
  skills: CanvasSkillsNode,
  skill: CanvasSkillNode,
  agent: AgentNode,
  plan: PlanNode,
  run: RunNode,
  task: TaskNode,
  context: ContextNode,
  critic: CriticNode,
  "human-gate": HumanGateNode,
  team: TeamNode,
  browser: BrowserNode,
  shape: ShapeNode,
  music: MusicNode,
  "host-cell": HostCellNode,
  factory: FactoryNode,
  file: FileNode,
  frame: FrameNode,
};

export const CANVAS_EDGE_TYPES: EdgeTypes = { "canvas-wire": CanvasWireEdge };

export interface CanvasEdgeCallbacks {
  onDelete: (edgeId: string) => void;
  onLabelChange: (edgeId: string, label: string) => void;
}

export interface CanvasNodeCallbacks {
  dispatchNodeCommand: DispatchCanvasNodeCommand;
  activeProjectId?: string | null;
  isSkillApplied: (terminalId: string, skillName: string) => boolean;
  listAppliedSkills: (id: string) => string[];
  hasBrowserNode: (terminalId: string) => boolean;
  /** Persists a live agent's freshly minted session id onto its node for resume-on-reopen (ADR-0027 Phase 5). */
  persistAgentSession?: (nodeId: string, sessionId: string) => void | Promise<boolean>;
  /** Switch a node to another conversation and relaunch its runner (Session Widget, Slice 04). */
  switchAgentSession?: (nodeId: string, providerSessionId: string | null) => void;
  /** Move a Claude node to another account (mockups/account-picker-everywhere.html, decision 5). */
  switchAgentAccount?: (nodeId: string, account: string) => void;
}

export function injectCanvasEdgeCallbacks(edges: Edge[], cb: CanvasEdgeCallbacks): Edge[] {
  return edges.map((edge) => ({
    ...edge,
    data: {
      ...edge.data,
      onDelete: cb.onDelete,
      onLabelChange: cb.onLabelChange,
    },
  }));
}

export function injectCanvasNodeCallbacks(nodes: Node[], edges: Edge[], cb: CanvasNodeCallbacks): Node[] {
  const terminalIdsWithSkills = new Set(
    edges
      .filter((edge) => nodes.some((node) => node.id === edge.target && node.type === "skills"))
      .map((edge) => edge.source),
  );
  const terminalRuntimePaneIds = new Map(
    nodes
      .filter((node) => node.type === "terminal")
      .map((node) => [
        node.id,
        typeof node.data?.runtimePaneId === "string" ? node.data.runtimePaneId : node.id,
      ]),
  );
  const browserParentIdsByEdge = new Map(
    edges
      .filter((edge) => nodes.some((node) => node.id === edge.source && node.type === "terminal")
        && nodes.some((node) => node.id === edge.target && node.type === "browser"))
      .map((edge) => [edge.target, edge.source]),
  );
  return nodes.map((n) => {
    if (n.type === "note") return { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand } };
    if (n.type === "skill") return { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand } };
    if (n.type === "agent") {
      const base = Array.isArray(n.data.appliedSkills) ? (n.data.appliedSkills as string[]) : [];
      return {
        ...n,
        data: {
          ...n.data,
          dispatchCommand: cb.dispatchNodeCommand,
          projectId: cb.activeProjectId,
          hasSkillsNode: terminalIdsWithSkills.has(n.id),
          // Definition skills ∪ skills dragged onto this node (Applied-Skill Guard).
          appliedSkills: [...new Set([...base, ...cb.listAppliedSkills(n.id)])],
          onPersistSession: cb.persistAgentSession,
          onSwitchSession: cb.switchAgentSession,
          onSwitchAccount: cb.switchAgentAccount,
        },
      };
    }
    if (n.type === "browser") {
      const explicitParentTerminalId = typeof n.data?.parentTerminalId === "string" ? n.data.parentTerminalId : null;
      const parentTerminalId = explicitParentTerminalId ?? browserParentIdsByEdge.get(n.id) ?? null;
      return {
        ...n,
        data: {
          ...n.data,
          parentTerminalId,
          parentRuntimePaneId: parentTerminalId ? terminalRuntimePaneIds.get(parentTerminalId) ?? parentTerminalId : null,
          dispatchCommand: cb.dispatchNodeCommand,
        },
      };
    }
    if (n.type === "plan") return { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand } };
    if (n.type === "run") {
      const injected = { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand, projectId: cb.activeProjectId } };
      // Open (#74): the outline stands in for the card, so the card's box must not catch a click,
      // a marquee or a drag. Runtime-only — serialize never reads these fields.
      return n.data?.open === true ? { ...injected, selected: false, selectable: false, draggable: false, className: "run-node--open" } : injected;
    }
    if (n.type === "task") return { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand } };
    if (n.type === "context") return { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand, projectId: cb.activeProjectId } };
    if (n.type === "music") return { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand } };
    if (n.type === "file") return { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand } };
    if (n.type === "host-cell") return { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand } };
    if (n.type === "critic") return { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand } };
    if (n.type === "human-gate") return { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand } };
    if (n.type === "team") return { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand } };
    if (n.type === "shape") return { ...n, data: { ...n.data, dispatchCommand: cb.dispatchNodeCommand } };
    if (n.type === "skills") {
      // The parent's runner decides the skill token the list prints (`/teach` vs `$teach`)
      // and the text an apply inserts. Read it here rather than in the node so both sides
      // come from one lookup — the node only knows its parent's id.
      const parentId = typeof n.data?.parentTerminalId === "string" ? n.data.parentTerminalId : null;
      const parent = parentId ? nodes.find((node) => node.id === parentId) : undefined;
      return {
        ...n,
        data: {
          ...n.data,
          dispatchCommand: cb.dispatchNodeCommand,
          isSkillApplied: cb.isSkillApplied,
          parentRunner: parent?.data?.runner,
          parentClaudeFamily: parent?.data?.claudeFamily,
        },
      };
    }
    return {
      ...n,
      data: {
        ...n.data,
        dispatchCommand: cb.dispatchNodeCommand,
        hasSkillsNode: terminalIdsWithSkills.has(n.id),
        hasBrowserNode: cb.hasBrowserNode(n.id),
      },
    };
  });
}

// ── Identity-preserving injection ───────────────────────────────────────────────────────────────
//
// The two `inject*` functions above are pure builders: they hand back a fresh object for every
// node and edge, every call. That is correct and untestable-in-any-other-way, but calling one
// straight from the JSX made every canvas render rebuild every node's `data`.
//
// It matters most during a drag. ReactFlow emits `onNodesChange` per pointermove, so the whole
// canvas re-renders at pointer rate; with a new `data` object per node per frame, every node
// component's `memo()` misses and dragging a single Note re-rendered every Terminal and every live
// Agent on the board. `applyNodeChanges` is careful to keep the object identity of nodes it did not
// touch — the wrapper below carries that same guarantee through the injection layer, so a drag
// re-renders one node instead of all of them.
//
// The reuse test is VALUE equality, not reference equality, because the builder legitimately
// allocates: `appliedSkills` is rebuilt through a Set on every pass. Comparing the built result
// against the previous one is also what makes this safe by construction — identity is reused
// exactly when the injected node is indistinguishable from the one already on screen, so no
// caller has to remember to list its dependencies.

/** Element-wise for arrays (the builder allocates fresh ones), `===` for everything else. */
function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return false;
}

function shallowEqualRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => valueEqual(a[key], b[key]));
}

/**
 * True when `next` is indistinguishable from `prev`. `data` is compared one level deep; every
 * other field by identity — which is exactly right for the ones that move. ReactFlow hands out a
 * NEW `position` object for a dragged node and a new `measured` after a resize, so both changes
 * fall out of the `===` naturally rather than needing to be enumerated here.
 */
function injectedItemUnchanged<T extends { data?: unknown }>(prev: T, next: T): boolean {
  const prevRest = { ...prev, data: undefined } as Record<string, unknown>;
  const nextRest = { ...next, data: undefined } as Record<string, unknown>;
  if (!shallowEqualRecord(prevRest, nextRest)) return false;
  const prevData = (prev.data ?? {}) as Record<string, unknown>;
  const nextData = (next.data ?? {}) as Record<string, unknown>;
  return shallowEqualRecord(prevData, nextData);
}

function reuseById<T extends { id: string; data?: unknown }>(
  built: T[],
  cache: Map<string, T>,
): T[] {
  const next = new Map<string, T>();
  const out = built.map((item) => {
    const prev = cache.get(item.id);
    const reused = prev && injectedItemUnchanged(prev, item) ? prev : item;
    next.set(item.id, reused);
    return reused;
  });
  // Rebuilt from what is on screen, never pruned: a closed node's entry disappears with it, and a
  // reopened id cannot inherit the dead one.
  cache.clear();
  for (const [id, item] of next) cache.set(id, item);
  return out;
}

export interface CanvasFlowInjector {
  nodes(nodes: Node[], edges: Edge[], cb: CanvasNodeCallbacks): Node[];
  edges(edges: Edge[], cb: CanvasEdgeCallbacks): Edge[];
}

/**
 * One injector per canvas, created once (a `useRef`/`useMemo` in CanvasPage) and called on every
 * render. It holds the previous injected result so unchanged nodes and edges keep their identity.
 */
export function createCanvasFlowInjector(): CanvasFlowInjector {
  const nodeCache = new Map<string, Node>();
  const edgeCache = new Map<string, Edge>();
  return {
    nodes: (nodes, edges, cb) => reuseById(injectCanvasNodeCallbacks(nodes, edges, cb), nodeCache),
    edges: (edges, cb) => reuseById(injectCanvasEdgeCallbacks(edges, cb), edgeCache),
  };
}
