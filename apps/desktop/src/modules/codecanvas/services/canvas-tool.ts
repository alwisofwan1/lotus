/**
 * Whiteboard tool model for the Canvas tool rail (PRD §6.1 / §9). Pure & UI-only —
 * the active tool is canvas (not workflow) state and is never persisted into the graph.
 */

import type { CanvasShapeKind } from "../types/canvas";
export type { CanvasShapeKind };

export type CanvasTool =
  | "select"
  | "pan"
  | "rectangle"
  | "diamond"
  | "ellipse"
  | "text"
  | "arrow"
  | "line"
  | "draw"
  | "eraser"
  | "frame";

/** Tools that create a `shape` node when the user clicks/drags the canvas. */
const SHAPE_TOOLS = new Set<CanvasTool>(["rectangle", "diamond", "ellipse", "text", "arrow", "line", "draw"]);
/** Shape tools whose geometry is a point path (rendered via `points`): linear + freehand. */
const LINEAR_TOOLS = new Set<CanvasTool>(["arrow", "line", "draw"]);

export function isLinearTool(tool: CanvasTool): boolean {
  return LINEAR_TOOLS.has(tool);
}

export function isShapeTool(tool: CanvasTool): boolean {
  return SHAPE_TOOLS.has(tool);
}

export function shapeForTool(tool: CanvasTool): CanvasShapeKind | null {
  return isShapeTool(tool) ? (tool as CanvasShapeKind) : null;
}

const SHORTCUTS: Record<string, CanvasTool> = {
  v: "select",
  h: "pan",
  r: "rectangle",
  d: "diamond",
  o: "ellipse",
  t: "text",
  a: "arrow",
  l: "line",
  p: "draw",
  e: "eraser",
  // `f` is already jump-labels in the hotkey registry, so the Frame tool takes `n` (new Frame).
  n: "frame",
};

/** Maps a single keypress to a tool (case-insensitive), or null when unmapped. */
export function toolForShortcut(key: string): CanvasTool | null {
  if (key.length !== 1) return null;
  return SHORTCUTS[key.toLowerCase()] ?? null;
}

/**
 * Tools that only decide what a mouse drag MEANS, rather than drawing anything.
 *
 * They stay reachable by keyboard even with the tool rail hidden, and that distinction is
 * load-bearing — see {@link resolveToolShortcut}.
 */
const NAVIGATION_TOOLS = new Set<CanvasTool>(["select", "pan"]);

/** True for a tool that puts something on the board (every shape tool, plus the eraser). */
function drawsOnCanvas(tool: CanvasTool): boolean {
  return !NAVIGATION_TOOLS.has(tool);
}

/**
 * What a keydown means to the tool rail: a tool to activate, `"select"` for the Escape reset, or
 * null to ignore the key entirely.
 *
 * Extracted out of CanvasPage's effect so this decision is testable by BEHAVIOUR rather than by
 * asserting on the container's source text. It gates ten bare letters, so a regression here silently
 * changes what a third of the alphabet does — too much to leave to a regex over a 1200-line file.
 *
 * ## Why `showToolRail` gates only the DRAWING tools
 *
 * The setting used to gate only the rail's *rendering*, so with the rail hidden "r" still armed the
 * rectangle tool and nothing on screen explained why (plans/nl-type-to-focus §3). Correct problem —
 * but the first fix suppressed all ten letters, and `v`/`h` are not drawing tools. They change what a
 * drag does, and the drag is its own feedback; there is nothing invisible about them.
 *
 * Suppressing them locked the canvas. The rail is the only CLICK path to a tool, so with it hidden
 * `activeTool` was pinned to its initial `"select"` for the whole session — and CanvasPage maps
 * select to `panOnDrag: [1, 2]`, middle/right button only. Left-drag stopped panning and drew a
 * selection box instead; on a trackpad, where there is no middle button and scroll is bound to zoom,
 * that left no reasonable way to pan at all.
 *
 * So the rule is about what a tool DOES, not which letter it is: a tool that marks the board needs
 * the rail visible to explain itself, a tool that only steers the viewport never did.
 */
export function resolveToolShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
  opts: { showToolRail: boolean; editableTarget: boolean; jumpLabelsOpen?: boolean },
): CanvasTool | null {
  // A modifier chord belongs to the app's hotkey layer, not the tool rail.
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  // Whatever the user is typing into owns its own keys.
  if (opts.editableTarget) return null;
  // Jump labels own every plain letter while they are showing, and the home-row alphabet they use
  // overlaps this map on purpose — `a` is both the arrow tool and the first badge. Gated here rather
  // than by listener order, which is not something either side can rely on.
  if (opts.jumpLabelsOpen) return null;
  // Ungated on purpose: with the rail hidden this is the only way back out of the pan tool.
  if (event.key === "Escape") return "select";
  const tool = toolForShortcut(event.key);
  if (!tool) return null;
  if (!opts.showToolRail && drawsOnCanvas(tool)) return null;
  return tool;
}
