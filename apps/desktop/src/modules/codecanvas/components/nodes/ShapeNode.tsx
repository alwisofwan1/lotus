"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import rough from "roughjs";
import type { CanvasShapeKind, CanvasShapeNodeData, CanvasShapeStyle } from "../../types/canvas";
import { roughNodeOptions, roughSeedFromId, roughStyleSignature, strokeDashArray } from "../../services/canvas-rough";
import { SHAPE_DEFAULTS, FONT_FAMILIES, FONT_SIZE_CQH, FONT_SIZE_CLAMP, FONT_SIZE_PX, normalizeShapeStrokeWidth } from "../../services/shape-defaults";
import { linearRoughPaths, insertPointAt, arrowGeometryFromDrag, type Pt } from "../../services/canvas-linear";
import { textBoxSize } from "../../services/canvas-shape";
import { rotationFromPointer } from "../../services/canvas-rotation";
import { parseNoteAssetUri } from "../../services/note-assets";
import { codecanvasReadNoteAsset } from "@/lib/tauri/codecanvas";
import { ShapePointHandles } from "./ShapePointHandles";

/**
 * Hidden connection handles for diagram connectors. Container/text shapes need real ReactFlow
 * handles so programmatic connector edges (agent draw / diagram) can bind — otherwise ReactFlow
 * drops the edge with error #008. They're invisible and non-interactive (the connector geometry is
 * floating, computed from node rects in CanvasWireEdge, so the handle side is cosmetic); the ids
 * match CanvasNodeFrame's so a diagram shares one wiring vocabulary.
 */
const SHAPE_WIRE_HANDLES = [
  { id: "wire-top", position: Position.Top },
  { id: "wire-right", position: Position.Right },
  { id: "wire-bottom", position: Position.Bottom },
  { id: "wire-left", position: Position.Left },
] as const;

/** Resolve a `lotus-note-asset://` URI to a displayable data URL once per asset (module cache). */
const imageDataUrlCache = new Map<string, string>();

function useResolvedShapeImage(assetUri: string | undefined): { src: string; failed: boolean } {
  const [src, setSrc] = useState(() => (assetUri ? imageDataUrlCache.get(assetUri) ?? "" : ""));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!assetUri) return;
    const assetId = parseNoteAssetUri(assetUri);
    if (!assetId) return;
    let live = true;
    const apply = (url: string) => { if (live) { setSrc(url); setFailed(false); } };
    const cached = imageDataUrlCache.get(assetUri);
    if (cached) {
      // Reflect the cache off a microtask so we never call setState synchronously in the effect body.
      void Promise.resolve().then(() => apply(cached));
      return () => { live = false; };
    }
    void codecanvasReadNoteAsset(assetId)
      .then((res) => {
        const url = `data:${res.asset.mime || "image/png"};base64,${res.base64}`;
        imageDataUrlCache.set(assetUri, url);
        apply(url);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [assetUri]);
  return { src, failed };
}

const FONT_FAMILY_CSS = Object.fromEntries(FONT_FAMILIES) as Record<NonNullable<CanvasShapeStyle["fontFamily"]>, string>;
// Matches the CSS line-height of .canvas-shape-label/.canvas-shape-edit so the measured box
// height equals the rendered text height (handwriting fonts need the extra room, else the
// editor overflows and clips the top line).
const TEXT_LINE_HEIGHT = 1.4;
/** Idle window after the last size change before the rough geometry regenerates. */
export const SHAPE_REGEN_IDLE_MS = 120;
const TEXT_PAD = { padX: 10, padY: 8 } as const;
/** Concrete font families for offscreen `measureText` (CSS vars don't resolve in canvas). */
const MEASURE_FONT: Record<NonNullable<CanvasShapeStyle["fontFamily"]>, string> = {
  hand: '"Excalifont", cursive',
  normal: '"Nunito", sans-serif',
  heading: '"Lilita One", sans-serif',
  code: '"Comic Mono", monospace',
};
const measureCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;

/**
 * Inline typography for a text shape's content/editor. Font size is box-relative (`cqh`)
 * so it scales as the shape is resized, clamped to a readable px range.
 */
export function textTypographyStyle(style?: CanvasShapeStyle, mode: "fit" | "absolute" = "fit") {
  const tier = style?.fontSize ?? SHAPE_DEFAULTS.fontSize;
  const vAlign = style?.verticalAlign ?? SHAPE_DEFAULTS.verticalAlign;
  // Standalone text: absolute px × fontScale (box hugs the text; corner-resize scales the font).
  // Container text: fit-to-box cqh (fills shape).
  const fontSize = mode === "absolute"
    ? `${FONT_SIZE_PX[tier] * (style?.fontScale ?? 1)}px`
    : `clamp(${FONT_SIZE_CLAMP.min}px, ${FONT_SIZE_CQH[tier]}cqh, ${FONT_SIZE_CLAMP.max}px)`;
  return {
    fontFamily: FONT_FAMILY_CSS[style?.fontFamily ?? SHAPE_DEFAULTS.fontFamily],
    fontSize,
    textAlign: style?.textAlign ?? SHAPE_DEFAULTS.textAlign,
    // A text element's "stroke" is its ink color (Excalidraw); applies to centered content too.
    color: style?.strokeColor ?? SHAPE_DEFAULTS.strokeColor,
    // Vertical placement of the content within the box (label is a flex column).
    justifyContent: vAlign === "top" ? "flex-start" : vAlign === "bottom" ? "flex-end" : "center",
  } as const;
}

const generator = rough.generator();

/**
 * Build hand-drawn (rough.js) paths for a whiteboard shape. Pure given the inputs and
 * deterministic per seed, so the wobble is stable across renders. Returns [] for the
 * text shape (label only) and before the node is measured.
 */
export function buildShapeRoughPaths(
  shape: CanvasShapeKind,
  width: number,
  height: number,
  seed: number,
  style?: CanvasShapeStyle,
  points?: Array<[number, number]>,
) {
  if (!(width > 0) || !(height > 0) || shape === "text" || shape === "image") return [];
  const strokeWidth = normalizeShapeStrokeWidth(style?.strokeWidth, SHAPE_DEFAULTS.strokeWidth);
  const options = roughNodeOptions({
    seed,
    sloppiness: style?.sloppiness,
    strokeColor: style?.strokeColor ?? SHAPE_DEFAULTS.strokeColor,
    strokeWidth,
    strokeStyle: style?.strokeStyle,
    fill: style?.fill,
    fillStyle: style?.fillStyle,
  });

  if (shape === "arrow" || shape === "line" || shape === "draw") {
    // Freehand draw is a headless smooth curve through all sampled points.
    return linearRoughPaths(generator, {
      width,
      height,
      points,
      arrowType: shape === "draw" ? "curved" : style?.arrowType ?? SHAPE_DEFAULTS.arrowType,
      // Defaults are arrow-shaped; line/draw are headless unless explicitly configured.
      startArrowhead: shape === "arrow" ? style?.startArrowhead ?? SHAPE_DEFAULTS.startArrowhead : "none",
      endArrowhead: shape === "arrow" ? style?.endArrowhead ?? SHAPE_DEFAULTS.endArrowhead : "none",
      options,
    });
  }

  const inset = Math.max(2, strokeWidth / 2 + 1);
  const w = Math.max(1, width - 2 * inset);
  const h = Math.max(1, height - 2 * inset);
  const drawable =
    shape === "ellipse"
      ? generator.ellipse(width / 2, height / 2, w, h, options)
      : shape === "diamond"
        ? generator.polygon(
            [[width / 2, inset], [width - inset, height / 2], [width / 2, height - inset], [inset, height / 2]],
            options,
          )
        : generator.rectangle(inset, inset, w, h, options);
  return generator.toPaths(drawable);
}

/**
 * A whiteboard shape node (rectangle/diamond/ellipse/text), rendered hand-drawn. Bare by
 * design — no workflow chrome — with a resizer and an optional handwritten label. Pure
 * annotation; excluded from the execution graph (PRD §10).
 */
export const ShapeNode = memo(function ShapeNode({ id, data, selected, width = 0, height = 0 }: NodeProps) {
  const { shape, text, angle, areaLabel, points, style, dispatchCommand, imageAssetUri, imageAlt, editRequestId } = data as CanvasShapeNodeData;
  const isImageShape = shape === "image";
  const resolvedImage = useResolvedShapeImage(isImageShape ? imageAssetUri : undefined);
  const showOwnHandles = !!selected;
  // Key the rough geometry on stroke/fill fields only — NOT the whole style object — so a
  // high-frequency opacity drag (applied via CSS below) never regenerates the hand-drawn paths.
  const roughSig = roughStyleSignature(style);
  // Resize-time geometry cache: rough.js regeneration per resize frame was the hot path, so the
  // paths are generated at `genSize` and STRETCHED to the live box via viewBox +
  // preserveAspectRatio="none" (non-scaling-stroke keeps the ink width honest). genSize follows
  // width/height only after the gesture has been idle for SHAPE_REGEN_IDLE_MS — one regen per
  // resize, not one per frame. The first real measurement is adopted immediately.
  const [genSize, setGenSize] = useState({ w: width, h: height });
  useEffect(() => {
    if (width === genSize.w && height === genSize.h) return;
    if (!(genSize.w > 0) || !(genSize.h > 0)) {
      setGenSize({ w: width, h: height });
      return;
    }
    const timer = setTimeout(() => setGenSize({ w: width, h: height }), SHAPE_REGEN_IDLE_MS);
    return () => clearTimeout(timer);
  }, [width, height, genSize.w, genSize.h]);
  const paths = useMemo(
    () => buildShapeRoughPaths(shape, genSize.w, genSize.h, roughSeedFromId(id), style, points),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roughSig is the stable digest of the style fields buildShapeRoughPaths reads
    [shape, genSize.w, genSize.h, id, roughSig, points],
  );
  // rough.js never bakes the dash into its path output, so apply it here — but only to the
  // OUTLINE stroke (the path whose stroke is the shape's stroke color), never the fill hachure.
  const outlineStroke = style?.strokeColor ?? SHAPE_DEFAULTS.strokeColor;
  const strokeWidth = normalizeShapeStrokeWidth(style?.strokeWidth, SHAPE_DEFAULTS.strokeWidth);
  const dash = strokeDashArray(style?.strokeStyle, strokeWidth);
  const isPath = shape === "arrow" || shape === "line" || shape === "draw"; // point-based, no text
  const isText = shape === "text";
  const isImage = shape === "image"; // bitmap — no stroke/text, resolved from the note-asset store
  const isContainer = !isPath && !isText && !isImage; // rectangle / diamond / ellipse
  const editable = !isPath && !isImage;
  // Excalidraw-style binding: every editable shape holds centered `text`, edited via
  // double-click. A container additionally shows an OPTIONAL top-left `areaLabel` corner tag
  // — set only through the Inspector field, never the double-click editor.
  const isTextPlaceholder = isText && !text;
  const textLabel = editable ? text || (isText ? "Text" : "") : "";
  const cornerLabel = isContainer ? areaLabel ?? "" : "";
  const textType = editable ? textTypographyStyle(style, isText ? "absolute" : "fit") : undefined;

  const rootRef = useRef<HTMLDivElement>(null);
  const flow = useReactFlow();
  const linearPoints = points && points.length >= 2 ? points : ([[0, 0], [1, 1]] as Array<[number, number]>);
  const setPoints = (next: Array<[number, number]>) =>
    dispatchCommand?.({ kind: "patch-shape", nodeId: id, patch: { points: next } });

  // Live endpoint/point drag: refit the node box in flow space so the arrow lengthens/shortens
  // and the box follows (Excalidraw). Computed from each node's own latest geometry to avoid lag.
  const handlePointDrag = (index: number, clientX: number, clientY: number) => {
    const fp = flow.screenToFlowPosition({ x: clientX, y: clientY });
    flow.setNodes((nds) => nds.map((n) => {
      if (n.id !== id) return n;
      const pts = ((n.data as CanvasShapeNodeData).points as Pt[]) ?? linearPoints;
      const box = { x: n.position.x, y: n.position.y, w: n.width ?? width, h: n.height ?? height };
      const geo = arrowGeometryFromDrag(pts, box, index, fp);
      return {
        ...n,
        position: geo.position,
        width: geo.size.w,
        height: geo.size.h,
        style: { ...(n.style ?? {}), width: geo.size.w, height: geo.size.h },
        data: { ...n.data, points: geo.points },
      };
    }));
  };
  const commitPoints = () => {
    const pts = (flow.getNode(id)?.data as CanvasShapeNodeData | undefined)?.points;
    if (pts) dispatchCommand?.({ kind: "patch-shape", nodeId: id, patch: { points: pts } });
  };
  // Mid-segment bend: insert a control point at the cursor and return its index to drag live.
  const insertMidpoint = (segIndex: number, clientX: number, clientY: number): number => {
    const fp = flow.screenToFlowPosition({ x: clientX, y: clientY });
    flow.setNodes((nds) => nds.map((n) => {
      if (n.id !== id) return n;
      const pts = ((n.data as CanvasShapeNodeData).points as Pt[]) ?? linearPoints;
      const w = n.width || width || 1;
      const h = n.height || height || 1;
      const norm: Pt = [(fp.x - n.position.x) / w, (fp.y - n.position.y) / h];
      const next = [...pts.slice(0, segIndex + 1), norm, ...pts.slice(segIndex + 1)];
      return { ...n, data: { ...n.data, points: next } };
    }));
    return segIndex + 1;
  };

  // Rotate-handle drag: live angle via flow.setNodes (transient), committed as a patch-shape on
  // release so it autosaves and lands in undo history as one step. The center comes from the
  // ROOT div (unrotated — the rotor is an inner wrapper), so the pivot never wobbles mid-drag.
  const rotatingRef = useRef(false);
  const angleFromPointer = (clientX: number, clientY: number, shiftKey: boolean) => {
    const rect = rootRef.current?.getBoundingClientRect();
    const center = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 };
    return rotationFromPointer(center, { x: clientX, y: clientY }, shiftKey ? { snap: 15 } : {});
  };
  const handleRotateDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    rotatingRef.current = true;
  };
  const handleRotateMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!rotatingRef.current) return;
    const next = angleFromPointer(event.clientX, event.clientY, event.shiftKey);
    flow.setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, angle: next } } : n)));
  };
  const handleRotateUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!rotatingRef.current) return;
    rotatingRef.current = false;
    dispatchCommand?.({ kind: "patch-shape", nodeId: id, patch: { angle: angleFromPointer(event.clientX, event.clientY, event.shiftKey) } });
  };

  const editRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const startEdit = () => {
    if (!editable) return;
    setDraft(text ?? "");
    setEditing(true);
  };

  // Standalone text auto-sizes its box to the content (Excalidraw): width = widest line,
  // height = lines × line-height. Measured offscreen with the resolved font; the box hugs the text.
  const fontTier = style?.fontSize ?? SHAPE_DEFAULTS.fontSize;
  const fontFam = style?.fontFamily ?? SHAPE_DEFAULTS.fontFamily;
  const fontScale = style?.fontScale ?? 1;
  const autoSizeText = useCallback((value: string) => {
    if (!isText || !measureCtx) return;
    const px = FONT_SIZE_PX[fontTier] * fontScale;
    const font = `${px}px ${MEASURE_FONT[fontFam]}`;
    const box = textBoxSize(value || "Text", px, {
      ...TEXT_PAD,
      lineHeight: TEXT_LINE_HEIGHT,
      measure: (line) => { measureCtx.font = font; return measureCtx.measureText(line).width; },
    });
    flow.setNodes((nds) => nds.map((n) => {
      if (n.id !== id) return n;
      if (n.width === box.w && n.height === box.h) return n; // idempotent — no churn (keeps drag smooth)
      return { ...n, width: box.w, height: box.h, style: { ...(n.style ?? {}), width: box.w, height: box.h } };
    }));
  }, [isText, fontTier, fontFam, fontScale, flow, id]);

  // Corner-resizing a text element scales its font (Excalidraw) — derive a continuous fontScale
  // from the height change, then the auto-size effect re-fits the box to the text at the new size.
  const resizeStartRef = useRef<{ h: number; scale: number } | null>(null);
  const onTextResizeStart = (_e: unknown, params: { height: number }) => {
    resizeStartRef.current = { h: params.height, scale: fontScale };
  };
  const onTextResizeEnd = (_e: unknown, params: { height: number }) => {
    const start = resizeStartRef.current;
    resizeStartRef.current = null;
    if (!start || start.h <= 0) return;
    const scale = Math.max(0.2, Math.min(20, start.scale * (params.height / start.h)));
    dispatchCommand?.({ kind: "patch-shape", nodeId: id, patch: { style: { ...(style ?? {}), fontScale: scale } } });
  };

  // Re-fit committed text when its content or font changes (and on mount, migrating old boxes).
  useEffect(() => { if (isText && !editing) autoSizeText(text ?? ""); }, [isText, editing, text, autoSizeText]);
  // A freshly created (empty) text element opens straight into edit mode (Excalidraw).
  useEffect(() => { if (isText && !text) { setDraft(""); setEditing(true); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Programmatic edit request (text tool clicked over this shape): a CHANGED editRequestId opens
  // the editor. The mount value is only recorded, never acted on — a stale id living in node data
  // (e.g. after a remount) must not pop an editor the user didn't ask for.
  const seenEditRequestRef = useRef(editRequestId);
  useEffect(() => {
    if (editRequestId === seenEditRequestRef.current) return;
    seenEditRequestRef.current = editRequestId;
    if (editRequestId === undefined || !editable) return;
    setDraft(text ?? "");
    setEditing(true);
  }, [editRequestId, editable, text]);

  // Select the existing text when an edit begins, so typing replaces it (Excalidraw behavior).
  useEffect(() => { if (editing) editRef.current?.select(); }, [editing]);
  // Enter (no modifiers) starts editing the selected shape's text — matches the on-canvas hint.
  useEffect(() => {
    if (!selected || !editable || editing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      setDraft(text ?? "");
      setEditing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, editable, editing, text]);
  // Path shapes: Cmd/Ctrl + double-click inserts a point at the cursor (Excalidraw point editing).
  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (editable) { startEdit(); return; }
    if (!isPath || !(event.metaKey || event.ctrlKey)) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const pt: [number, number] = [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
    setPoints(insertPointAt(linearPoints, pt));
  };
  const commitEdit = () => {
    setEditing(false);
    // A standalone text element that ends up empty is removed (Excalidraw) — no orphan boxes.
    if (isText && draft.trim() === "") {
      dispatchCommand?.({ kind: "close-node", nodeId: id });
      return;
    }
    dispatchCommand?.({ kind: "patch-shape", nodeId: id, patch: { text: draft } });
  };
  const handleEditKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    // Escape COMMITS (Excalidraw): dropping the draft silently lost typed text, and on a fresh
    // empty text element it stranded a ghost "Text" placeholder that only blur cleaned up.
    if (event.key === "Escape") { event.preventDefault(); commitEdit(); }
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commitEdit(); }
  };

  return (
    <div
      ref={rootRef}
      className={`canvas-shape-node${selected ? " selected" : ""}`}
      data-shape={shape}
      style={{ width: "100%", height: "100%", opacity: (style?.opacity ?? 100) / 100 }}
      onDoubleClick={editable || isPath ? handleDoubleClick : undefined}
    >
      {/* Path shapes use point handles. Containers resize freely; text corner-resizes to scale
          its font (keepAspectRatio), then re-fits to content. */}
      <NodeResizer
        minWidth={32}
        minHeight={28}
        isVisible={showOwnHandles && (isContainer || isText || isImage)}
        keepAspectRatio={isText || isImage}
        onResizeStart={isText ? onTextResizeStart : undefined}
        onResizeEnd={isText ? onTextResizeEnd : undefined}
        handleClassName="canvas-node-resize-handle"
        lineClassName="canvas-node-resize-line"
      />
      {/* Hidden connection handles on EVERY shape kind (incl. path/image), so a programmatic
          connector to any shape binds instead of being dropped by ReactFlow (#008) while the agent
          is told it drew. Invisible + non-interactive; the connector path is floating regardless. */}
      {SHAPE_WIRE_HANDLES.map((h) => (
        <Handle
          key={h.id}
          id={h.id}
          type="source"
          position={h.position}
          className="canvas-shape-wire-handle"
          isConnectableStart={false}
        />
      ))}
      {showOwnHandles ? (
        <div
          className="canvas-rotate-handle nodrag"
          role="slider"
          aria-label="Rotate shape"
          aria-valuenow={angle ?? 0}
          onPointerDown={handleRotateDown}
          onPointerMove={handleRotateMove}
          onPointerUp={handleRotateUp}
        />
      ) : null}
      <div className="canvas-shape-rotor" style={angle ? { transform: `rotate(${angle}deg)` } : undefined}>
      {isImage ? (
        resolvedImage.failed ? (
          <div className="canvas-shape-image-missing">{imageAlt || "Image unavailable"}</div>
        ) : resolvedImage.src ? (
          // eslint-disable-next-line @next/next/no-img-element -- data-URI bitmap; next/image can't optimize it
          <img className="canvas-shape-image" src={resolvedImage.src} alt={imageAlt ?? ""} draggable={false} />
        ) : (
          // Asset still resolving — a placeholder avoids rendering <img src=""> (browser re-fetch warning).
          <div className="canvas-shape-image-loading" aria-hidden />
        )
      ) : null}
      {isPath && showOwnHandles ? (
        <ShapePointHandles
          points={linearPoints}
          onPointDrag={handlePointDrag}
          onPointCommit={commitPoints}
          onMidpointInsert={shape === "draw" ? undefined : insertMidpoint}
        />
      ) : null}
      {paths.length > 0 ? (
        <svg
          className="canvas-shape-svg"
          width="100%"
          height="100%"
          viewBox={`0 0 ${genSize.w} ${genSize.h}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {paths.map((p, i) => (
            <path
              key={i}
              d={p.d}
              stroke={p.stroke}
              strokeWidth={p.strokeWidth}
              fill={p.fill ?? "none"}
              strokeLinecap="round"
              strokeDasharray={dash && p.stroke === outlineStroke ? dash : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      ) : null}
      {cornerLabel ? <div className="canvas-shape-arealabel">{cornerLabel}</div> : null}
      {editing ? (
        <textarea
          ref={editRef}
          className="canvas-shape-edit nodrag nowheel"
          autoFocus
          value={draft}
          style={textType}
          placeholder="Type text…"
          onChange={(e) => { setDraft(e.target.value); autoSizeText(e.target.value); }}
          onBlur={commitEdit}
          onKeyDown={handleEditKey}
        />
      ) : textLabel ? (
        <div className="canvas-shape-label" data-placeholder={isTextPlaceholder || undefined} style={textType}>{textLabel}</div>
      ) : null}
      </div>
      {/* Only a transient hint while actually editing — selecting a shape stays clean.
          Enter-to-edit still works (see the keydown effect above). */}
      {/* occlusion-exempt: a tiny transient edit hint, not a canvas-covering overlay — no need to park browser nodes. */}
      {editing && typeof document !== "undefined"
        ? createPortal(
            <div className="canvas-edit-hint">Press <kbd>Esc</kbd> or <kbd>⌘ Enter</kbd> to finish editing</div>,
            document.body,
          )
        : null}
    </div>
  );
});
