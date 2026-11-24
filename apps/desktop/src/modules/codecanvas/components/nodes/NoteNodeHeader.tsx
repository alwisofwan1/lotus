"use client";
import { memo, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Ellipsis, Sprout } from "lucide-react";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";
import { useCanvasOcclusionLock } from "../../hooks/useCanvasOcclusionLock";

export interface NoteHeaderMenuItem {
  id: string;
  label: string;
  /** One line under the label that says what the action does. */
  hint?: string;
  icon: ReactNode;
  onSelect: () => void;
}

interface Props {
  /** Full derived title — the label's tooltip, so a note is still named on hover. */
  title: string;
  /** The label that shows next to the glyph ("Note", or "Editing · Esc to finish"). */
  label: string;
  /** True while the note is in edit mode — the label then carries the sage "live" ink. */
  editing?: boolean;
  /** Actions behind the ··· button (Smart Convert, cover, …). */
  menuItems: NoteHeaderMenuItem[];
  onFocus?: () => void;
  onClose: () => void;
}

/**
 * Note header, paper edition (ADR-0046): one quiet 38px row — a sprout glyph and a short label —
 * with ···, Focus and Close fading in on hover. The note's name lives in the body now, as its serif
 * title, so the header no longer repeats it as a filename slug.
 *
 * The root keeps `canvas-node-header` on purpose: `NOTE_DRAG_HANDLE` in canvas-node-factory.ts is
 * the selector ReactFlow drags the node by, and it is shared with the Music node. `canvas-note-header`
 * is the scoped hook that restyles it. Dropping the shared class would silently make notes undraggable.
 */
export const NoteNodeHeader = memo(function NoteNodeHeader({
  title,
  label,
  editing,
  menuItems,
  onFocus,
  onClose,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // The menu can hang over a neighbouring Browser node; the lock parks its native WebView below.
  useCanvasOcclusionLock(menuOpen, "note-header-menu");

  // An outside click closes the menu; opening it moves focus to the first item for keyboard users.
  // (Esc is handled on the menu itself, below.)
  useEffect(() => {
    if (!menuOpen) return;
    rootRef.current?.querySelector<HTMLButtonElement>(".cnh-menu-item")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menuOpen]);

  return (
    <div
      ref={rootRef}
      className="canvas-node-header canvas-note-header"
      data-menu-open={menuOpen || undefined}
    >
      <div className="cnh-id" title={title}>
        <Sprout className="cnh-glyph" size={14} aria-hidden />
        <span className="cnh-label" data-editing={editing || undefined}>{label}</span>
      </div>
      <div className="cnh-actions nodrag">
        <button
          type="button"
          className="cnh-act"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
        >
          <Ellipsis size={15} aria-hidden />
        </button>
        {onFocus && <CanvasNodeFocusAction onFocus={onFocus} className="cnh-act cnh-act--focus" iconSize={13} />}
        <button
          type="button"
          className="cnh-act cnh-act--close"
          aria-label="Close note"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          ×
        </button>
      </div>
      {menuOpen && (
        <div
          className="cnh-menu nodrag nowheel"
          role="menu"
          aria-label="Note actions"
          // Esc is stopped here so it does not also leave edit mode or exit canvas focus mode —
          // one key press, one effect.
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setMenuOpen(false);
          }}
        >
          {menuItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="cnh-menu-item"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                item.onSelect();
              }}
            >
              <span className="cnh-menu-icon" aria-hidden>{item.icon}</span>
              <span className="cnh-menu-text">
                <span className="cnh-menu-label">{item.label}</span>
                {item.hint && <span className="cnh-menu-hint">{item.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
