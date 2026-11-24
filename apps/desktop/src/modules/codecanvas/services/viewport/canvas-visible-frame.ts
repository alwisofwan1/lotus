/**
 * The visible canvas area (between the overlay chrome) and how to frame a layout's bounds
 * inside it. Extracted from CanvasPage's handleArrange so arrange AND focus mode share one
 * camera-framing rule: fitView can't account for the floating tool rail / top bar / NL bar,
 * which left an asymmetric gap. Pure — callers own the viewport animation.
 */

/** Overlay-chrome insets in screen px: left tool rail, right edge, top bar, NL bar. */
export const CANVAS_CHROME_INSETS = { left: 80, right: 28, top: 60, bottom: 92 } as const;

/**
 * Inset for an edge whose chrome is hidden (Settings → Canvas → Layout). Matches the bare
 * right edge, so a hidden rail leaves the same breathing room as the bare side edge.
 */
export const CANVAS_BARE_EDGE_INSET = CANVAS_CHROME_INSETS.right;

/**
 * Top safe-area when the top pill is docked into the command bar. The pill is gone, but macOS
 * ALWAYS draws the traffic-light window controls at the top-left (trafficLightPosition {x:18,y:19},
 * ~14px buttons → zone bottom ≈ 33px). A bare side-edge inset (28px) would frame the top row of
 * cells level with the buttons; this reserves a clean ~17px gap below them so content never
 * crowds the OS chrome. Distinct from the top-bar inset (60px), which also clears the floating pill.
 */
export const CANVAS_TITLEBAR_SAFE_TOP = 50;

/**
 * Which overlay chrome is actually on screen — mirrors the Layout settings
 * (`showToolRail`, `topControls` in useCanvasBehaviorSettings). Omitted fields
 * assume the chrome is visible, preserving today's behaviour.
 */
export interface CanvasChromeState {
  showToolRail?: boolean;
  topControls?: "top-bar" | "command-bar";
  /** Screen px the open Canvas Dock covers from the pane's right edge; 0 or omitted when closed. */
  dockInset?: number;
}

/** The Canvas Dock's box (canvas-dock.css): 452 wide, the whole window with ⌘\, 16px off the edges. */
export const CANVAS_DOCK_WIDTH = 452;
export const CANVAS_DOCK_EDGE = 16;

/**
 * How much of the pane's right side the Dock covers, from its state rather than its DOM box: the
 * box slides in and animates its width on ⌘\, so a measurement taken mid-move is wrong. Mirrors
 * the CSS `max-width: calc(100% - 32px)`.
 */
export function canvasDockInset(dock: { open: boolean; wide: boolean }, paneWidth: number): number {
  const fill = Math.max(0, paneWidth - CANVAS_DOCK_EDGE * 2);
  // A widened Dock covers the whole canvas: there is no side to pan clear to, so the camera
  // frames the board as if it were closed and the node is there when the Dock narrows or closes.
  if (!dock.open || dock.wide || CANVAS_DOCK_WIDTH >= fill) return 0;
  return CANVAS_DOCK_WIDTH + CANVAS_DOCK_EDGE;
}

const MIN_VISIBLE_W = 360;
const MIN_VISIBLE_H = 280;

export interface VisibleCanvasArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LayoutBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/**
 * Visible-area rectangle (screen px) for a given canvas pane size. Pass the current chrome
 * state so a hidden tool rail / docked top pill hands its strip back to the layout instead
 * of leaving a phantom margin.
 */
export function measureVisibleCanvasArea(
  pane: { width: number; height: number },
  chrome?: CanvasChromeState,
): VisibleCanvasArea {
  const left = chrome?.showToolRail === false ? CANVAS_BARE_EDGE_INSET : CANVAS_CHROME_INSETS.left;
  const top = chrome?.topControls === "command-bar" ? CANVAS_TITLEBAR_SAFE_TOP : CANVAS_CHROME_INSETS.top;
  // An open Dock is the right edge: the same breathing room as a bare edge, measured from its side.
  const right = chrome?.dockInset ? chrome.dockInset + CANVAS_BARE_EDGE_INSET : CANVAS_CHROME_INSETS.right;
  return {
    left,
    top,
    width: Math.max(MIN_VISIBLE_W, pane.width - left - right),
    height: Math.max(MIN_VISIBLE_H, pane.height - top - CANVAS_CHROME_INSETS.bottom),
  };
}

/**
 * Viewport transform that centers `bounds` in the visible area. Prefers actual size (zoom 1) so
 * terminal content stays legible; only zooms out (floor 0.45) when the layout genuinely needs it.
 */
export function frameBoundsInVisibleArea(
  bounds: LayoutBounds,
  area: VisibleCanvasArea,
): { x: number; y: number; zoom: number } {
  const zoom = Math.min(1, Math.max(0.45, Math.min(area.width / bounds.width, area.height / bounds.height)));
  return {
    zoom,
    x: area.left + (area.width - bounds.width * zoom) / 2 - bounds.minX * zoom,
    y: area.top + (area.height - bounds.height * zoom) / 2 - bounds.minY * zoom,
  };
}
