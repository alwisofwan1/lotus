import type { CanvasShapeKind, CanvasShapeStyle, ShapeNodePatch } from "../../types/canvas";
import { DEFAULT_SHAPE_SIZE } from "../canvas-node-placement";
import { normalizeShapeFields } from "../canvas-shape";

/**
 * Pure planner for agent-issued draw batches (MCP `lotus_canvas_draw`). Turns an untrusted
 * `ops` payload into a validated {@link DrawPlan} of shapes/connectors/updates/deletes the
 * frontend can apply verbatim, or a single batch-level `{ error }` when the whole request is
 * unsafe. No React, ReactFlow, DOM, or store access — every side effect (id minting, the
 * anchor origin, the set of shapes already on the board) is injected via {@link DrawPlanContext}.
 *
 * Design mirrors tldraw's agent action model: sanitize/repair per-op and reject individual ops
 * rather than failing the batch, so one malformed op never discards the agent's other work.
 * Coordinates arrive *local to an anchor* (small, rounded numbers the model reasons about well)
 * and are translated to absolute flow space here.
 */

/** Hard ceiling on ops in a single batch — a runaway-loop backstop, not a normal limit. */
export const MAX_DRAW_OPS = 60;
/** A batch deleting more than this many shapes is refused pending explicit user confirmation. */
export const MAX_DELETES_PER_BATCH = 5;
/** Local offsets beyond this (in flow px) are clamped so a bad number can't fling a shape into deep space. */
export const MAX_LOCAL_OFFSET = 20000;

const MIN_SHAPE_DIM = 8;
const MAX_SHAPE_DIM = 2000;

/** Shape kinds an agent may create. `image` is excluded (needs a real asset URI, not model output). */
const DRAWABLE_KINDS = new Set<CanvasShapeKind>(["rectangle", "diamond", "ellipse", "text", "arrow", "line", "draw"]);

export interface DrawPlanContext {
  /** Absolute flow-space origin that op-local coordinates are measured from. */
  anchor: { x: number; y: number };
  /** Ids of shapes already on the board — the resolvable targets for connect/update/delete. */
  existingShapeIds: Set<string>;
  /** Mints a fresh, unique node/edge id. Injected so planning stays deterministic in tests. */
  makeId: () => string;
}

export interface DrawShapeSpec {
  shape: CanvasShapeKind;
  position: { x: number; y: number };
  size: { w: number; h: number };
  text?: string;
  areaLabel?: string;
  points?: Array<[number, number]>;
  style?: CanvasShapeStyle;
}

export interface DrawCreate {
  id: string;
  /** Caller-supplied batch reference (e.g. `"$1"`) so later ops can point at this new shape. */
  ref?: string;
  spec: DrawShapeSpec;
}

export interface DrawConnector {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface DrawUpdate {
  id: string;
  patch: ShapeNodePatch;
}

export interface DrawRejection {
  index: number;
  reason: string;
}

export interface DrawPlan {
  creates: DrawCreate[];
  connectors: DrawConnector[];
  updates: DrawUpdate[];
  deletes: string[];
  rejected: DrawRejection[];
}

export type DrawPlanResult = DrawPlan | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Read an op's `[x, y]`-style pair, defaulting each missing/invalid component to `fallback`. */
function readPair(value: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(value)) return fallback;
  const a = finiteNumber(value[0]);
  const b = finiteNumber(value[1]);
  return [a ?? fallback[0], b ?? fallback[1]];
}

function readRef(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolve a connector/update/delete target reference to a concrete node id.
 * A `$`-prefixed token resolves against refs minted earlier in *this* batch; any other string
 * must name a shape already on the board. Returns null when neither matches.
 */
function resolveTarget(token: string, refs: Map<string, string>, existing: Set<string>): string | null {
  if (token.startsWith("$")) return refs.get(token) ?? null;
  return existing.has(token) ? token : null;
}

type CreateDecoration = Pick<DrawShapeSpec, "text" | "areaLabel" | "points" | "style">;

/** Sanitize a create op's decorative fields by routing them through the shared shape normalizer. */
function sanitizeCreateFields(op: Record<string, unknown>, shape: CanvasShapeKind): CreateDecoration {
  const fields = normalizeShapeFields({ shape, text: op.text, areaLabel: op.areaLabel, style: op.style, points: op.points });
  const out: CreateDecoration = {};
  if (fields.text !== undefined) out.text = fields.text;
  if (fields.areaLabel !== undefined) out.areaLabel = fields.areaLabel;
  if (fields.points) out.points = fields.points;
  if (fields.style) out.style = fields.style;
  return out;
}

/** Sanitize an update patch, keeping only recognized, valid fields. Empty result → caller rejects. */
function sanitizePatch(raw: unknown): ShapeNodePatch {
  if (!isRecord(raw)) return {};
  const fields = normalizeShapeFields({ shape: "rectangle", text: raw.text, areaLabel: raw.areaLabel, style: raw.style, points: raw.points });
  const patch: ShapeNodePatch = {};
  if (fields.text !== undefined) patch.text = fields.text;
  if (fields.areaLabel !== undefined) patch.areaLabel = fields.areaLabel;
  if (fields.style) patch.style = fields.style;
  if (fields.points) patch.points = fields.points;
  return patch;
}

export function planDrawOps(payload: unknown, ctx: DrawPlanContext): DrawPlanResult {
  if (!Array.isArray(payload)) return { error: "`ops` must be an array of draw operations." };
  if (payload.length === 0) return { error: "`ops` is empty — nothing to draw." };
  if (payload.length > MAX_DRAW_OPS) {
    return { error: `Too many operations: ${payload.length} exceeds the ${MAX_DRAW_OPS}-op limit for one batch.` };
  }

  const deleteCount = payload.reduce((n, op) => (isRecord(op) && op.op === "delete_shape" ? n + 1 : n), 0);
  if (deleteCount > MAX_DELETES_PER_BATCH) {
    return { error: `Refusing to delete ${deleteCount} shapes in one batch (limit ${MAX_DELETES_PER_BATCH}). Ask the user to confirm a bulk delete.` };
  }

  const plan: DrawPlan = { creates: [], connectors: [], updates: [], deletes: [], rejected: [] };
  const refs = new Map<string, string>();

  payload.forEach((raw, index) => {
    const reject = (reason: string) => plan.rejected.push({ index, reason });
    if (!isRecord(raw)) return reject("Operation must be an object.");

    switch (raw.op) {
      case "create_shape": {
        const shape = raw.shape as CanvasShapeKind;
        if (!DRAWABLE_KINDS.has(shape)) {
          return reject(`Cannot create shape kind "${String(raw.shape)}". Allowed: ${[...DRAWABLE_KINDS].join(", ")}.`);
        }
        const ref = readRef(raw.ref);
        if (ref) {
          if (!ref.startsWith("$")) return reject(`ref "${ref}" must start with "$".`);
          if (refs.has(ref)) return reject(`Duplicate ref "${ref}" in this batch.`);
        }
        const [ox, oy] = readPair(raw.at, [0, 0]);
        const [rw, rh] = readPair(raw.size, [DEFAULT_SHAPE_SIZE.w, DEFAULT_SHAPE_SIZE.h]);
        const position = {
          x: Math.round(ctx.anchor.x + clamp(ox, -MAX_LOCAL_OFFSET, MAX_LOCAL_OFFSET)),
          y: Math.round(ctx.anchor.y + clamp(oy, -MAX_LOCAL_OFFSET, MAX_LOCAL_OFFSET)),
        };
        const size = {
          w: Math.round(clamp(rw, MIN_SHAPE_DIM, MAX_SHAPE_DIM)),
          h: Math.round(clamp(rh, MIN_SHAPE_DIM, MAX_SHAPE_DIM)),
        };
        const id = ctx.makeId();
        if (ref) refs.set(ref, id);
        plan.creates.push({ id, ...(ref ? { ref } : {}), spec: { shape, position, size, ...sanitizeCreateFields(raw, shape) } });
        return;
      }

      case "create_connector": {
        const from = readRef(raw.from);
        const to = readRef(raw.to);
        if (!from) return reject("connector `from` is required.");
        if (!to) return reject("connector `to` is required.");
        const source = resolveTarget(from, refs, ctx.existingShapeIds);
        if (!source) return reject(`connector \`from\` "${from}" does not resolve to a shape.`);
        const target = resolveTarget(to, refs, ctx.existingShapeIds);
        if (!target) return reject(`connector \`to\` "${to}" does not resolve to a shape.`);
        if (source === target) return reject("connector endpoints must differ (no self-connectors).");
        const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined;
        plan.connectors.push({ id: ctx.makeId(), source, target, ...(label ? { label } : {}) });
        return;
      }

      case "update_shape": {
        const token = readRef(raw.id);
        if (!token) return reject("update_shape `id` is required.");
        const id = resolveTarget(token, refs, ctx.existingShapeIds);
        if (!id) return reject(`update_shape \`id\` "${token}" does not resolve to a shape.`);
        const patch = sanitizePatch(raw.patch);
        if (Object.keys(patch).length === 0) return reject("update_shape `patch` has no valid fields.");
        plan.updates.push({ id, patch });
        return;
      }

      case "delete_shape": {
        const token = readRef(raw.id);
        if (!token) return reject("delete_shape `id` is required.");
        const id = resolveTarget(token, refs, ctx.existingShapeIds);
        if (!id) return reject(`delete_shape \`id\` "${token}" does not resolve to a shape.`);
        plan.deletes.push(id);
        return;
      }

      default:
        return reject(`Unknown operation "${String(raw.op)}".`);
    }
  });

  return plan;
}
