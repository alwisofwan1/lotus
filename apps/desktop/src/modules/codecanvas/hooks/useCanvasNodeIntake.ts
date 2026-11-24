"use client";
import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { isTauri } from "@/lib/tauri/runtime";
import {
  classifyIntake,
  isEditableTarget,
  isNoteEditorTarget,
  isTerminalFocusTarget,
  resolveIntakePayload,
} from "../services/canvas-intake";
import {
  resolveImageDropRoute,
  routeIntake,
  type CanvasNodeIntakeKind,
  type IntakeExecutorContext,
} from "../services/canvas-node-intake";
import type { CanvasImageRef } from "../services/canvas-intake";
import type { DraggedSkill, SkillDropTargetKind } from "./useCanvasSkillDnd";
import { listenWebviewDragDrop, safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";

export interface CanvasIntakeTarget {
  id: string;
  kind: CanvasNodeIntakeKind;
}

export interface CanvasIntakeClientPoint {
  clientX: number;
  clientY: number;
}

export interface UseCanvasNodeIntakeOptions {
  /** Resolve the node a paste should land on when no drop point exists. */
  getSelectedNode: () => CanvasIntakeTarget | null;
  /** Resolve the node currently under the drag cursor. */
  getHoveredNode?: () => CanvasIntakeTarget | null;
  /** Resolve a concrete screen point to a node, used by OS/browser file drops. */
  getNodeAtPoint?: (point: CanvasIntakeClientPoint) => CanvasIntakeTarget | null;
  /** Create a fallback target when non-image content is dropped on empty canvas (a Note). */
  createCanvasDropTarget?: (payload: Parameters<typeof routeIntake>[2], point: CanvasIntakeClientPoint | null) => CanvasIntakeTarget | null;
  /**
   * Place a dropped/pasted image as a standalone whiteboard image shape (Excalidraw/CNVS model).
   * Returns the created node id, or null if it couldn't (e.g. no active project). Point is null for
   * a clipboard paste (no drop coordinates) — the placer centers it in the viewport.
   */
  createImageShape?: (images: CanvasImageRef[], point: CanvasIntakeClientPoint | null) => Promise<string | null>;
  /**
   * Fires as a drag moves across the canvas (OS file-drop or in-app HTML5) with the node currently
   * under the cursor, or null when over empty canvas / on leave/drop. Drives the drop-target frame.
   */
  onHoverTarget?: (target: CanvasIntakeTarget | null) => void;
  /** The real effects, minus notify — the hook owns the notice surface. */
  effects: Omit<IntakeExecutorContext, "notify">;
}

export interface UseCanvasNodeIntakeResult {
  /** Wire into useCanvasSkillDnd.onSkillDrop — unifies skill drag into the intake seam. */
  handleSkillDrop: (targetKind: SkillDropTargetKind, targetId: string, skill: DraggedSkill) => void;
  handleCanvasDragOver: (event: ReactDragEvent) => void;
  handleCanvasDrop: (event: ReactDragEvent) => void;
  /** Route images to a specific node — used when an on-canvas image shape is dragged onto an agent. */
  deliverImageToNode: (target: CanvasIntakeTarget, images: CanvasImageRef[]) => Promise<void>;
  /** Surface a transient notice on the canvas notice strip (e.g. a delivery error). */
  notify: (message: string) => void;
  notice: string | null;
  dismissNotice: () => void;
}

const NOTICE_TTL_MS = 3600;

type CanvasDragDropUnlisten = () => void | Promise<void>;

function safeCanvasDragDropUnlisten(unlisten: CanvasDragDropUnlisten | undefined): void {
  if (!unlisten) return;
  try {
    void Promise.resolve(safeTauriUnlisten(unlisten)).catch(() => undefined);
  } catch {
    // Tauri WebView drag/drop listener cleanup can race during unmount/HMR; dropping cleanup errors
    // keeps Canvas usable and mirrors the hardened CodeSpace terminal file-drop path.
  }
}

/** Owns the three Canvas Intake channels (skill drag, clipboard paste, OS file-drop). */
export function useCanvasNodeIntake({ getSelectedNode, getHoveredNode, getNodeAtPoint, createCanvasDropTarget, createImageShape, onHoverTarget, effects }: UseCanvasNodeIntakeOptions): UseCanvasNodeIntakeResult {
  const [notice, setNotice] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef({ getSelectedNode, getHoveredNode, getNodeAtPoint, createCanvasDropTarget, createImageShape, onHoverTarget, effects });
  stateRef.current = { getSelectedNode, getHoveredNode, getNodeAtPoint, createCanvasDropTarget, createImageShape, onHoverTarget, effects };

  const pointCandidates = useCallback((point: CanvasIntakeClientPoint | CanvasIntakeClientPoint[] | null): CanvasIntakeClientPoint[] => {
    if (!point) return [];
    return Array.isArray(point) ? point : [point];
  }, []);

  const findTargetAtPoint = useCallback((point: CanvasIntakeClientPoint | CanvasIntakeClientPoint[] | null): CanvasIntakeTarget | null => {
    const state = stateRef.current;
    for (const candidate of pointCandidates(point)) {
      const target = state.getNodeAtPoint?.(candidate) ?? null;
      if (target) return target;
    }
    return null;
  }, [pointCandidates]);

  const placementPoint = useCallback((point: CanvasIntakeClientPoint | CanvasIntakeClientPoint[] | null): CanvasIntakeClientPoint | null => {
    const candidates = pointCandidates(point);
    return candidates.at(-1) ?? null;
  }, [pointCandidates]);

  // Report the node under a moving drag (or null) so CanvasPage can arm the drop-target frame.
  const reportHover = useCallback((point: CanvasIntakeClientPoint | CanvasIntakeClientPoint[] | null) => {
    const state = stateRef.current;
    if (!state.onHoverTarget) return;
    state.onHoverTarget(findTargetAtPoint(point));
  }, [findTargetAtPoint]);

  const notify = useCallback((message: string) => {
    setNotice(message);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setNotice(null), NOTICE_TTL_MS);
  }, []);

  const ctx = useCallback((): IntakeExecutorContext => ({ ...stateRef.current.effects, notify }), [notify]);

  const route = useCallback(async (target: CanvasIntakeTarget, payload: Parameters<typeof routeIntake>[2]) => {
    const outcome = await routeIntake(target.kind, target.id, payload, ctx());
    if (outcome.kind === "add-attachment") {
      const n = outcome.images.length;
      notify(`Attached ${n} image${n === 1 ? "" : "s"} to the agent.`);
    }
  }, [ctx, notify]);

  // The node already on the canvas that a drop should land on — pointer-first, then hover, then
  // selection. Does NOT create anything; the empty-canvas fallback is decided separately.
  const resolveExistingTarget = useCallback((point: CanvasIntakeClientPoint | CanvasIntakeClientPoint[] | null): CanvasIntakeTarget | null => {
    const state = stateRef.current;
    // A concrete drop point is authoritative. Native OS drags can leave React hover state stale, so
    // falling back to hovered/selected targets here can deliver files to the previous agent.
    if (point) return findTargetAtPoint(point);
    return state.getHoveredNode?.() ?? state.getSelectedNode() ?? null;
  }, [findTargetAtPoint]);

  // Place an image as a standalone whiteboard shape (Excalidraw/CNVS model). Returns true when handled.
  const placeImageShape = useCallback(async (images: CanvasImageRef[], point: CanvasIntakeClientPoint | null): Promise<boolean> => {
    const state = stateRef.current;
    if (!state.createImageShape) return false;
    const created = await state.createImageShape(images, point);
    if (created) notify(`Added ${images.length} image${images.length === 1 ? "" : "s"} to the canvas.`);
    return created != null;
  }, [notify]);

  const routeDroppedPayload = useCallback(async (payload: Parameters<typeof routeIntake>[2], point: CanvasIntakeClientPoint | CanvasIntakeClientPoint[] | null) => {
    const placeAt = placementPoint(point);
    if (payload.kind === "image") {
      // A file PATH dropped onto a terminal/agent is delivered to its prompt (like a terminal drag);
      // pasted bytes, non-PTY nodes, and empty canvas make a placed image shape instead (CNVS).
      const existing = resolveExistingTarget(point);
      if (resolveImageDropRoute(payload, existing) === "node" && existing) {
        await route(existing, payload);
        return;
      }
      if (await placeImageShape(payload.images, placeAt)) return;
      notify("Couldn't place the image on the canvas.");
      return;
    }
    // Non-image content routes into the node under the cursor, else falls back to a new Note.
    const existing = resolveExistingTarget(point);
    if (existing) {
      await route(existing, payload);
      return;
    }
    const target = stateRef.current.createCanvasDropTarget?.(payload, placeAt) ?? null;
    if (!target) {
      notify("Drop on a node, or on the canvas to create a Note.");
      return;
    }
    await route(target, payload);
  }, [notify, placeImageShape, placementPoint, resolveExistingTarget, route]);

  const canAcceptDrop = useCallback((types: readonly string[]) => (
    types.includes("Files") || types.includes("text/plain") || types.includes("text/uri-list") || types.includes("text/html")
  ), []);

  const handleCanvasDragOver = useCallback((event: ReactDragEvent) => {
    if (event.defaultPrevented || !canAcceptDrop([...event.dataTransfer.types])) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    reportHover({ clientX: event.clientX, clientY: event.clientY });
  }, [canAcceptDrop, reportHover]);

  const handleCanvasDrop = useCallback((event: ReactDragEvent) => {
    reportHover(null);
    if (event.defaultPrevented) return;
    const dt = event.dataTransfer;
    const intent = classifyIntake({ types: [...dt.types], files: [...dt.files], getString: (t) => dt.getData(t) });
    if (intent.kind === "none") return;
    event.preventDefault();
    const point = { clientX: event.clientX, clientY: event.clientY };
    void resolveIntakePayload(intent).then((payload) => routeDroppedPayload(payload, point));
  }, [routeDroppedPayload, reportHover]);

  const handleSkillDrop = useCallback(
    (targetKind: SkillDropTargetKind, targetId: string, skill: DraggedSkill) => {
      void route({ id: targetId, kind: targetKind }, { kind: "skill", skill });
    },
    [route],
  );

  // Channel: clipboard paste. Registered in the CAPTURE phase so an image paste is claimed as a
  // canvas shape BEFORE a focused terminal's xterm (and the Claude Code CLI behind it, which would
  // otherwise show its own "[Image #N]" placeholder) can consume it. Text/url paste flows natively.
  useEffect(() => {
    async function onPaste(event: ClipboardEvent) {
      const dt = event.clipboardData;
      if (!dt) return;
      const intent = classifyIntake({ types: [...dt.types], files: [...dt.files], getString: (t) => dt.getData(t) });
      if (intent.kind === "none") return;
      const isImage = intent.kind === "image-files" || intent.kind === "image-paths";
      // Focused input wins (natural paste model): if a terminal agent's xterm is focused, the image
      // goes to the agent like any terminal (Claude Code attaches it); if a Note rich editor is
      // focused, TipTap embeds it inline. ONLY when neither owns the focus does a pasted image become
      // a canvas shape — and then we stopPropagation so nothing underneath also grabs it.
      if (isImage) {
        const active = document.activeElement;
        if (isTerminalFocusTarget(active) || isNoteEditorTarget(active)) return;
        if (!stateRef.current.createImageShape) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const payload = await resolveIntakePayload(intent);
        if (payload.kind === "image") await placeImageShape(payload.images, null);
        return;
      }
      const isText = intent.kind === "text" || intent.kind === "url";
      if (isText && isEditableTarget(document.activeElement)) return;
      const target = stateRef.current.getSelectedNode() ?? stateRef.current.getHoveredNode?.() ?? null;
      if (!target) {
        if (!isText) notify("Select or hover a node to paste into.");
        return;
      }
      event.preventDefault();
      await route(target, await resolveIntakePayload(intent));
    }
    document.addEventListener("paste", onPaste, true);
    return () => document.removeEventListener("paste", onPaste, true);
  }, [route, notify, placeImageShape]);

  // Channel: Tauri OS file-drop → concrete canvas drop point (gives absolute paths).
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: CanvasDragDropUnlisten | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        // Tauri native drag coordinates can arrive as logical CSS pixels or as physical pixels,
        // depending on platform/WebView scaling. Try the raw coordinate first so logical drops land on
        // the intended node, then a DPR-scaled fallback for Retina/physical reports.
        const toPoints = (payload: { position?: { x: number; y: number } }): CanvasIntakeClientPoint[] | null => {
          const position = "position" in payload ? payload.position : null;
          if (!position) return null;
          const raw = { clientX: position.x, clientY: position.y };
          const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
          if (!Number.isFinite(dpr) || dpr <= 0 || dpr === 1) return [raw];
          const scaled = { clientX: position.x / dpr, clientY: position.y / dpr };
          if (Math.abs(scaled.clientX - raw.clientX) < 0.5 && Math.abs(scaled.clientY - raw.clientY) < 0.5) return [raw];
          return [raw, scaled];
        };
        const un = await listenWebviewDragDrop(getCurrentWebview(), async (event) => {
          // enter/over → arm the drop-target frame under the cursor; leave → clear it.
          if (event.payload.type === "leave") { reportHover(null); return; }
          if (event.payload.type === "enter" || event.payload.type === "over") {
            reportHover(toPoints(event.payload));
            return;
          }
          if (event.payload.type !== "drop") return;
          reportHover(null);
          const paths = event.payload.paths ?? [];
          if (paths.length === 0) return;
          const points = toPoints(event.payload);
          const intent = classifyIntake({ types: [], files: [], paths, getString: () => "" });
          await routeDroppedPayload(await resolveIntakePayload(intent), points);
        });
        if (cancelled) safeCanvasDragDropUnlisten(un);
        else unlisten = un;
      } catch {
        // Native drag/drop is opportunistic. Registration/unregistration can race while Canvas
        // remounts; the board and terminals must stay usable without it.
      }
    })();
    return () => {
      cancelled = true;
      safeCanvasDragDropUnlisten(unlisten);
      unlisten = undefined;
    };
  }, [routeDroppedPayload, notify, reportHover]);

  // Clear the drop-target frame whenever any drag ends (dropped elsewhere or cancelled), so an
  // HTML5 drag that never lands on the pane can't leave a node stuck armed.
  useEffect(() => {
    const clear = () => reportHover(null);
    document.addEventListener("dragend", clear);
    return () => document.removeEventListener("dragend", clear);
  }, [reportHover]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const deliverImageToNode = useCallback(
    (target: CanvasIntakeTarget, images: CanvasImageRef[]) => route(target, { kind: "image", images }),
    [route],
  );

  return { handleSkillDrop, handleCanvasDragOver, handleCanvasDrop, deliverImageToNode, notify, notice, dismissNotice: () => setNotice(null) };
}
