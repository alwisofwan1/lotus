import { describe, expect, it } from "vitest";
import {
  MAX_DELETES_PER_BATCH,
  MAX_DRAW_OPS,
  planDrawOps,
  type DrawPlan,
  type DrawPlanContext,
} from "../canvas-draw-apply";

function ctx(overrides: Partial<DrawPlanContext> = {}): DrawPlanContext {
  let seq = 0;
  return {
    anchor: { x: 1000, y: 2000 },
    existingShapeIds: new Set<string>(),
    makeId: () => `id-${++seq}`,
    ...overrides,
  };
}

function okPlan(result: ReturnType<typeof planDrawOps>): DrawPlan {
  if ("error" in result) throw new Error(`expected plan, got error: ${result.error}`);
  return result;
}

describe("planDrawOps — batch-level guards", () => {
  it("rejects a non-array payload", () => {
    for (const bad of [null, undefined, "x", 42, {}]) {
      const result = planDrawOps(bad, ctx());
      expect("error" in result && result.error).toMatch(/ops/i);
    }
  });

  it("rejects an empty batch", () => {
    const result = planDrawOps([], ctx());
    expect("error" in result).toBe(true);
  });

  it(`rejects more than ${MAX_DRAW_OPS} ops outright`, () => {
    const ops = Array.from({ length: MAX_DRAW_OPS + 1 }, () => ({ op: "create_shape", shape: "rectangle" }));
    const result = planDrawOps(ops, ctx());
    expect("error" in result && result.error).toMatch(new RegExp(`${MAX_DRAW_OPS}`));
  });

  it(`rejects more than ${MAX_DELETES_PER_BATCH} deletes as a blast-radius guard`, () => {
    const existing = new Set(Array.from({ length: 10 }, (_, i) => `s${i}`));
    const ops = Array.from({ length: MAX_DELETES_PER_BATCH + 1 }, (_, i) => ({ op: "delete_shape", id: `s${i}` }));
    const result = planDrawOps(ops, ctx({ existingShapeIds: existing }));
    expect("error" in result && result.error).toMatch(/confirm/i);
  });
});

describe("planDrawOps — create_shape", () => {
  it("creates a rectangle at anchor-local coordinates translated to flow space", () => {
    const plan = okPlan(planDrawOps(
      [{ op: "create_shape", shape: "rectangle", at: [40, -20], size: [180, 90], text: "Login" }],
      ctx(),
    ));
    expect(plan.rejected).toEqual([]);
    expect(plan.creates).toHaveLength(1);
    const c = plan.creates[0];
    expect(c.spec.position).toEqual({ x: 1040, y: 1980 });
    expect(c.spec.size).toEqual({ w: 180, h: 90 });
    expect(c.spec.shape).toBe("rectangle");
    expect(c.spec.text).toBe("Login");
    expect(c.id).toBe("id-1");
  });

  it("defaults position to the anchor and size to the kind default", () => {
    const plan = okPlan(planDrawOps([{ op: "create_shape", shape: "ellipse" }], ctx()));
    expect(plan.creates[0].spec.position).toEqual({ x: 1000, y: 2000 });
    expect(plan.creates[0].spec.size.w).toBeGreaterThan(0);
    expect(plan.creates[0].spec.size.h).toBeGreaterThan(0);
  });

  it("rounds fractional coordinates and clamps size to sane bounds", () => {
    const plan = okPlan(planDrawOps(
      [{ op: "create_shape", shape: "rectangle", at: [0.4, 0.6], size: [1, 999999] }],
      ctx(),
    ));
    const c = plan.creates[0];
    expect(c.spec.position).toEqual({ x: 1000, y: 2001 });
    expect(c.spec.size.w).toBeGreaterThanOrEqual(8);
    expect(c.spec.size.h).toBeLessThanOrEqual(2000);
  });

  it("clamps runaway local offsets instead of placing shapes in deep space", () => {
    const plan = okPlan(planDrawOps(
      [{ op: "create_shape", shape: "rectangle", at: [9e9, -9e9] }],
      ctx(),
    ));
    const { x, y } = plan.creates[0].spec.position;
    expect(Math.abs(x - 1000)).toBeLessThanOrEqual(20000);
    expect(Math.abs(y - 2000)).toBeLessThanOrEqual(20000);
  });

  it("rejects unknown or non-drawable shape kinds per-op without failing the batch", () => {
    const plan = okPlan(planDrawOps(
      [
        { op: "create_shape", shape: "hexagon" },
        { op: "create_shape", shape: "image" },
        { op: "create_shape", shape: "diamond" },
      ],
      ctx(),
    ));
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].spec.shape).toBe("diamond");
    expect(plan.rejected.map((r) => r.index)).toEqual([0, 1]);
  });

  it("sanitizes style through the shape normalizer (bad fields dropped, good kept)", () => {
    const plan = okPlan(planDrawOps(
      [{
        op: "create_shape", shape: "rectangle",
        style: { strokeColor: "#f00", sloppiness: "wild", opacity: 250, fillStyle: "hachure" },
      }],
      ctx(),
    ));
    const style = plan.creates[0].spec.style;
    expect(style?.strokeColor).toBe("#f00");
    expect(style?.fillStyle).toBe("hachure");
    expect(style?.sloppiness).toBeUndefined();
    expect(style?.opacity).toBeUndefined();
  });

  it("records the caller-supplied ref for connector back-references", () => {
    const plan = okPlan(planDrawOps(
      [{ op: "create_shape", shape: "rectangle", ref: "$1" }],
      ctx(),
    ));
    expect(plan.creates[0].ref).toBe("$1");
  });

  it("rejects duplicate refs within one batch", () => {
    const plan = okPlan(planDrawOps(
      [
        { op: "create_shape", shape: "rectangle", ref: "$1" },
        { op: "create_shape", shape: "rectangle", ref: "$1" },
      ],
      ctx(),
    ));
    expect(plan.creates).toHaveLength(1);
    expect(plan.rejected[0]).toMatchObject({ index: 1 });
    expect(plan.rejected[0].reason).toMatch(/ref/i);
  });
});

describe("planDrawOps — create_connector", () => {
  it("connects two shapes created in the same batch via refs", () => {
    const plan = okPlan(planDrawOps(
      [
        { op: "create_shape", shape: "rectangle", ref: "$a" },
        { op: "create_shape", shape: "diamond", ref: "$b" },
        { op: "create_connector", from: "$a", to: "$b", label: "yes" },
      ],
      ctx(),
    ));
    expect(plan.connectors).toHaveLength(1);
    expect(plan.connectors[0]).toMatchObject({ source: "id-1", target: "id-2", label: "yes" });
  });

  it("connects existing board shapes by id", () => {
    const plan = okPlan(planDrawOps(
      [{ op: "create_connector", from: "node-x", to: "node-y" }],
      ctx({ existingShapeIds: new Set(["node-x", "node-y"]) }),
    ));
    expect(plan.connectors[0]).toMatchObject({ source: "node-x", target: "node-y" });
  });

  it("rejects connectors whose endpoints cannot be resolved", () => {
    const plan = okPlan(planDrawOps(
      [{ op: "create_connector", from: "$ghost", to: "nowhere" }],
      ctx(),
    ));
    expect(plan.connectors).toEqual([]);
    expect(plan.rejected[0].reason).toMatch(/from/i);
  });

  it("rejects self-connectors", () => {
    const plan = okPlan(planDrawOps(
      [{ op: "create_connector", from: "node-x", to: "node-x" }],
      ctx({ existingShapeIds: new Set(["node-x"]) }),
    ));
    expect(plan.connectors).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
  });
});

describe("planDrawOps — update_shape / delete_shape", () => {
  it("updates an existing shape with a sanitized patch", () => {
    const plan = okPlan(planDrawOps(
      [{ op: "update_shape", id: "s1", patch: { text: "Renamed", style: { opacity: 250, strokeColor: "#0f0" } } }],
      ctx({ existingShapeIds: new Set(["s1"]) }),
    ));
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].id).toBe("s1");
    expect(plan.updates[0].patch.text).toBe("Renamed");
    expect((plan.updates[0].patch.style as { strokeColor?: string }).strokeColor).toBe("#0f0");
    expect((plan.updates[0].patch.style as { opacity?: number }).opacity).toBeUndefined();
  });

  it("rejects updates against unknown ids, but allows updates against batch refs", () => {
    const plan = okPlan(planDrawOps(
      [
        { op: "create_shape", shape: "rectangle", ref: "$r" },
        { op: "update_shape", id: "$r", patch: { text: "late text" } },
        { op: "update_shape", id: "missing", patch: { text: "x" } },
      ],
      ctx(),
    ));
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].id).toBe("id-1");
    expect(plan.rejected[0].index).toBe(2);
  });

  it("rejects updates with an empty effective patch", () => {
    const plan = okPlan(planDrawOps(
      [{ op: "update_shape", id: "s1", patch: {} }],
      ctx({ existingShapeIds: new Set(["s1"]) }),
    ));
    expect(plan.updates).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
  });

  it("deletes existing shapes and rejects unknown ids", () => {
    const plan = okPlan(planDrawOps(
      [
        { op: "delete_shape", id: "s1" },
        { op: "delete_shape", id: "ghost" },
      ],
      ctx({ existingShapeIds: new Set(["s1"]) }),
    ));
    expect(plan.deletes).toEqual(["s1"]);
    expect(plan.rejected[0].index).toBe(1);
  });

  it("rejects unrecognized op names per-op", () => {
    const plan = okPlan(planDrawOps(
      [{ op: "explode_board" }, { op: "create_shape", shape: "text", text: "hi" }],
      ctx(),
    ));
    expect(plan.rejected[0].index).toBe(0);
    expect(plan.creates).toHaveLength(1);
  });
});
