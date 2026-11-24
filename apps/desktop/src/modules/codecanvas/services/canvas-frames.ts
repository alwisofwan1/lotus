import type { Node, NodeChange, NodeDimensionChange, NodePositionChange } from "@xyflow/react";
import { FRAME_PAD, frameBoxAround, frameOccupiedBox } from "./canvas-frame-geometry";
import { boxesOverlap, clampFrameMove, clampFrameResize, fitBoxAvoidingFrames, frameBoxOf, placeFrameInFreeSpace } from "./canvas-frame-space";
import { frameNode } from "./canvas-node-factory";
import { autoFrameName } from "./canvas-frame-naming";
import { nextFrameColorId } from "./canvas-frame-palette";
import type { AgentNodeStatus } from "../types/canvas";

/**
 * Frame membership service (ADR-0050). A Frame is its own node painted behind its members; a
 * member is any node whose `data.frameId` names it. Positions stay absolute, one Frame per node,
 * no nesting, no ReactFlow `parentId`. Replaces the shape-only grouping service: nothing here
 * filters on node kind. All functions are pure.
 */

/** Ephemeral session-only nodes: never persisted, so never framed. */
const EPHEMERAL = new Set(["skill", "skills"]);

/** The one Frame predicate: every module that asks "is this a Frame" calls this. */
export const isFrameNode = (node: { type?: string }): boolean => node.type === "frame";
const isFrame = isFrameNode;
const isFrameable = (node: Node): boolean => !isFrame(node) && !EPHEMERAL.has(node.type ?? "");

/** The one title read: a Frame's raw title, "" when it has none. */
export function frameTitleOf(node: Node): string {
  const title = (node.data as { title?: unknown } | undefined)?.title;
  return typeof title === "string" ? title : "";
}

/**
 * Frames in the one canonical order: array order. The Frame Switcher chips, the Overview labels,
 * the hotkeys (⌥N, ⌥⇧N) and the NL "frame N" all number Frames by this list.
 */
export function framesInOrder(nodes: readonly Node[]): Node[] {
  return nodes.filter(isFrame);
}

/** The Frame a node belongs to, if any. */
export function frameIdOf(node: Node): string | undefined {
  const id = (node.data as { frameId?: unknown } | undefined)?.frameId;
  return typeof id === "string" && id ? id : undefined;
}

/** Every member of a Frame, any kind, in array order. */
export function frameMembers(nodes: readonly Node[], frameId: string): Node[] {
  return nodes.filter((n) => !isFrame(n) && frameIdOf(n) === frameId);
}

function withFrameId(node: Node, frameId: string | undefined): Node {
  const data = { ...(node.data as Record<string, unknown>) };
  if (frameId) data.frameId = frameId;
  else delete data.frameId;
  return { ...node, data };
}

const dimOf = (n: Node) => ({ w: n.measured?.width ?? n.width ?? 0, h: n.measured?.height ?? n.height ?? 0 });

export function nextFrameTitle(nodes: readonly Node[]): string {
  let max = 0;
  for (const n of nodes) {
    if (!isFrame(n)) continue;
    const match = /^Frame (\d+)$/.exec(frameTitleOf(n));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Frame ${max + 1}`;
}

/** True when the selection holds at least one node a Frame can wrap. */
export function canCreateFrame(selected: readonly Node[]): boolean {
  return selected.some(isFrameable);
}

/** True when the selection is, or belongs to, a Frame. */
export function canDissolveFrame(selected: readonly Node[]): boolean {
  return selected.some((n) => isFrame(n) || frameIdOf(n) !== undefined);
}

export interface FrameSeed {
  /** Explicit title; absent = auto-named from the members. */
  title?: string;
  /** The Lotus task this Frame groups cells for (LOT2-130). */
  taskKey?: string;
  /**
   * The members' positions are not the user's (agent task cells): when the fitted box would land on another
   * Frame, the new Frame and its members move to the nearest free space instead of the create being refused.
   */
  relocate?: boolean;
}

/** Decision 33: the most Frames one canvas gets. Every create path asks `frameCreateBlock` first. */
export const MAX_FRAMES = 4;
/** The small notice (Frame toast) shown when a create is refused for the limit. */
export const FRAME_LIMIT_NOTICE = `Maksimal ${MAX_FRAMES} Frame`;

/** True while the canvas has room for another Frame. */
export const canAddFrame = (nodes: readonly Node[]): boolean => framesInOrder(nodes).length < MAX_FRAMES;

/** Why a new Frame is refused: the limit, or null when there is room. Overlap is checked per box. */
export function frameCreateBlock(nodes: readonly Node[]): string | null {
  return canAddFrame(nodes) ? null : FRAME_LIMIT_NOTICE;
}

/** "Frame bertumpuk dengan <name>" when `box` overlaps an existing Frame (decision 34), else null. */
export function frameOverlapNotice(nodes: readonly Node[], box: { x: number; y: number; w: number; h: number }): string | null {
  const hit = framesInOrder(nodes).find((f) => boxesOverlap(frameOccupiedBox(box), frameOccupiedBox(frameBoxOf(f))));
  return hit ? `Frame bertumpuk dengan ${frameTitleOf(hit) || "Frame"}` : null;
}

export type FrameCreateResult =
  | { ok: true; nodes: Node[]; frameId: string }
  | { ok: false; reason: "nothing" | "limit" | "overlap"; message: string };

/**
 * Wrap the selected nodes (any kind) in a new Frame fit around them, unless that is refused: at the
 * Frame limit, or when the fitted box overlaps another Frame (only-padding overlaps shrink the
 * padding instead; nodes are never moved to make room). The Frame is inserted before the first
 * member so array order paints it behind. Members already in another Frame move over: one Frame
 * per node.
 */
export function tryCreateFrameFromSelection(nodes: Node[], selectedIds: Iterable<string>, newFrameId: string, seed: FrameSeed = {}): FrameCreateResult {
  const { title, taskKey, relocate } = seed;
  const sel = new Set(selectedIds);
  const targets = nodes.filter((n) => sel.has(n.id) && isFrameable(n));
  if (targets.length === 0) return { ok: false, reason: "nothing", message: "Nothing there can go in a Frame." };
  const targetIds = new Set(targets.map((n) => n.id));
  // The Frames the targets leave. They give up their place to the new one: never counted as an overlap, and
  // one left with no members is replaced (it would sit empty on top of the new Frame), so not counted at the limit.
  const sources = new Set(targets.map(frameIdOf).filter((id): id is string => Boolean(id)));
  const emptied = new Set([...sources].filter((fid) => frameMembers(nodes, fid).every((m) => targetIds.has(m.id))));
  if (framesInOrder(nodes).length - emptied.size >= MAX_FRAMES) return { ok: false, reason: "limit", message: FRAME_LIMIT_NOTICE };
  const blockers = framesInOrder(nodes).filter((f) => !sources.has(f.id));
  const boxes = targets.map((n) => ({ x: n.position.x, y: n.position.y, ...dimOf(n) }));
  let fit = fitBoxAvoidingFrames(boxes, blockers);
  let shift = { dx: 0, dy: 0 };
  if (!fit.ok && relocate) {
    // Free space against every Frame that stays where it is (a source shrinks, so it is still in the way).
    const staying = framesInOrder(nodes).filter((f) => !emptied.has(f.id));
    const wanted = frameBoxAround(boxes);
    const spot = placeFrameInFreeSpace(staying, { w: wanted.w, h: wanted.h }, { x: wanted.x + wanted.w / 2, y: wanted.y + wanted.h / 2 });
    shift = { dx: spot.x - wanted.x, dy: spot.y - wanted.y };
    fit = { ok: true, box: { ...wanted, x: spot.x, y: spot.y } };
  }
  if (!fit.ok) return { ok: false, reason: "overlap", message: `Frame bertumpuk dengan ${fit.overlapWith}` };
  const box = fit.box;
  const frame = frameNode({
    id: newFrameId,
    position: { x: box.x, y: box.y },
    title: title ?? autoFrameName(targets, nextFrameTitle(nodes)),
    colorId: nextFrameColorId(nodes),
    ...(taskKey ? { taskKey } : {}),
    size: { w: box.w, h: box.h },
  });
  const moved = (n: Node): Node =>
    shift.dx === 0 && shift.dy === 0 ? n : { ...n, position: { x: n.position.x + shift.dx, y: n.position.y + shift.dy } };
  let out: Node[] = [];
  for (const n of nodes) {
    if (emptied.has(n.id)) continue;
    if (n.id === targets[0].id) out.push(frame);
    out.push(targetIds.has(n.id) ? withFrameId(moved(n), newFrameId) : n);
  }
  // A source that keeps members hugs them again. Shrinking only ever frees space, so it skips the overlap
  // check; any overlap still left (tab strips) is settled by the Frame Grid snap that follows every create.
  for (const fid of sources) {
    if (emptied.has(fid)) continue;
    const box = frameBoxAround(frameMembers(out, fid).map(boxOf));
    out = patchFrame(out, fid, (n) => ({ ...n, position: { x: box.x, y: box.y }, width: box.w, height: box.h, style: { ...n.style, width: box.w, height: box.h } }));
  }
  return { ok: true, nodes: out, frameId: newFrameId };
}

/** `tryCreateFrameFromSelection` for callers that only want the board: an unchanged copy when refused. */
export function createFrameFromSelection(nodes: Node[], selectedIds: Iterable<string>, newFrameId: string, seed: FrameSeed = {}): Node[] {
  const r = tryCreateFrameFromSelection(nodes, selectedIds, newFrameId, seed);
  return r.ok ? r.nodes : [...nodes];
}

/**
 * Dissolve every Frame the selection touches (the Frame itself selected, or any of its members):
 * the Frame node is removed and all its members become loose, positions untouched.
 */
export function dissolveFrames(nodes: Node[], selectedIds: Iterable<string>): Node[] {
  const sel = new Set(selectedIds);
  const doomed = new Set<string>();
  for (const n of nodes) {
    if (!sel.has(n.id)) continue;
    if (isFrame(n)) doomed.add(n.id);
    else {
      const fid = frameIdOf(n);
      if (fid) doomed.add(fid);
    }
  }
  if (doomed.size === 0) return [...nodes];
  return nodes
    .filter((n) => !doomed.has(n.id))
    .map((n) => {
      const fid = frameIdOf(n);
      return fid && doomed.has(fid) ? withFrameId(n, undefined) : n;
    });
}

/**
 * Decision 34: a Frame being dragged or corner-resized stops at another Frame's edge. Rewrites the
 * incoming Frame position/resize changes; every other change passes through (node drags are never
 * clamped). Run it BEFORE `frameDragChanges` so carried members follow the clamped delta. The
 * release counts (`dragging`/`resizing: false`): xyflow's final change carries the raw pointer, and
 * skipping it let a Frame land on another on release. A change with no flag is programmatic.
 */
export function clampFrameChanges(nodes: readonly Node[], changes: readonly NodeChange[]): NodeChange[] {
  const frames = framesInOrder(nodes);
  if (frames.length < 2) return changes as NodeChange[];
  const byId = new Map(frames.map((f) => [f.id, f]));
  const othersOf = (id: string) => frames.filter((f) => f.id !== id).map(frameBoxOf);

  const resizes = new Map<string, NodeDimensionChange>();
  for (const c of changes) {
    if (c.type === "dimensions" && c.resizing !== undefined && c.dimensions && byId.has(c.id)) resizes.set(c.id, c);
  }

  return changes.map((c) => {
    if (c.type === "position" && c.position && byId.has(c.id)) {
      const from = frameBoxOf(byId.get(c.id)!);
      const resize = resizes.get(c.id);
      if (resize?.dimensions) {
        const next = clampFrameResize(from, { x: c.position.x, y: c.position.y, w: resize.dimensions.width, h: resize.dimensions.height }, othersOf(c.id));
        return { ...c, position: { x: next.x, y: next.y } };
      }
      if (c.dragging !== undefined) return { ...c, position: clampFrameMove(from, c.position, othersOf(c.id)) };
      return c;
    }
    if (c.type === "dimensions" && c.resizing !== undefined && c.dimensions && byId.has(c.id)) {
      const from = frameBoxOf(byId.get(c.id)!);
      const pos = changes.find((p): p is NodePositionChange => p.type === "position" && p.id === c.id && !!p.position);
      const next = clampFrameResize(from, { x: pos?.position?.x ?? from.x, y: pos?.position?.y ?? from.y, w: c.dimensions.width, h: c.dimensions.height }, othersOf(c.id));
      return { ...c, dimensions: { width: next.w, height: next.h } };
    }
    return c;
  });
}

/**
 * Make dragging a Frame carry its members, deterministically. For every incoming *drag* position
 * change on a Frame, emit a matching change for each member ReactFlow isn't already moving,
 * shifted by the same delta. Dragging a member moves only that member. Returns only the
 * *synthetic* changes to append; they omit `dragging` so carried members never stick in a drag
 * visual state.
 */
export function frameDragChanges(nodes: readonly Node[], changes: readonly NodeChange[]): NodePositionChange[] {
  const isDragPosition = (c: NodeChange): c is NodePositionChange =>
    c.type === "position" && c.dragging !== undefined && !!c.position;
  const drags = changes.filter(isDragPosition);
  if (drags.length === 0) return [];

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const movedIds = new Set(changes.filter((c): c is NodePositionChange => c.type === "position").map((c) => c.id));
  const membersByFrame = new Map<string, Node[]>();
  for (const n of nodes) {
    const fid = frameIdOf(n);
    if (!fid || isFrame(n)) continue;
    const list = membersByFrame.get(fid);
    if (list) list.push(n);
    else membersByFrame.set(fid, [n]);
  }

  const synthetic: NodePositionChange[] = [];
  const handled = new Set<string>();
  for (const c of drags) {
    const node = byId.get(c.id);
    if (!node || !c.position || !isFrame(node)) continue;
    const dx = c.position.x - node.position.x;
    const dy = c.position.y - node.position.y;
    if (dx === 0 && dy === 0) continue;
    for (const m of membersByFrame.get(c.id) ?? []) {
      if (movedIds.has(m.id) || handled.has(m.id)) continue;
      handled.add(m.id);
      synthetic.push({ id: m.id, type: "position", position: { x: m.position.x + dx, y: m.position.y + dy } });
    }
  }
  return synthetic;
}


// ── Drop in / out (LOT2-122) ────────────────────────────────────────────────────────────────────

const boxOf = (n: Node) => {
  const { w, h } = dimOf(n);
  return { x: n.position.x, y: n.position.y, w, h };
};

/**
 * The Frame whose box contains `point` (flow coordinates). Nested/overlapping Frames resolve to
 * the smallest one: the innermost region is the more specific answer.
 */
export function frameAtPoint(nodes: readonly Node[], point: { x: number; y: number }): Node | undefined {
  let best: Node | undefined;
  let bestArea = Infinity;
  for (const n of nodes) {
    if (!isFrame(n)) continue;
    const b = boxOf(n);
    if (point.x < b.x || point.x > b.x + b.w || point.y < b.y || point.y > b.y + b.h) continue;
    const area = b.w * b.h;
    if (area < bestArea) {
      best = n;
      bestArea = area;
    }
  }
  return best;
}

/** One node's membership transition. `undefined` = loose. */
export interface MembershipChange {
  nodeId: string;
  from: string | undefined;
  to: string | undefined;
}

/**
 * Decide membership after a drag. `dropped` are the dragged nodes carrying their FRESH positions;
 * `nodes` supplies the Frames and each node's current membership. A node joins the Frame holding
 * its centre, and is loose when its centre is in none. Frames are never members, and a member
 * whose Frame is itself being dragged is carried, not re-decided.
 */
export function membershipChangesForDrop(nodes: readonly Node[], dropped: readonly Node[]): MembershipChange[] {
  const droppedIds = new Set(dropped.map((n) => n.id));
  const current = new Map(nodes.map((n) => [n.id, n]));
  const changes: MembershipChange[] = [];
  for (const d of dropped) {
    if (!isFrameable(d)) continue;
    const from = frameIdOf(current.get(d.id) ?? d);
    if (from && droppedIds.has(from)) continue;
    const b = boxOf(d);
    const to = frameAtPoint(nodes, { x: b.x + b.w / 2, y: b.y + b.h / 2 })?.id;
    if (to !== from) changes.push({ nodeId: d.id, from, to });
  }
  return changes;
}

/** Apply membership changes forward (to the new Frame) or reverse (back to the previous one). */
export function applyMembershipChanges(nodes: Node[], changes: readonly MembershipChange[], direction: "forward" | "reverse"): Node[] {
  const target = new Map(changes.map((c) => [c.nodeId, direction === "forward" ? c.to : c.from]));
  return nodes.map((n) => (target.has(n.id) ? withFrameId(n, target.get(n.id)) : n));
}

/** "Masuk ke <Frame>" when joining a Frame, "Keluar dari <Frame>" when leaving to loose. */
export function membershipToastText(nodes: readonly Node[], change: MembershipChange): string {
  const titleOf = (id: string) => {
    const f = nodes.find((n) => n.id === id);
    return (f && frameTitleOf(f)) || "Frame";
  };
  return change.to ? `Masuk ke ${titleOf(change.to)}` : `Keluar dari ${titleOf(change.from ?? "")}`;
}

/**
 * Membership map for undo history: every non-shape, non-Frame node -> its Frame id, "" when loose.
 * Loose nodes are listed on purpose: a node that is absent from a snapshot did not exist yet, so a
 * restore must leave it alone and history must not count its arrival (a spawn straight into a Frame)
 * as a membership step. Shapes are left out because history already restores them wholesale with
 * their data. Pure data, no runtime side effects, so terminals and agents can be re-pointed safely.
 */
export function captureMemberships(nodes: readonly Node[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of nodes) {
    if (n.type === "shape" || isFrame(n)) continue;
    out[n.id] = frameIdOf(n) ?? "";
  }
  return out;
}

// ── Agent-targeted placement (LOT2-126) ─────────────────────────────────────────────────────────

export interface FrameRef {
  id: string;
  name: string;
}

/** What to look a Frame up by: an id, a 1-based position (Switcher numbering), or a name. */
export type FrameQuery = { id?: string; index?: number; name?: string };

export type FrameResolution = { ok: true; id: string; name: string } | { ok: false; error: string };

/** `exact`: ids and exact titles only (an agent's wrong guess must not drop work in the wrong area).
 *  `loose`: exact, then case-insensitive, then prefix (a person typing or speaking). */
export type FrameMatchMode = "exact" | "loose";

export const frameRefsOf = (nodes: readonly Node[]): FrameRef[] =>
  framesInOrder(nodes).map((f) => ({ id: f.id, name: frameTitleOf(f) }));

const collapse = (s: string): string => s.trim().replace(/\s+/g, " ");

/** Candidates by the first tier that hits. */
export function tieredMatches<T>(items: readonly T[], nameOf: (t: T) => string, query: string, mode: FrameMatchMode): T[] {
  const q = collapse(query);
  const exact = items.filter((i) => collapse(nameOf(i)) === q);
  if (exact.length > 0 || mode === "exact") return exact;
  const lower = q.toLowerCase();
  const ci = items.filter((i) => collapse(nameOf(i)).toLowerCase() === lower);
  if (ci.length > 0) return ci;
  return lower ? items.filter((i) => collapse(nameOf(i)).toLowerCase().startsWith(lower)) : [];
}

/**
 * The one Frame resolver (MCP spawn `frame`, NL bar, voice). An id wins over a title; ambiguity and
 * unknowns never guess. Errors are written for the caller to read back: they name the Frames that
 * do exist so an agent or person can retry.
 */
export function resolveFrame(frames: readonly FrameRef[], query: FrameQuery, mode: FrameMatchMode): FrameResolution {
  const wanted = collapse(query.id ?? query.name ?? "");
  if (frames.length === 0) {
    return { ok: false, error: wanted ? `Frame "${wanted}" not found: this canvas has no Frames.` : "This canvas has no Frames yet." };
  }
  const list = frames.map((f) => `"${f.name}" (${f.id})`).join(", ");
  if (query.index !== undefined) {
    const f = frames[query.index - 1];
    return f ? { ok: true, id: f.id, name: f.name } : { ok: false, error: `There is no Frame ${query.index}. Frames: ${list}.` };
  }
  if (!wanted) return { ok: false, error: "Which Frame?" };
  const byId = frames.find((f) => f.id === wanted);
  if (byId) return { ok: true, id: byId.id, name: byId.name };
  const hits = tieredMatches(frames, (f) => f.name, wanted, mode);
  if (hits.length === 1) return { ok: true, id: hits[0].id, name: hits[0].name };
  if (hits.length > 1) {
    return { ok: false, error: `More than one Frame matches "${wanted}": ${hits.map((h) => `"${h.name}" (${h.id})`).join(", ")}. Be more specific or pass the Frame id.` };
  }
  return { ok: false, error: `Frame "${wanted}" not found. Frames on this canvas: ${list}.` };
}

/** The MCP spawn `frame` argument: an id or an EXACT title, as `{ id }` or `{ error }` for the agent. */
export function resolveAgentFrameRef(nodes: readonly Node[], ref: string): { id: string } | { error: string } {
  const r = resolveFrame(frameRefsOf(nodes), { id: ref }, "exact");
  return r.ok ? { id: r.id } : { error: r.error };
}

const SLOT_GAP = 16;

/**
 * Append `node` as a member of Frame `frameId`, positioned inside its box in the first free slot
 * (reading order) so it never stacks on a sibling. The Frame grows to the right
 * and bottom when the node does not fit, so a member is always physically inside its Frame. The
 * Frame stays ahead of its members in array order, so it paints behind them. Pure; an unknown
 * `frameId` appends the node loose.
 */
export function placeInTargetFrame(nodes: readonly Node[], node: Node, frameId: string): Node[] {
  const frame = nodes.find((n) => n.id === frameId && isFrame(n));
  if (!frame) return [...nodes, node];
  const slot = slotInFrame(nodes, frame, node);
  const out = [...nodes.map((n) => (n === frame ? slot.frame : n)), withFrameId({ ...node, position: slot.position }, frameId)];
  // Growing must not push the Frame into a neighbour it was clear of: the Frame and its members move together
  // to the nearest free space instead (the same rule the re-tile applies). Other Frames never move.
  const before = frameOccupiedBox(frameBoxOf(frame));
  const grown = frameBoxOf(slot.frame);
  const others = framesInOrder(nodes).filter((f) => f.id !== frameId);
  const hit = others.some((o) => {
    const ob = frameOccupiedBox(frameBoxOf(o));
    return boxesOverlap(frameOccupiedBox(grown), ob) && !boxesOverlap(before, ob);
  });
  if (!hit) return out;
  const spot = placeFrameInFreeSpace(others, { w: grown.w, h: grown.h }, { x: grown.x + grown.w / 2, y: grown.y + grown.h / 2 });
  const dx = spot.x - grown.x;
  const dy = spot.y - grown.y;
  return out.map((n) =>
    n.id === frameId || frameIdOf(n) === frameId ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n,
  );
}

/** First free slot (reading order) for `node` inside `frame`, and the Frame grown to hold it. */
function slotInFrame(nodes: readonly Node[], frame: Node, node: Node): { position: { x: number; y: number }; frame: Node } {
  const { w: nw, h: nh } = dimOf(node);
  const { w: fw, h: fh } = dimOf(frame);
  const originX = frame.position.x + FRAME_PAD;
  const originY = frame.position.y + FRAME_PAD;
  const innerRight = frame.position.x + fw - FRAME_PAD;
  const members = frameMembers(nodes, frame.id).filter((m) => m.id !== node.id).map(boxOf);
  const hits = (x: number, y: number) =>
    members.some((b) => x < b.x + b.w + SLOT_GAP && x + nw + SLOT_GAP > b.x && y < b.y + b.h + SLOT_GAP && y + nh + SLOT_GAP > b.y);

  let x = originX;
  let y = originY;
  while (hits(x, y)) {
    x += nw + SLOT_GAP;
    if (x + nw > innerRight && x > originX) {
      x = originX;
      y += nh + SLOT_GAP;
    }
  }

  const needW = Math.max(fw, x + nw + FRAME_PAD - frame.position.x);
  const needH = Math.max(fh, y + nh + FRAME_PAD - frame.position.y);
  const grown =
    needW === fw && needH === fh
      ? frame
      : { ...frame, width: needW, height: needH, style: { ...frame.style, width: needW, height: needH } };
  return { position: { x, y }, frame: grown };
}

export interface FrameMoveResult {
  nodes: Node[];
  /** One entry per node whose Frame changed. Empty = nothing happened. */
  changes: MembershipChange[];
  /** Reverses the move on a later copy of the board: positions, membership and the Frame's size. */
  undo: (nodes: Node[]) => Node[];
}

/**
 * Send nodes into a Frame (⌥⇧N, the NL "move into Frame"), or out of theirs when `frameId` is
 * undefined. Membership is by position (decision 3), so going in also MOVES the node: it takes the
 * first free slot inside the Frame, and the Frame grows to hold it. A node whose centre already lies
 * inside the Frame keeps its place. Coming out changes membership only. Moved nodes follow the Frame
 * in array order so it keeps painting behind them.
 */
export function moveNodesToFrame(nodes: readonly Node[], ids: Iterable<string>, frameId: string | undefined): FrameMoveResult {
  const wanted = new Set(ids);
  const targets = nodes.filter((n) => wanted.has(n.id) && isFrameable(n) && frameIdOf(n) !== frameId);
  const nothing: FrameMoveResult = { nodes: [...nodes], changes: [], undo: (b) => b };
  if (targets.length === 0) return nothing;
  const frame = frameId ? nodes.find((n) => n.id === frameId && isFrame(n)) : undefined;
  if (frameId && !frame) return nothing;

  const before = new Map(targets.map((n) => [n.id, n]));
  const frameBefore = frame;
  const moved = new Map<string, Node>();
  let current: Node[] = [...nodes];
  let currentFrame = frame;
  for (const target of targets) {
    if (!currentFrame || !frameId) {
      moved.set(target.id, withFrameId(target, undefined));
      continue;
    }
    const b = boxOf(target);
    const f = boxOf(currentFrame);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const centreInside = cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
    let placed: Node;
    if (centreInside) {
      placed = withFrameId(target, frameId);
    } else {
      const slot = slotInFrame(current, currentFrame, target);
      placed = withFrameId({ ...target, position: slot.position }, frameId);
      const grownFrame = slot.frame;
      current = current.map((n) => (n.id === grownFrame.id ? grownFrame : n));
      currentFrame = grownFrame;
    }
    moved.set(target.id, placed);
    current = current.map((n) => (n.id === target.id ? placed : n));
  }

  // Keep moved nodes after their Frame in array order.
  const frameIndex = frameId ? current.findIndex((n) => n.id === frameId) : -1;
  const movedIds = new Set(moved.keys());
  let out: Node[];
  if (frameIndex < 0) out = current.map((n) => moved.get(n.id) ?? n);
  else {
    const rest = current.filter((n) => !movedIds.has(n.id));
    const at = rest.findIndex((n) => n.id === frameId) + 1;
    out = [...rest.slice(0, at), ...targets.map((t) => moved.get(t.id)!), ...rest.slice(at)];
  }

  const changes: MembershipChange[] = targets.map((t) => ({ nodeId: t.id, from: frameIdOf(t), to: frameId }));
  const undo = (board: Node[]): Node[] =>
    board.map((n) => {
      const was = before.get(n.id);
      if (was) return withFrameId({ ...n, position: was.position }, frameIdOf(was));
      if (frameBefore && n.id === frameBefore.id) {
        return { ...n, position: frameBefore.position, width: frameBefore.width, height: frameBefore.height, style: frameBefore.style };
      }
      return n;
    });
  return { nodes: out, changes, undo };
}

/**
 * Restore a captured membership map onto live nodes. A Frame that no longer exists is ignored, and a
 * node the map does not list (created after the snapshot) keeps whatever Frame it has.
 */
export function restoreMemberships(nodes: Node[], memberships: Readonly<Record<string, string>>): Node[] {
  const frameIds = new Set(nodes.filter(isFrame).map((n) => n.id));
  return nodes.map((n) => {
    if (n.type === "shape" || isFrame(n)) return n;
    if (!(n.id in memberships)) return n;
    const want = memberships[n.id];
    const target = want && frameIds.has(want) ? want : undefined;
    return frameIdOf(n) === target ? n : withFrameId(n, target);
  });
}


// ── Edit: rename, recolour, fit, delete with contents (LOT2-123) ────────────────────────────────

function patchFrame(nodes: Node[], frameId: string, patch: (n: Node) => Node): Node[] {
  return nodes.map((n) => (n.id === frameId && isFrame(n) ? patch(n) : n));
}

/** Rename a Frame. The name is trimmed; a blank name keeps the old one. */
export function renameFrame(nodes: Node[], frameId: string, title: string): Node[] {
  const next = title.trim();
  if (!next) return [...nodes];
  return patchFrame(nodes, frameId, (n) => ({ ...n, data: { ...n.data, title: next } }));
}

export function recolorFrame(nodes: Node[], frameId: string, colorId: string): Node[] {
  return patchFrame(nodes, frameId, (n) => ({ ...n, data: { ...n.data, colorId } }));
}

/** Resize and move a Frame to hug its members. A Frame with no members is left as it is. */
export function fitFrameToContent(nodes: Node[], frameId: string): Node[] {
  const members = frameMembers(nodes, frameId);
  if (members.length === 0) return [...nodes];
  const fit = fitBoxAvoidingFrames(members.map(boxOf), framesInOrder(nodes).filter((f) => f.id !== frameId));
  if (!fit.ok) return [...nodes]; // fitting would overlap another Frame: leave it as it is
  const box = fit.box;
  return patchFrame(nodes, frameId, (n) => ({
    ...n,
    position: { x: box.x, y: box.y },
    width: box.w,
    height: box.h,
    style: { ...n.style, width: box.w, height: box.h },
  }));
}

/** What is actually running right now, from the live status registries. */
export interface LiveSessions {
  /** The agent's live status, or undefined when it has no live session. */
  agentStatus: (nodeId: string) => AgentNodeStatus | undefined;
  /** True while the terminal is executing something. */
  terminalRunning: (nodeId: string) => boolean;
}

/** An agent whose session is doing or awaiting work; idle and completed ones are at rest. */
const AGENT_SESSION_STATUSES: ReadonlySet<AgentNodeStatus> = new Set(["running", "connecting", "needs-you", "stalled", "error"]);

export interface FrameDeletionSummary {
  nodeCount: number;
  /** Terminals running a command that Delete would stop. */
  terminals: number;
  /** Agents with a running session that would end. */
  agents: number;
  memberIds: string[];
}

/** What "Delete with contents" would destroy: shown in the confirm dialog. */
export function frameDeletionSummary(nodes: readonly Node[], frameId: string, live: LiveSessions): FrameDeletionSummary {
  const members = frameMembers(nodes, frameId);
  return {
    nodeCount: members.length,
    terminals: members.filter((n) => n.type === "terminal" && live.terminalRunning(n.id)).length,
    agents: members.filter((n) => n.type === "agent" && AGENT_SESSION_STATUSES.has(live.agentStatus(n.id) ?? "idle")).length,
    memberIds: members.map((n) => n.id),
  };
}

/** The Frame and every member removed. Pure data step: the caller closes the runtime sessions. */
export function deleteFrameWithContents(nodes: Node[], frameId: string): Node[] {
  if (!nodes.some((n) => n.id === frameId && isFrame(n))) return [...nodes];
  return nodes.filter((n) => n.id !== frameId && frameIdOf(n) !== frameId);
}

/**
 * Members whose Frame is gone (the Frame was removed by Delete/Backspace, an erase or an agent)
 * become loose. Returns the same array when nothing is orphaned so callers can skip a state write.
 */
export function detachOrphanedMembers(nodes: Node[]): Node[] {
  const frameIds = new Set(nodes.filter(isFrame).map((n) => n.id));
  let changed = false;
  const next = nodes.map((n) => {
    const fid = frameIdOf(n);
    if (isFrame(n) || !fid || frameIds.has(fid)) return n;
    changed = true;
    return withFrameId(n, undefined);
  });
  return changed ? next : nodes;
}
