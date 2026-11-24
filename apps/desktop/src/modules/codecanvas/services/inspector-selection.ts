import type { CanvasShapeKind, CanvasShapeStyle } from "../types/canvas";
import { inspectorSectionsFor, type InspectorSection } from "./inspector-schema";

/**
 * Pure helpers for the multi-select Inspector. Keeping the "shared vs mixed" computation and
 * the section intersection out of the panel/container means they are unit-tested in isolation
 * and the container just wires them up.
 */

const STYLE_KEYS: Array<keyof CanvasShapeStyle> = [
  "strokeColor", "strokeWidth", "strokeStyle", "sloppiness", "opacity", "fill", "fillStyle", "fontFamily", "fontSize", "textAlign",
];

/**
 * Reduce a selection's styles to the values they all agree on. A field is `shared` only when
 * every shape has the identical value (absent counts as a distinct value); any disagreement
 * lands the field in `mixed` so the panel can show "no active option" instead of lying.
 */
export function sharedShapeStyle(styles: Array<CanvasShapeStyle | undefined>): {
  shared: CanvasShapeStyle;
  mixed: Set<keyof CanvasShapeStyle>;
} {
  const shared: CanvasShapeStyle = {};
  const mixed = new Set<keyof CanvasShapeStyle>();
  for (const key of STYLE_KEYS) {
    const first = styles[0]?.[key];
    const allEqual = styles.every((s) => s?.[key] === first);
    if (allEqual && first !== undefined) {
      (shared[key] as unknown) = first;
    } else if (!allEqual) {
      mixed.add(key);
    }
  }
  return { shared, mixed };
}

/**
 * Sections to show for a multi-selection: the intersection of each kind's section set (so a
 * mixed rectangle+text selection drops Background and Font), minus the per-shape `label`
 * field, which is not batch-editable.
 */
export function selectionSections(kinds: CanvasShapeKind[]): InspectorSection[] {
  if (kinds.length === 0) return [];
  const sets = kinds.map((k) => new Set(inspectorSectionsFor(k)));
  const base = inspectorSectionsFor(kinds[0]);
  return base.filter((section) => section !== "label" && sets.every((set) => set.has(section)));
}
