"use client";
import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { SendToBack, BringToFront, Copy, Trash2, Group, Ungroup } from "lucide-react";
import type { CanvasArrowhead, CanvasShapeKind, CanvasShapeStyle, CanvasStrokeStyle, ShapeNodePatch } from "../types/canvas";
import { SHAPE_DEFAULTS, SHAPE_STROKE_WIDTHS, STROKE_COLORS, FILL_COLORS, FONT_FAMILIES, TEXT_ALIGNS, VERTICAL_ALIGNS, ARROW_TYPES, ARROWHEADS, contrastInk, colorName } from "../services/shape-defaults";
import { inspectorSectionsFor, type InspectorSection } from "../services/inspector-schema";
import { scrollEdges } from "../services/inspector-scroll";

const STROKE_STYLES: CanvasStrokeStyle[] = ["solid", "dashed", "dotted"];
const SLOPPINESS: Array<NonNullable<CanvasShapeStyle["sloppiness"]>> = ["architect", "artist", "cartoonist"];
const FILL_STYLES: Array<NonNullable<CanvasShapeStyle["fillStyle"]>> = ["solid", "hachure", "cross-hatch"];
const FONT_SIZES: Array<NonNullable<CanvasShapeStyle["fontSize"]>> = ["S", "M", "L", "XL"];
const alignIcon: Record<NonNullable<CanvasShapeStyle["textAlign"]>, string> = {
  left: "M3 5h14M3 10h9M3 15h12",
  center: "M3 5h14M6 10h8M5 15h10",
  right: "M3 5h14M8 10h9M6 15h11",
};
const vAlignIcon: Record<NonNullable<CanvasShapeStyle["verticalAlign"]>, string> = {
  top: "M5 4h10M10 7v9",
  middle: "M5 10h10M10 4v3.5M10 12.5v3.5",
  bottom: "M5 16h10M10 4v9",
};

export type ArrangeAction = "front" | "back" | "duplicate" | "delete";

interface InspectorPanelProps {
  shape: CanvasShapeKind;
  text?: string;
  areaLabel?: string;
  style?: CanvasShapeStyle;
  /** Explicit section set — used for multi-select (schema intersection). Defaults to the single-shape schema. */
  sections?: InspectorSection[];
  /** Style fields that differ across a multi-selection — rendered with no active option. */
  mixed?: Set<keyof CanvasShapeStyle>;
  onPatch: (patch: ShapeNodePatch) => void;
  onArrange: (action: ArrangeAction) => void;
  /** Grouping — Group/Ungroup buttons render in the Arrange section only when actionable. */
  canGroup?: boolean;
  canUngroup?: boolean;
  onGroup?: () => void;
  onUngroup?: () => void;
}

const dashPreview: Record<CanvasStrokeStyle, string> = { solid: "", dashed: "4 3", dotted: "1 3" };
const fillStyleLabel: Record<NonNullable<CanvasShapeStyle["fillStyle"]>, string> = {
  solid: "Solid fill", hachure: "Hachure fill", "cross-hatch": "Cross-hatch fill",
};

/**
 * Right-edge inspector for the selected shape (Image #11). Presentational — it owns the
 * style merge (data.style is shallow-merged on patch) and reports edits via callbacks.
 * Which sections render, and in what order, is driven by `inspectorSectionsFor(shape)` so
 * the panel adapts to the element kind instead of branching on a pile of ternaries.
 */
export const InspectorPanel = memo(function InspectorPanel({ shape, text, areaLabel, style, sections: sectionsProp, mixed, onPatch, onArrange, canGroup, canUngroup, onGroup, onUngroup }: InspectorPanelProps) {
  const s = style ?? {};
  // Emit style *deltas* (only the changed fields), so the same patch applies cleanly to every
  // shape in a multi-selection without clobbering each shape's other values (the consumer merges).
  const patchStyle = (partial: CanvasShapeStyle) => onPatch({ style: partial });
  const isText = shape === "text";
  const sections = sectionsProp ?? inspectorSectionsFor(shape);

  // Active state for a single-choice option, suppressed when the field is mixed across a selection.
  const on = <K extends keyof CanvasShapeStyle>(field: K, value: CanvasShapeStyle[K], def: CanvasShapeStyle[K]) =>
    !mixed?.has(field) && (s[field] ?? def) === value;

  const pickBackground = (color: string) => patchStyle({ fill: color, fillStyle: s.fillStyle ?? SHAPE_DEFAULTS.fillStyle });
  const clearBackground = () => onPatch({ style: { fill: undefined, fillStyle: undefined } });

  const renderSection = (key: InspectorSection) => {
    switch (key) {
      case "label":
        return (
          <div key={key} className="insp-field">
            <span className="insp-label">{isText ? "Text" : "Area label"}</span>
            <input
              className="insp-input"
              aria-label={isText ? "Text" : "Area label"}
              placeholder={isText ? "Type text…" : "e.g. checkout flow"}
              value={(isText ? text : areaLabel) ?? ""}
              onChange={(e) => onPatch(isText ? { text: e.target.value } : { areaLabel: e.target.value })}
            />
          </div>
        );

      case "stroke":
        return (
          <div key={key}>
            <span className="insp-label">Stroke</span>
            <div className="insp-swatches" role="radiogroup" ref={initRovingTabIndex} onKeyDown={onRadioGroupKeys} aria-label="Stroke color">
              {STROKE_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="insp-sw"
                  role="radio"
                  aria-label={`Stroke ${colorName(color)}`}
                  aria-checked={on("strokeColor", color, SHAPE_DEFAULTS.strokeColor)}
                  style={{ background: color }}
                  onClick={() => patchStyle({ strokeColor: color })}
                >
                  {on("strokeColor", color, SHAPE_DEFAULTS.strokeColor) ? swatchCheck(color) : null}
                </button>
              ))}
              <span className="insp-sw-div" aria-hidden="true" />
              <label className="insp-sw insp-sw-custom" style={{ background: s.strokeColor ?? SHAPE_DEFAULTS.strokeColor }} title="Custom color">
                <input
                  type="color"
                  aria-label="Custom stroke color"
                  value={s.strokeColor ?? SHAPE_DEFAULTS.strokeColor}
                  onChange={(e) => patchStyle({ strokeColor: e.target.value })}
                />
              </label>
            </div>
          </div>
        );

      case "background":
        return (
          <div key={key}>
            <span className="insp-label">Background</span>
            <div className="insp-swatches" role="radiogroup" ref={initRovingTabIndex} onKeyDown={onRadioGroupKeys} aria-label="Background color">
              <button
                type="button"
                className="insp-sw insp-sw-transparent"
                role="radio"
                aria-label="Background transparent (none)"
                aria-checked={!mixed?.has("fill") && s.fill === undefined}
                onClick={clearBackground}
              >
                <svg viewBox="0 0 22 22" width="14" height="14" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M5.5 16.5 16.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
              {FILL_COLORS.map(([hex, name]) => (
                <button
                  key={hex}
                  type="button"
                  className="insp-sw"
                  role="radio"
                  aria-label={`Background ${name}`}
                  aria-checked={!mixed?.has("fill") && s.fill === hex}
                  style={{ background: hex }}
                  onClick={() => pickBackground(hex)}
                >
                  {!mixed?.has("fill") && s.fill === hex ? swatchCheck(hex) : null}
                </button>
              ))}
              <span className="insp-sw-div" aria-hidden="true" />
              <label className="insp-sw insp-sw-custom" style={{ background: s.fill ?? FILL_COLORS[0][0] }} title="Custom color">
                <input
                  type="color"
                  aria-label="Custom background color"
                  value={s.fill ?? FILL_COLORS[0][0]}
                  onChange={(e) => pickBackground(e.target.value)}
                />
              </label>
            </div>
            {s.fill !== undefined ? (
              <div className="insp-seg" role="radiogroup" ref={initRovingTabIndex} onKeyDown={onRadioGroupKeys} aria-label="Fill style" style={{ marginTop: 6 }}>
                {FILL_STYLES.map((fst) => (
                  <button
                    key={fst}
                    type="button"
                    className="insp-opt"
                    role="radio"
                    aria-label={fillStyleLabel[fst]}
                    aria-checked={on("fillStyle", fst, SHAPE_DEFAULTS.fillStyle)}
                    onClick={() => patchStyle({ fillStyle: fst })}
                  >
                    {fillStyleIcon(fst)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );

      case "strokeWidth":
        return (
          <div key={key}>
            <span className="insp-label">Stroke width</span>
            <div className="insp-seg" role="radiogroup" ref={initRovingTabIndex} onKeyDown={onRadioGroupKeys} aria-label="Stroke width">
              {SHAPE_STROKE_WIDTHS.map(([label, value]) => (
                <button
                  key={value}
                  type="button"
                  className="insp-opt"
                  role="radio"
                  aria-label={label}
                  aria-checked={on("strokeWidth", value, SHAPE_DEFAULTS.strokeWidth)}
                  onClick={() => patchStyle({ strokeWidth: value })}
                >
                  <span className="insp-wbar" style={{ height: `${Math.max(2, value)}px` }} />
                </button>
              ))}
            </div>
          </div>
        );

      case "strokeStyle":
        return (
          <div key={key}>
            <span className="insp-label">Stroke style</span>
            <div className="insp-seg" role="radiogroup" ref={initRovingTabIndex} onKeyDown={onRadioGroupKeys} aria-label="Stroke style">
              {STROKE_STYLES.map((st) => (
                <button
                  key={st}
                  type="button"
                  className="insp-opt"
                  role="radio"
                  aria-label={st}
                  aria-checked={on("strokeStyle", st, SHAPE_DEFAULTS.strokeStyle)}
                  onClick={() => patchStyle({ strokeStyle: st })}
                >
                  <svg viewBox="0 0 24 8" width="22" height="8" aria-hidden="true">
                    <path d="M2 4h20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={dashPreview[st] || undefined} />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        );

      case "sloppiness":
        return (
          <div key={key}>
            <span className="insp-label">Sloppiness</span>
            <div className="insp-seg" role="radiogroup" ref={initRovingTabIndex} onKeyDown={onRadioGroupKeys} aria-label="Sloppiness">
              {SLOPPINESS.map((sl, i) => (
                <button
                  key={sl}
                  type="button"
                  className="insp-opt"
                  role="radio"
                  aria-label={sl}
                  aria-checked={on("sloppiness", sl, SHAPE_DEFAULTS.sloppiness)}
                  onClick={() => patchStyle({ sloppiness: sl })}
                >
                  <svg viewBox="0 0 24 12" width="22" height="12" aria-hidden="true">
                    <path
                      d={i === 0 ? "M3 7c5-2 8-2 18 0" : i === 1 ? "M3 8c4-5 6 3 9-2s5-3 9 1" : "M3 6c3-5 4 4 6-1s3-5 5 0 3 4 6-2"}
                      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
                    />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        );

      case "font":
        return (
          <div key={key}>
            <span className="insp-label">Font</span>
            <div className="insp-seg" role="radiogroup" ref={initRovingTabIndex} onKeyDown={onRadioGroupKeys} aria-label="Font family">
              {FONT_FAMILIES.map(([id, cssVar]) => (
                <button
                  key={id}
                  type="button"
                  className="insp-opt"
                  role="radio"
                  aria-label={`Font ${id}`}
                  aria-checked={on("fontFamily", id, SHAPE_DEFAULTS.fontFamily)}
                  onClick={() => patchStyle({ fontFamily: id })}
                >
                  <span style={{ fontFamily: cssVar, fontSize: 15, lineHeight: 1 }} aria-hidden="true">Ag</span>
                </button>
              ))}
            </div>
          </div>
        );

      case "size":
        return (
          <div key={key}>
            <span className="insp-label">Size</span>
            <div className="insp-seg" role="radiogroup" ref={initRovingTabIndex} onKeyDown={onRadioGroupKeys} aria-label="Font size">
              {FONT_SIZES.map((sz) => (
                <button
                  key={sz}
                  type="button"
                  className="insp-opt"
                  role="radio"
                  aria-label={`Size ${sz}`}
                  aria-checked={on("fontSize", sz, SHAPE_DEFAULTS.fontSize)}
                  onClick={() => patchStyle({ fontSize: sz })}
                >
                  {sz}
                </button>
              ))}
            </div>
            <div className="insp-seg" role="radiogroup" ref={initRovingTabIndex} onKeyDown={onRadioGroupKeys} aria-label="Text align" style={{ marginTop: 6 }}>
              {TEXT_ALIGNS.map((al) => (
                <button
                  key={al}
                  type="button"
                  className="insp-opt"
                  role="radio"
                  aria-label={`Align ${al}`}
                  aria-checked={on("textAlign", al, SHAPE_DEFAULTS.textAlign)}
                  onClick={() => patchStyle({ textAlign: al })}
                >
                  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                    <path d={alignIcon[al]} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
                  </svg>
                </button>
              ))}
            </div>
            <div className="insp-seg" role="radiogroup" ref={initRovingTabIndex} onKeyDown={onRadioGroupKeys} aria-label="Vertical align" style={{ marginTop: 6 }}>
              {VERTICAL_ALIGNS.map((va) => (
                <button
                  key={va}
                  type="button"
                  className="insp-opt"
                  role="radio"
                  aria-label={`Align ${va}`}
                  aria-checked={on("verticalAlign", va, SHAPE_DEFAULTS.verticalAlign)}
                  onClick={() => patchStyle({ verticalAlign: va })}
                >
                  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                    <path d={vAlignIcon[va]} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        );

      case "arrowType":
        return (
          <div key={key}>
            <span className="insp-label">Arrow type</span>
            <div className="insp-seg" role="radiogroup" ref={initRovingTabIndex} onKeyDown={onRadioGroupKeys} aria-label="Arrow type">
              {ARROW_TYPES.map((at) => (
                <button
                  key={at}
                  type="button"
                  className="insp-opt"
                  role="radio"
                  aria-label={`Arrow type ${at}`}
                  aria-checked={on("arrowType", at, SHAPE_DEFAULTS.arrowType)}
                  onClick={() => patchStyle({ arrowType: at })}
                >
                  {arrowTypeIcon(at)}
                </button>
              ))}
            </div>
          </div>
        );

      case "arrowheads":
        return (
          <div key={key}>
            <span className="insp-label">Arrowheads</span>
            {(["start", "end"] as const).map((endName) => (
              <div key={endName} className="insp-seg" role="radiogroup" ref={initRovingTabIndex} onKeyDown={onRadioGroupKeys} aria-label={`${endName === "start" ? "Start" : "End"} arrowhead`} style={{ marginTop: endName === "end" ? 6 : 0 }}>
                {ARROWHEADS.map((head) => {
                  const field = endName === "start" ? "startArrowhead" : "endArrowhead";
                  const def = endName === "start" ? SHAPE_DEFAULTS.startArrowhead : SHAPE_DEFAULTS.endArrowhead;
                  return (
                    <button
                      key={head}
                      type="button"
                      className="insp-opt"
                      role="radio"
                      aria-label={`${endName === "start" ? "Start" : "End"} ${head}`}
                      aria-checked={on(field, head, def)}
                      onClick={() => patchStyle({ [field]: head })}
                    >
                      {arrowheadIcon(head, endName === "start")}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        );

      case "opacity":
        return (
          <div key={key}>
            <span className="insp-label">Opacity</span>
            <div className="insp-op-row">
              <input
                className="insp-range"
                type="range"
                min={0}
                max={100}
                aria-label="Opacity"
                aria-valuetext={`${s.opacity ?? SHAPE_DEFAULTS.opacity}%`}
                value={s.opacity ?? SHAPE_DEFAULTS.opacity}
                onChange={(e) => patchStyle({ opacity: Number(e.target.value) })}
              />
              <span className="insp-op-val">{s.opacity ?? SHAPE_DEFAULTS.opacity}</span>
            </div>
          </div>
        );

      case "arrange":
        return (
          <div key={key}>
            <span className="insp-label">Arrange</span>
            <div className="insp-seg">
              <button type="button" className="insp-opt" aria-label="Send to back" onClick={() => onArrange("back")}><SendToBack size={17} /></button>
              <button type="button" className="insp-opt" aria-label="Bring to front" onClick={() => onArrange("front")}><BringToFront size={17} /></button>
              <button type="button" className="insp-opt" aria-label="Duplicate" onClick={() => onArrange("duplicate")}><Copy size={17} /></button>
              <button type="button" className="insp-opt" aria-label="Delete" onClick={() => onArrange("delete")}><Trash2 size={17} /></button>
            </div>
            {(canGroup || canUngroup) && (
              <div className="insp-seg" style={{ marginTop: 6 }}>
                <button type="button" className="insp-opt" aria-label="Group selection" title="Group (⌘G)" disabled={!canGroup} onClick={onGroup}><Group size={17} /></button>
                <button type="button" className="insp-opt" aria-label="Ungroup selection" title="Ungroup (⇧⌘G)" disabled={!canUngroup} onClick={onUngroup}><Ungroup size={17} /></button>
              </div>
            )}
          </div>
        );
    }
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<{ up: boolean; down: boolean }>({ up: false, down: false });
  const refreshEdges = () => { const el = scrollRef.current; if (el) setEdges(scrollEdges(el)); };
  // Re-measure when the section set changes (different shape kind → different content height).
  useEffect(refreshEdges, [shape, sections.length]);

  return (
    <aside
      className="canvas-inspector"
      aria-label="Shape properties"
      data-scroll={`${edges.up ? "up " : ""}${edges.down ? "down" : ""}`.trim() || undefined}
    >
      <div className="insp-scroll" ref={scrollRef} onScroll={refreshEdges}>
        {sections.map(renderSection)}
      </div>
    </aside>
  );
});

// ── Roving-tabindex radio groups: one tab stop per group + arrow-key navigation (selects on move).
function initRovingTabIndex(el: HTMLDivElement | null) {
  if (!el) return;
  const radios = Array.from(el.querySelectorAll<HTMLElement>('[role="radio"]'));
  if (!radios.length) return;
  radios.forEach((r) => { r.tabIndex = -1; });
  (radios.find((r) => r.getAttribute("aria-checked") === "true") ?? radios[0]).tabIndex = 0;
}
function onRadioGroupKeys(e: ReactKeyboardEvent<HTMLDivElement>) {
  const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!dir) return;
  const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
  if (!radios.length) return;
  e.preventDefault();
  const cur = radios.indexOf(document.activeElement as HTMLElement);
  const next = radios[((cur < 0 ? 0 : cur) + dir + radios.length) % radios.length];
  radios.forEach((r) => { r.tabIndex = -1; });
  next.tabIndex = 0;
  next.focus();
  next.click(); // radiogroup convention: navigating also selects
}

/** A check mark drawn on the selected swatch, inked for contrast so it reads on any color. */
function swatchCheck(color: string) {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke={contrastInk(color)} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function arrowTypeIcon(t: NonNullable<CanvasShapeStyle["arrowType"]>) {
  const d = t === "straight" ? "M3 17 19 5" : t === "curved" ? "M3 17 C9 5 13 5 19 5" : "M3 5 H11 V17 H19";
  return (
    <svg viewBox="0 0 22 22" width="20" height="20" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function arrowheadIcon(h: CanvasArrowhead, atStart: boolean) {
  // A short shaft with the head drawn at the relevant end; "none" is just the shaft.
  const tipX = atStart ? 3 : 19;
  const baseX = atStart ? 11 : 11;
  const head =
    h === "none" ? null
      : h === "dot" ? <circle cx={tipX} cy="11" r="3" fill="currentColor" />
        : h === "triangle"
          ? <path d={atStart ? "M3 11 9 7.5 9 14.5Z" : "M19 11 13 7.5 13 14.5Z"} fill="currentColor" stroke="currentColor" />
          : <path d={atStart ? "M3 11 8 8 M3 11 8 14" : "M19 11 14 8 M19 11 14 14"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />;
  return (
    <svg viewBox="0 0 22 22" width="20" height="20" aria-hidden="true">
      <path d={`M${baseX} 11 H${atStart ? 19 : 3}`} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {head}
    </svg>
  );
}

function fillStyleIcon(f: NonNullable<CanvasShapeStyle["fillStyle"]>) {
  if (f === "solid")
    return <svg viewBox="0 0 22 12" width="22" height="12" aria-hidden="true"><rect x="1" y="1" width="20" height="10" rx="2" fill="currentColor" opacity="0.6" /></svg>;
  if (f === "hachure")
    return <svg viewBox="0 0 22 12" width="22" height="12" aria-hidden="true"><path d="M3 11 8 1M9 11 14 1M15 11 20 1" stroke="currentColor" strokeWidth="1.3" /></svg>;
  return <svg viewBox="0 0 22 12" width="22" height="12" aria-hidden="true"><path d="M3 11 8 1M9 11 14 1M15 11 20 1M3 1 8 11M9 1 14 11M15 1 20 11" stroke="currentColor" strokeWidth="1.1" opacity="0.85" /></svg>;
}
