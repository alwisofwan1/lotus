import { frameBoxAround } from "./canvas-frame-geometry";
import type { CanvasFrameNodeRecord, CanvasNodeRecord, CanvasShapeNodeRecord } from "../types/canvas";

/**
 * Load-time migration from the retired shape-group model to Frames (ADR-0050, LOT2-121).
 *
 * - Each outermost old group (`groupIds`, outermost last) of two or more shapes becomes an unnamed
 *   Frame ("Frame 1"…) fit to its members. Inner nested groups are dropped.
 * - An agent diagram's frame rect (`diagramFrame`) becomes a real Frame titled by its `areaLabel`,
 *   same box, with that diagram's shapes as members. Diagram marks stay on the members.
 * - Every shape then stops carrying `groupIds`; membership is the `frameId` reference only.
 *
 * Positions never change. Frames are inserted before their first member so array order paints
 * them behind it. Pure; a record list with no legacy groups comes back identical.
 */
type ShapeRecord = CanvasShapeNodeRecord & { frameId?: string };

const isShape = (r: CanvasNodeRecord): r is ShapeRecord => r.type === "shape";

export function migrateLegacyGroupsToFrames(records: CanvasNodeRecord[]): CanvasNodeRecord[] {
  const hasLegacy = records.some((r) => isShape(r) && ((r.groupIds?.length ?? 0) > 0 || r.diagramFrame === true));
  if (!hasLegacy) return records;

  const takenIds = new Set(records.map((r) => r.id));
  let counter = 0;
  const nextTitle = () => `Frame ${++counter}`;

  // Replacement for a record (diagram frame rect) and Frames to insert before a record.
  const replace = new Map<string, CanvasFrameNodeRecord>();
  const insertBefore = new Map<string, CanvasFrameNodeRecord[]>();
  const frameOf = new Map<string, string>();

  // 1. Diagram frames.
  for (const r of records) {
    if (!isShape(r) || r.diagramFrame !== true || !r.diagramId) continue;
    const label = r.areaLabel?.trim();
    replace.set(r.id, {
      type: "frame", id: r.id, position: r.position, size: r.size,
      title: label || nextTitle(), diagramId: r.diagramId,
    });
    for (const m of records) {
      if (isShape(m) && m.diagramFrame !== true && m.diagramId === r.diagramId && !m.frameId) frameOf.set(m.id, r.id);
    }
  }

  // 2. Outermost groups of the shapes no diagram claimed.
  const buckets = new Map<string, ShapeRecord[]>();
  for (const r of records) {
    if (!isShape(r) || replace.has(r.id) || frameOf.has(r.id) || r.frameId) continue;
    const ids = r.groupIds;
    if (!ids || ids.length === 0) continue;
    const gid = ids[ids.length - 1];
    const list = buckets.get(gid);
    if (list) list.push(r);
    else buckets.set(gid, [r]);
  }
  for (const [gid, members] of buckets) {
    if (members.length < 2) continue;
    let id = `frame-${gid}`;
    while (takenIds.has(id)) id = `${id}-f`;
    takenIds.add(id);
    const box = frameBoxAround(members.map((m) => ({ x: m.position.x, y: m.position.y, w: m.size.w, h: m.size.h })));
    const frame: CanvasFrameNodeRecord = {
      type: "frame", id, title: nextTitle(),
      position: { x: box.x, y: box.y }, size: { w: box.w, h: box.h },
    };
    insertBefore.set(members[0].id, [frame]);
    for (const m of members) frameOf.set(m.id, id);
  }

  // 3. Rebuild: swap diagram rects, insert group Frames, point members, strip group ids.
  const out: CanvasNodeRecord[] = [];
  for (const r of records) {
    const before = insertBefore.get(r.id);
    if (before) out.push(...before);
    const swapped = replace.get(r.id);
    if (swapped) { out.push(swapped); continue; }
    if (!isShape(r)) { out.push(r); continue; }
    const { groupIds: _legacy, ...rest } = r;
    const frameId = frameOf.get(r.id);
    out.push(frameId ? { ...rest, frameId } : rest);
  }
  return out;
}
