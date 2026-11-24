/**
 * Pure geometry + timeline core for the NL → agent "comet dispatch" effect.
 *
 * The renderer (CanvasCommandDeliveryOverlay) re-measures the source and target rects every frame and
 * feeds them here, so the flight path — and especially the landing point — tracks the live position of
 * the terminal agent from any side of the canvas, surviving zoom, pan, auto-arrange and layout changes.
 *
 * Everything here is DOM-free and deterministic so it can be unit-tested exhaustively.
 */

export interface Point {
  x: number;
  y: number;
}

/** The subset of DOMRect the geometry needs. */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type DispatchMotionMode = "full" | "reduced" | "off";

/** Timeline (ms). Total stays under the queue's removal window (1250ms) so the paint finishes cleanly. */
export const DISPATCH_COMET_TIMING = {
  chargeMs: 170,
  flightStartMs: 150,
  flightDurMs: 620,
  impactStartMs: 760,
  impactMs: 260,
  ackStartMs: 780,
  ackMs: 440,
  totalMs: 1240,
} as const;

/** Number of head positions retained to draw the trailing tail — the tail literally follows the head. */
export const DISPATCH_COMET_TAIL_SAMPLES = 26;

/** Blue signal palette (no purple residue). Colours live here, not scattered through the CSS. */
export const DISPATCH_COMET_PALETTE = {
  core: "#ffffff",
  hot: "#e0f7ff",
  soft: "#7dd3fc",
  accent: "#38bdf8",
  deep: "#0ea5e9",
} as const;

/** Perpendicular bow height for the arc — scales with distance, clamped so it never over-lobs. */
export function arcHeight(distance: number): number {
  return Math.min(140, Math.max(24, distance * 0.18));
}

export function rectCenter(rect: RectLike): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * The landing point: the caret on the target's input rail — left-anchored, vertically centred on the
 * rail. Never the node's dead centre. The offset is clamped to half-width so narrow targets don't
 * overshoot their own box.
 */
export function landingAnchor(rect: RectLike, offset = 22): Point {
  return {
    x: rect.left + Math.min(offset, rect.width / 2),
    y: rect.top + rect.height / 2,
  };
}

export interface FlightGeometry {
  /** Launch point — centre of the command bar. */
  source: Point;
  /** Landing point — the caret on the target's input rail. */
  target: Point;
  /** Quadratic Bézier control point that bows the arc perpendicular to the chord. */
  control: Point;
  /** Straight-line distance source → target. */
  distance: number;
  /** Chord angle source → target, radians. */
  angle: number;
}

/**
 * Builds the flight path between two points. The control point bows perpendicular to the source→target
 * chord, forced to the "up" side (negative y) so the comet always lobs on an upward arc no matter which
 * side of the canvas the agent sits on.
 */
export function buildFlightPath(source: Point, target: Point): FlightGeometry {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  const safe = distance || 1;
  // perpendicular normal, forced to point up so the bow is always an overhead lob
  let nx = -dy / safe;
  let ny = dx / safe;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }

  const bow = arcHeight(distance);
  const mid = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  const control = { x: mid.x + nx * bow, y: mid.y + ny * bow };

  return { source, target, control, distance, angle };
}

/** Convenience: build the flight path from live source/target rects (source centre → input caret). */
export function flightGeometry(
  sourceRect: RectLike,
  targetRect: RectLike,
  opts?: { landingOffset?: number },
): FlightGeometry {
  return buildFlightPath(rectCenter(sourceRect), landingAnchor(targetRect, opts?.landingOffset));
}

/**
 * Comet opacity across the flight. Full through most of the arc, then dissolves over the final stretch
 * so the head melts into the impact instead of slamming into the caret as a hard bright streak — the
 * descent can be steep when the agent sits high on the canvas, and a hard streak reads as a glitch.
 */
export function cometHeadFade(progress: number): number {
  const FADE_FROM = 0.8;
  if (progress <= FADE_FROM) return 1;
  if (progress >= 1) return 0;
  return 1 - (progress - FADE_FROM) / (1 - FADE_FROM);
}

/** Point on a quadratic Bézier at parameter t. */
export function quadraticPoint(a: Point, control: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
  };
}

/** Flight easing — approximates cubic-bezier(0.22, 1, 0.36, 1) (fast out, gentle settle). */
export function easeFlight(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

/** A sine hump over [start, start+dur): 0 at the edges, 1 at the middle. */
function pulse(elapsedMs: number, startMs: number, durMs: number): number {
  const t = (elapsedMs - startMs) / durMs;
  if (t <= 0 || t >= 1) return 0;
  return Math.sin(t * Math.PI);
}

export interface CometFrame {
  /** Launch-charge alpha at the source (0 when inactive). */
  charge: number;
  /** Eased flight progress 0..1, or null when the comet is not travelling. */
  flight: number | null;
  /** Impact alpha at the landing point (0 when inactive). */
  impact: number;
  /** Node acknowledgement border alpha (0 when inactive). */
  ack: number;
  /** True once the whole sequence has elapsed and nothing more should paint. */
  done: boolean;
}

/**
 * Describes what to paint at a given elapsed time. In reduced/off modes there is no travel — just a
 * quiet pulse at the target (reduced motion also drops the node acknowledgement).
 */
export function cometFrame(elapsedMs: number, mode: DispatchMotionMode = "full"): CometFrame {
  const T = DISPATCH_COMET_TIMING;
  if (elapsedMs >= T.totalMs) {
    return { charge: 0, flight: null, impact: 0, ack: 0, done: true };
  }

  if (mode !== "full") {
    const impact = pulse(elapsedMs, 0, T.impactMs);
    const ack = mode === "off" ? pulse(elapsedMs, 0, T.ackMs) : 0;
    return { charge: 0, flight: null, impact, ack, done: false };
  }

  const ft = (elapsedMs - T.flightStartMs) / T.flightDurMs;
  const flight = ft >= 0 && ft <= 1 ? easeFlight(ft) : null;

  return {
    charge: pulse(elapsedMs, 0, T.chargeMs),
    flight,
    impact: pulse(elapsedMs, T.impactStartMs, T.impactMs),
    ack: pulse(elapsedMs, T.ackStartMs, T.ackMs),
    done: false,
  };
}
