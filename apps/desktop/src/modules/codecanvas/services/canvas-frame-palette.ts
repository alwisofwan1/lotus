import type { Node } from "@xyflow/react";

/**
 * Frame colours (ADR-0050, decisions 12/15). Six named hues, auto-assigned in this order, none
 * near a STATUS_TONES hue so a Frame never reads as blocked / done / running. Each is emitted as a
 * canvas theme token `--canvas-frame-<id>` (resolve-canvas-theme); `hex` is only the fallback.
 */
export interface FrameColor {
  id: string;
  name: string;
  hex: string;
}

export const FRAME_COLORS: readonly FrameColor[] = [
  { id: "iris", name: "Iris", hex: "#9F95EC" },
  { id: "moss", name: "Moss", hex: "#A8BB72" },
  { id: "rose", name: "Rose", hex: "#E58AB8" },
  { id: "orchid", name: "Orchid", hex: "#C588E3" },
  { id: "mist", name: "Mist", hex: "#A0B4BC" },
  { id: "stone", name: "Stone", hex: "#B3ADA4" },
];

/** The colour for an id; unknown or missing ids resolve to the first colour. */
export function frameColorOf(colorId: string | undefined): FrameColor {
  return FRAME_COLORS.find((c) => c.id === colorId) ?? FRAME_COLORS[0];
}

/** CSS colour for a Frame colour id: the theme token with the palette hex as fallback. */
export function frameColorCss(colorId: string | undefined): string {
  const c = frameColorOf(colorId);
  return `var(--canvas-frame-${c.id}, ${c.hex})`;
}

/** The first colour no Frame uses; once all are used, the least used (earliest on ties). */
export function nextFrameColorId(nodes: readonly Node[]): string {
  const counts = new Map<string, number>(FRAME_COLORS.map((c) => [c.id, 0]));
  for (const n of nodes) {
    if (n.type !== "frame") continue;
    const id = (n.data as { colorId?: unknown }).colorId;
    if (typeof id === "string" && counts.has(id)) counts.set(id, counts.get(id)! + 1);
  }
  let best = FRAME_COLORS[0].id;
  for (const c of FRAME_COLORS) if (counts.get(c.id)! < counts.get(best)!) best = c.id;
  return best;
}
