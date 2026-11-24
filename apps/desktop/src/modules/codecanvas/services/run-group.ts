import type { Node } from "@xyflow/react";
import { isRunnableNodeType } from "./canvas-run-scheduler";

/**
 * An open Run Node drawn as a group (#74): the outline around its members, and the drop rule that
 * changes its members. Pure — membership stays `memberIds` data on the Run Node, never React Flow
 * `parentId` and never the shape grouping of `canvas-grouping.ts`.
 */

/** Space between the members and the outline. */
export const RUN_GROUP_PAD = 24;
/** The header row above the members, inside the outline. */
export const RUN_GROUP_HEADER = 40;

export interface RunGroupBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A node's box in flow coordinates. Canvas nodes have no `parentId`, so `position` is absolute. */
export function nodeRect(node: Node): Rect {
  return {
    x: node.position.x,
    y: node.position.y,
    w: node.measured?.width ?? node.width ?? 0,
    h: node.measured?.height ?? node.height ?? 0,
  };
}

/** The outline around `members`: their union, padded, with room for the header on top. Null with no member. */
export function runGroupBox(members: readonly Rect[]): RunGroupBox | null {
  if (members.length === 0) return null;
  const left = Math.min(...members.map((r) => r.x));
  const top = Math.min(...members.map((r) => r.y));
  const right = Math.max(...members.map((r) => r.x + r.w));
  const bottom = Math.max(...members.map((r) => r.y + r.h));
  const x = left - RUN_GROUP_PAD;
  const y = top - RUN_GROUP_PAD - RUN_GROUP_HEADER;
  return { x, y, w: right + RUN_GROUP_PAD - x, h: bottom + RUN_GROUP_PAD - y };
}

const centreOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const inside = (box: RunGroupBox, p: { x: number; y: number }) =>
  p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;

export interface RunGroupMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The room a fill-the-screen arrange keeps free around its grid so an open run's outline and header
 * stay on screen; zero when no run is open. Without it the header sat under the top bar.
 */
export function runGroupArrangeMargin(nodes: readonly Node[], tiled: (node: Node) => boolean = () => true): RunGroupMargin {
  const tiledIds = new Set(nodes.filter(tiled).map((n) => n.id));
  const open = nodes.some((n) => n.type === "run" && (n.data as { open?: unknown }).open === true
    && runInfoOf(n).memberIds.some((id) => tiledIds.has(id)));
  return open
    ? { top: RUN_GROUP_PAD + RUN_GROUP_HEADER, right: RUN_GROUP_PAD, bottom: RUN_GROUP_PAD, left: RUN_GROUP_PAD }
    : { top: 0, right: 0, bottom: 0, left: 0 };
}

/** The area a fill-the-screen grid may take once `margin` is kept free. */
export function fitInsideRunMargin(fit: { width: number; height: number }, margin: RunGroupMargin): { width: number; height: number } {
  return { width: fit.width - margin.left - margin.right, height: fit.height - margin.top - margin.bottom };
}

/** The grid's bounds grown by `margin`, so the camera frames the outline and header too. */
export function boundsWithRunMargin<B extends { minX: number; minY: number; width: number; height: number }>(bounds: B, margin: RunGroupMargin): B {
  return {
    ...bounds,
    minX: bounds.minX - margin.left,
    minY: bounds.minY - margin.top,
    width: bounds.width + margin.left + margin.right,
    height: bounds.height + margin.top + margin.bottom,
  };
}

export interface RunNodeInfo {
  id: string;
  title: string;
  memberIds: string[];
  open: boolean;
}

function runInfoOf(node: Node): RunNodeInfo {
  const d = node.data as { title?: unknown; memberIds?: unknown; open?: unknown };
  return {
    id: node.id,
    title: typeof d.title === "string" ? d.title : "Run",
    memberIds: Array.isArray(d.memberIds) ? d.memberIds.filter((m): m is string => typeof m === "string") : [],
    open: d.open === true,
  };
}

export interface OpenRunGroup extends RunNodeInfo {
  box: RunGroupBox;
}

/**
 * Every Run Node on the board, and the outline of each open one as it is right now. Taken when a
 * drag starts, these are the frozen boxes the drop is judged against: a member's outline must not
 * stretch with it, or it could never leave.
 */
export function runGroupsOf(nodes: readonly Node[]): { runs: RunNodeInfo[]; open: OpenRunGroup[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const runs = nodes.filter((n) => n.type === "run").map(runInfoOf);
  const open = runs.flatMap((run) => {
    if (!run.open) return [];
    const box = runGroupBox(run.memberIds.flatMap((id) => {
      const n = byId.get(id);
      return n ? [nodeRect(n)] : [];
    }));
    return box ? [{ ...run, box }] : [];
  });
  return { runs, open };
}

/** How a node is named in a notice: its name or title, else its type. */
export function runMemberLabel(node: Pick<Node, "type" | "data">): string {
  const d = node.data as { name?: unknown; title?: unknown } | undefined;
  const name = d?.name ?? d?.title;
  return typeof name === "string" && name.trim() ? name : node.type ?? "node";
}

export interface DroppedNode {
  id: string;
  type: string | undefined;
  label: string;
  rect: Rect;
}

export interface RunGroupDrop {
  /** The runs whose members change, with their new member list. */
  changes: { runId: string; memberIds: string[] }[];
  /** Why a drop was refused; null when nothing was refused. */
  notice: string | null;
}

/**
 * What dropping `dropped` does to the open runs, each dragged node on its own. A member whose centre
 * leaves its open run's frozen box leaves the run; a runnable node that is in no run, dropped with
 * its centre in an open run's box, joins it. `isActive` says whether a run is live or paused — its
 * members are fixed then, like its goal and cap.
 */
export function runGroupDrop(
  groups: { runs: readonly RunNodeInfo[]; open: readonly OpenRunGroup[] },
  dropped: readonly DroppedNode[],
  isActive: (runId: string) => boolean,
): RunGroupDrop {
  const members = new Map(groups.runs.map((r) => [r.id, [...r.memberIds]]));
  const changed = new Set<string>();
  let notice: string | null = null;
  const ownerOf = (nodeId: string) => groups.runs.find((r) => members.get(r.id)!.includes(nodeId));

  for (const node of dropped) {
    if (node.type === "run") continue;
    const centre = centreOf(node.rect);
    const owner = ownerOf(node.id);
    const ownerGroup = owner ? groups.open.find((g) => g.id === owner.id) : undefined;
    if (ownerGroup && inside(ownerGroup.box, centre)) continue;
    const target = groups.open.find((g) => g.id !== owner?.id && inside(g.box, centre));

    if (target && isRunnableNodeType(node.type)) {
      if (owner) {
        notice = `${node.label} is already in ${owner.title}.`;
        continue;
      }
      if (isActive(target.id)) {
        notice = `${target.title} is running — wait until it ends.`;
        continue;
      }
      members.get(target.id)!.push(node.id);
      changed.add(target.id);
      continue;
    }

    // Out: only a member of an open run leaves by dragging; a closed card never changes members.
    if (!ownerGroup) continue;
    const list = members.get(ownerGroup.id)!;
    if (isActive(ownerGroup.id)) {
      notice = `${ownerGroup.title} is running — wait until it ends.`;
      continue;
    }
    if (list.length === 1) {
      notice = "A run needs at least one node.";
      continue;
    }
    members.set(ownerGroup.id, list.filter((id) => id !== node.id));
    changed.add(ownerGroup.id);
  }

  return { changes: [...changed].map((runId) => ({ runId, memberIds: members.get(runId)! })), notice };
}
