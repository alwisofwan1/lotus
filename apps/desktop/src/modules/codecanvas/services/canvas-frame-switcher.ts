import type { Node } from "@xyflow/react";
import { formatShortcut } from "@/lib/hotkeys/format-shortcut";
import { readPlatformString } from "@/lib/platform";
import type { AgentStatusSnapshot } from "./agent-status-registry";
import { frameNode } from "./canvas-node-factory";
import { DEFAULT_FRAME_SIZE } from "./canvas-node-placement";
import { MAX_FRAMES, frameIdOf, frameTitleOf, framesInOrder, nextFrameTitle } from "./canvas-frames";
import { placeFrameInFreeSpace } from "./canvas-frame-space";
import { nextFrameColorId } from "./canvas-frame-palette";
import type { AgentNodeStatus } from "../types/canvas";
import type { CanvasStatusState } from "../types/canvas-theme";

/** Frame Switcher chip model (ADR-0050): pure, so order, status and overflow are testable. */

/** Chips 01-04 map to the hotkeys (one per allowed Frame); an older canvas with more folds the rest into "+N". */
export const MAX_FRAME_CHIPS = MAX_FRAMES;

/** Most urgent first. A stalled agent reads as an error. */
const SEVERITY: Record<AgentNodeStatus, number> = {
  "needs-you": 5, error: 4, stalled: 4, running: 3, connecting: 2, completed: 1, idle: 0,
};

export function worstFrameStatus(statuses: readonly AgentNodeStatus[]): AgentNodeStatus {
  let worst: AgentNodeStatus = "idle";
  for (const s of statuses) if ((SEVERITY[s] ?? 0) > SEVERITY[worst]) worst = s;
  return worst;
}

const TONE: Record<AgentNodeStatus, CanvasStatusState> = {
  "needs-you": "blocked", error: "error", stalled: "error", running: "running",
  connecting: "connecting", completed: "completed", idle: "idle",
};

export interface FrameChip {
  frameId: string;
  /** 1-based position in Frame order. */
  index: number;
  label: string;
  name: string;
  status: AgentNodeStatus;
  tone: CanvasStatusState;
  needsYou: boolean;
}

export function buildFrameSwitcher(
  nodes: readonly Node[],
  snapshots: ReadonlyArray<Pick<AgentStatusSnapshot, "id" | "status">>,
): { chips: FrameChip[]; overflow: FrameChip[] } {
  const statusById = new Map(snapshots.map((s) => [s.id, s.status]));
  const byFrame = new Map<string, AgentNodeStatus[]>();
  for (const n of nodes) {
    const fid = frameIdOf(n);
    const st = statusById.get(n.id);
    if (!fid || !st) continue;
    const list = byFrame.get(fid);
    if (list) list.push(st);
    else byFrame.set(fid, [st]);
  }
  const all = framesInOrder(nodes)
    .map((n, i): FrameChip => {
      const status = worstFrameStatus(byFrame.get(n.id) ?? []);
      const name = frameTitleOf(n) || "Frame";
      return {
        frameId: n.id,
        index: i + 1,
        label: String(i + 1),
        name,
        status,
        tone: TONE[status],
        needsYou: status === "needs-you",
      };
    });
  return { chips: all.slice(0, MAX_FRAME_CHIPS), overflow: all.slice(MAX_FRAME_CHIPS) };
}

/** Buttons the switcher puts in the bar: every chip, the "+N" overflow chip, and "+" while there is room. */
export function frameSwitcherSlotCount(chipCount: number, overflowCount: number): number {
  const total = chipCount + overflowCount;
  return chipCount + (overflowCount > 0 ? 1 : 0) + (total < MAX_FRAMES ? 1 : 0);
}

/**
 * "Name · status · ⌥N" ("Alt+N" off macOS): words as well as colour, so the ring is never the only
 * cue.
 */
export function frameChipTooltip(chip: FrameChip, platform: string = readPlatformString()): string {
  const parts = [chip.name, chip.needsYou ? "needs you" : chip.status];
  if (chip.index <= MAX_FRAME_CHIPS) parts.push(formatShortcut(`⌥${chip.index}`, platform));
  return parts.join(" · ");
}

/** Flow-space box of a Frame, for the camera. */
export function frameBounds(frame: Node): { x: number; y: number; width: number; height: number } {
  return {
    x: frame.position.x,
    y: frame.position.y,
    width: frame.measured?.width ?? frame.width ?? 0,
    height: frame.measured?.height ?? frame.height ?? 0,
  };
}

/**
 * The "+" chip: a new empty default-size Frame in the free space nearest `centre` (flow coordinates),
 * never on top of another Frame. Unchanged copy at the Frame limit.
 */
export function appendEmptyFrameAt(nodes: readonly Node[], frameId: string, centre: { x: number; y: number }): Node[] {
  if (framesInOrder(nodes).length >= MAX_FRAMES) return [...nodes];
  const { w, h } = DEFAULT_FRAME_SIZE;
  const position = placeFrameInFreeSpace(framesInOrder(nodes), { w, h }, centre);
  const created = frameNode({
    id: frameId,
    position,
    title: nextFrameTitle([...nodes]),
    colorId: nextFrameColorId(nodes),
    size: { w, h },
  });
  return [...nodes, created];
}

/** The Frame tool (F-drag): a new empty Frame filling the dragged `box` (flow coordinates). */
export function appendFrameInBox(nodes: readonly Node[], frameId: string, box: { x: number; y: number; w: number; h: number }): Node[] {
  if (framesInOrder(nodes).length >= MAX_FRAMES) return [...nodes];
  const created = frameNode({
    id: frameId,
    position: { x: box.x, y: box.y },
    title: nextFrameTitle([...nodes]),
    colorId: nextFrameColorId(nodes),
    size: { w: box.w, h: box.h },
  });
  return [...nodes, created];
}
