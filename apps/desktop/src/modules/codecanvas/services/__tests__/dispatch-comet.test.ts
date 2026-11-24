import { describe, expect, it } from "vitest";
import {
  arcHeight,
  buildFlightPath,
  cometFrame,
  cometHeadFade,
  DISPATCH_COMET_PALETTE,
  DISPATCH_COMET_TIMING,
  easeFlight,
  flightGeometry,
  landingAnchor,
  quadraticPoint,
  rectCenter,
  type RectLike,
} from "../dispatch-comet";

function rect(left: number, top: number, width: number, height: number): RectLike {
  return { left, top, width, height };
}

describe("dispatch-comet geometry", () => {
  it("clamps the arc bow to a sane range", () => {
    expect(arcHeight(0)).toBe(24);
    expect(arcHeight(50)).toBe(24); // 9 → clamped up
    expect(arcHeight(500)).toBe(90);
    expect(arcHeight(5000)).toBe(140); // clamped down
  });

  it("centres a rect", () => {
    expect(rectCenter(rect(100, 200, 40, 20))).toEqual({ x: 120, y: 210 });
  });

  it("lands on the caret at the left of the input rail, not the node centre", () => {
    // wide rail → left + 22, vertical centre
    expect(landingAnchor(rect(1000, 700, 600, 40))).toEqual({ x: 1022, y: 720 });
    // the anchor is nowhere near the horizontal centre (1300)
    expect(landingAnchor(rect(1000, 700, 600, 40)).x).toBeLessThan(1300);
  });

  it("clamps the caret offset so narrow targets don't overshoot their own box", () => {
    expect(landingAnchor(rect(1000, 700, 20, 40))).toEqual({ x: 1010, y: 720 });
  });

  it("builds a flight path whose distance and chord angle match the endpoints", () => {
    const geo = flightGeometry(rect(0, 0, 0, 0), rect(300, 400, 0, 0));
    expect(geo.source).toEqual({ x: 0, y: 0 });
    expect(geo.target).toEqual({ x: 300, y: 400 });
    expect(geo.distance).toBeCloseTo(500, 5);
    expect(geo.angle).toBeCloseTo(Math.atan2(400, 300), 5);
  });

  // The headline requirement: the landing tracks the agent from ANY side of the canvas.
  it("always bows the arc upward regardless of which side the target sits on", () => {
    const source = rect(500, 500, 0, 0); // centre (500, 500)
    const targets = {
      right: rect(900, 500, 0, 0),
      left: rect(100, 500, 0, 0),
      below: rect(500, 900, 0, 0),
      aboveRight: rect(820, 180, 0, 0),
      belowLeft: rect(160, 860, 0, 0),
    };
    for (const [side, target] of Object.entries(targets)) {
      const geo = flightGeometry(source, target);
      const mid = { x: (geo.source.x + geo.target.x) / 2, y: (geo.source.y + geo.target.y) / 2 };
      // control point bows to the "up" side of the chord midpoint (never below it)
      expect(geo.control.y, `arc should bow upward for target ${side}`).toBeLessThanOrEqual(mid.y);
      // and it is genuinely displaced (an arc, not a flat line)
      expect(Math.hypot(geo.control.x - mid.x, geo.control.y - mid.y)).toBeGreaterThan(0);
    }
  });

  it("recomputes the landing when the target rect moves (auto-arrange / layout change)", () => {
    const source = rect(600, 900, 380, 44);
    const before = flightGeometry(source, rect(1160, 120, 300, 40));
    const after = flightGeometry(source, rect(220, 640, 300, 40)); // node moved to the other side
    expect(after.target).not.toEqual(before.target);
    expect(after.target.x).toBeCloseTo(242, 5); // 220 + 22
    expect(after.target.y).toBeCloseTo(660, 5); // 640 + 20
  });

  it("buildFlightPath bows upward between two raw points (used with a frozen landing anchor)", () => {
    const geo = buildFlightPath({ x: 500, y: 900 }, { x: 1200, y: 300 });
    const mid = { x: 850, y: 600 };
    expect(geo.control.y).toBeLessThanOrEqual(mid.y); // upward bow
    expect(geo.distance).toBeCloseTo(Math.hypot(700, -600), 5);
    expect(geo.source).toEqual({ x: 500, y: 900 });
    expect(geo.target).toEqual({ x: 1200, y: 300 });
  });

  it("fades the comet head out over the final stretch so it dissolves into the impact", () => {
    expect(cometHeadFade(0)).toBe(1);
    expect(cometHeadFade(0.5)).toBe(1);
    expect(cometHeadFade(0.8)).toBe(1);
    expect(cometHeadFade(0.9)).toBeCloseTo(0.5, 5); // halfway through the fade window
    expect(cometHeadFade(1)).toBe(0);
    // monotonically non-increasing across the fade window
    expect(cometHeadFade(0.95)).toBeLessThan(cometHeadFade(0.85));
  });

  it("evaluates the quadratic at its endpoints and midpoint", () => {
    const a = { x: 0, y: 0 };
    const c = { x: 50, y: 100 };
    const b = { x: 100, y: 0 };
    expect(quadraticPoint(a, c, b, 0)).toEqual(a);
    expect(quadraticPoint(a, c, b, 1)).toEqual(b);
    expect(quadraticPoint(a, c, b, 0.5)).toEqual({ x: 50, y: 50 });
  });

  it("eases flight from 0 to 1 monotonically and clamps out-of-range t", () => {
    expect(easeFlight(0)).toBe(0);
    expect(easeFlight(1)).toBe(1);
    expect(easeFlight(-1)).toBe(0);
    expect(easeFlight(2)).toBe(1);
    expect(easeFlight(0.5)).toBeGreaterThan(0.5); // fast-out easing
  });
});

describe("dispatch-comet timeline", () => {
  const T = DISPATCH_COMET_TIMING;

  it("sparks a launch charge before travel, with no comet yet", () => {
    const f = cometFrame(80, "full");
    expect(f.charge).toBeGreaterThan(0);
    expect(f.flight).toBeNull();
    expect(f.done).toBe(false);
  });

  it("flies the comet mid-sequence with eased progress in (0,1)", () => {
    const f = cometFrame(T.flightStartMs + T.flightDurMs / 2, "full");
    expect(f.flight).not.toBeNull();
    expect(f.flight!).toBeGreaterThan(0);
    expect(f.flight!).toBeLessThan(1);
  });

  it("pulses the impact and node ack near the landing, after the flight", () => {
    const f = cometFrame(T.impactStartMs + T.impactMs / 2, "full");
    expect(f.impact).toBeGreaterThan(0);
    const ack = cometFrame(T.ackStartMs + T.ackMs / 2, "full");
    expect(ack.ack).toBeGreaterThan(0);
  });

  it("reports done once the whole sequence has elapsed", () => {
    const f = cometFrame(T.totalMs + 1, "full");
    expect(f.done).toBe(true);
    expect(f.flight).toBeNull();
    expect(f.impact).toBe(0);
  });

  it("off mode gives a quiet target pulse with no travel", () => {
    const f = cometFrame(T.impactMs / 2, "off");
    expect(f.flight).toBeNull();
    expect(f.charge).toBe(0);
    expect(f.impact).toBeGreaterThan(0);
    expect(f.ack).toBeGreaterThan(0);
  });

  it("reduced motion drops travel AND the node ack — landing pulse only", () => {
    const f = cometFrame(T.impactMs / 2, "reduced");
    expect(f.flight).toBeNull();
    expect(f.charge).toBe(0);
    expect(f.impact).toBeGreaterThan(0);
    expect(f.ack).toBe(0);
  });

  it("keeps the total within the queue removal window (1250ms)", () => {
    expect(T.totalMs).toBeLessThanOrEqual(1250);
  });
});

describe("dispatch-comet palette", () => {
  it("uses the blue signal palette with no purple residue", () => {
    const values = Object.values(DISPATCH_COMET_PALETTE).join(" ").toLowerCase();
    expect(values).toContain("#38bdf8");
    expect(values).toContain("#7dd3fc");
    expect(values).not.toContain("#6366f1");
    expect(values).not.toContain("#8b5cf6");
  });
});
