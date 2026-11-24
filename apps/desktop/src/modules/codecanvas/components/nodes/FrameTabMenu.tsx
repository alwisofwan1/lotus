"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Maximize2, Pencil, Sparkles, SquareDashed, Terminal, Trash2 } from "lucide-react";
import { FRAME_COLORS, frameColorCss, frameColorOf } from "../../services/canvas-frame-palette";
import { useCanvasOcclusionLock } from "../../hooks/useCanvasOcclusionLock";
import { useFrameActions } from "./frame-actions-context";

interface Props {
  kind: "add" | "more";
  /** Screen rect of the button that opened the menu. */
  anchor: DOMRect;
  frameId: string;
  colorId: string | undefined;
  memberCount: number;
  onRename: () => void;
  onClose: () => void;
}

/**
 * The Frame title tab's two menus, as a portal so they stay a readable size at any canvas zoom.
 * "add" spawns a terminal or agent into the Frame; "more" is rename / colour / fit / delete.
 * Mounted only while open, so the occlusion lock (browser WebViews park beneath it) lives exactly
 * as long as the menu does.
 */
export function FrameTabMenu({ kind, anchor, frameId, colorId, memberCount, onRename, onClose }: Props) {
  const actions = useFrameActions();
  const ref = useRef<HTMLDivElement>(null);
  const [hoverColor, setHoverColor] = useState<string | null>(null);
  useCanvasOcclusionLock(true, kind === "add" ? "frame-add-menu" : "frame-more-menu");

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    ref.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const current = frameColorOf(colorId);
  const shownColor = hoverColor ? frameColorOf(hoverColor) : current;

  const content = (
    <div
      ref={ref}
      className="canvas-frame-tab-menu nodrag nopan"
      role="menu"
      aria-label={kind === "add" ? "Add to Frame" : "Frame menu"}
      data-testid={kind === "add" ? "frame-add-menu" : "frame-more-menu"}
      style={{ left: anchor.left, top: anchor.bottom + 6 }}
    >
      {kind === "add" ? (
        <>
          <button type="button" role="menuitem" className="canvas-frame-tab-menu-item" onClick={run(() => actions.spawn(frameId, "terminal"))}>
            <Terminal size={15} aria-hidden="true" />
            <span className="canvas-frame-tab-menu-label">New terminal</span>
          </button>
          <button type="button" role="menuitem" className="canvas-frame-tab-menu-item" onClick={run(() => actions.spawn(frameId, "agent"))}>
            <Sparkles size={15} aria-hidden="true" />
            <span className="canvas-frame-tab-menu-label">New agent</span>
          </button>
        </>
      ) : (
        <>
          <button type="button" role="menuitem" className="canvas-frame-tab-menu-item" onClick={run(onRename)}>
            <Pencil size={15} aria-hidden="true" />
            <span className="canvas-frame-tab-menu-label">Rename</span>
            <kbd className="canvas-frame-tab-menu-key">F2</kbd>
          </button>
          <div className="canvas-frame-tab-menu-colour" role="group" aria-label="Colour">
            <div className="canvas-frame-tab-menu-colour-head">
              <span>Colour</span>
              <strong>{shownColor.name}</strong>
            </div>
            <div className="canvas-frame-tab-menu-swatches">
              {FRAME_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={c.id === current.id}
                  aria-label={c.name}
                  title={c.name}
                  className="canvas-frame-swatch"
                  style={{ background: frameColorCss(c.id) }}
                  onMouseEnter={() => setHoverColor(c.id)}
                  onMouseLeave={() => setHoverColor(null)}
                  onFocus={() => setHoverColor(c.id)}
                  onBlur={() => setHoverColor(null)}
                  onClick={run(() => actions.recolor(frameId, c.id))}
                >
                  {c.id === current.id ? <Check size={14} aria-hidden="true" /> : null}
                </button>
              ))}
            </div>
          </div>
          <button type="button" role="menuitem" className="canvas-frame-tab-menu-item" onClick={run(() => actions.fit(frameId))}>
            <Maximize2 size={15} aria-hidden="true" />
            <span className="canvas-frame-tab-menu-label">Fit to content</span>
          </button>
          <div className="canvas-frame-tab-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="canvas-frame-tab-menu-item" onClick={run(() => actions.deleteKeepMembers(frameId))}>
            <SquareDashed size={15} aria-hidden="true" />
            <span className="canvas-frame-tab-menu-label">
              Delete Frame
              <small>{memberCount === 0 ? "Empty Frame" : `Keeps ${memberCount} ${memberCount === 1 ? "node" : "nodes"}, loose`}</small>
            </span>
            <kbd className="canvas-frame-tab-menu-key">Del</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            className="canvas-frame-tab-menu-item canvas-frame-tab-menu-item--danger"
            onClick={run(() => actions.requestDeleteWithContents(frameId))}
          >
            <Trash2 size={15} aria-hidden="true" />
            <span className="canvas-frame-tab-menu-label">Delete with contents…</span>
          </button>
        </>
      )}
    </div>
  );
  return createPortal(content, document.body);
}
