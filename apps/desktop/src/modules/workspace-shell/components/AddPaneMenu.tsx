"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { KindIcon } from "@/modules/workspace-shell/components/kind-glyph";
import {
  describeLineup,
  PANE_OPTIONS,
  panesLabel,
  SQUAD_PRESETS,
  sessionCount,
  type SquadPreset,
} from "@/modules/workspace-shell/services/pane-presets";
import { formatShortcut } from "@/modules/workspace-shell/services/shortcuts";
import type { PaneKind } from "@/modules/workspace-shell/types";

export interface MenuAnchor {
  /** Viewport coordinates of the trigger's bottom-left corner. */
  x: number;
  y: number;
}

interface AddPaneMenuProps {
  workspaceName: string;
  anchor: MenuAnchor;
  onAddPane: (kind: PaneKind) => void;
  onStartPreset: (preset: SquadPreset) => void;
  onClose: () => void;
}

const MENU_WIDTH = 328;
const VIEWPORT_MARGIN = 12;

/**
 * Adding work to a workspace.
 *
 * Two steps on purpose. Opening one pane is cheap and happens immediately; starting a squad
 * spends several agents at once, so it stops on a lineup — who starts, in what role — and only
 * then commits. A confirmation that appears after the processes exist is not a confirmation.
 */
export function AddPaneMenu({ workspaceName, anchor, onAddPane, onStartPreset, onClose }: AddPaneMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const [preset, setPreset] = useState<SquadPreset | null>(null);

  // Dismissal belongs to the document: a menu that only closes when you hit its own button is a
  // menu you have to fight.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  useEffect(() => {
    firstItemRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        // Escape steps back through the menu before it leaves it.
        if (preset) setPreset(null);
        else onClose();
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]") ?? [])];
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = current === -1 ? 0 : (current + step + items.length) % items.length;
      items[next]?.focus();
    },
    [onClose, preset],
  );

  const left = Math.min(anchor.x, (typeof window === "undefined" ? MENU_WIDTH : window.innerWidth) - MENU_WIDTH - VIEWPORT_MARGIN);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={preset ? `${preset.label} squad lineup` : `Add pane in ${workspaceName}`}
      className="ws-menu"
      style={{ left: Math.max(VIEWPORT_MARGIN, left), top: anchor.y, width: MENU_WIDTH }}
      onKeyDown={handleKeyDown}
    >
      {preset ? (
        <>
          <div className="ws-menu-head">
            <button type="button" className="ws-menu-back" onClick={() => setPreset(null)} aria-label="Back">
              <ChevronLeft size={14} strokeWidth={1.75} />
            </button>
            <div>
              <p className="ws-menu-title">{preset.label} squad</p>
              <p className="ws-menu-subtitle">{describeLineup(preset)} in {workspaceName}</p>
            </div>
          </div>

          <ol className="ws-menu-lineup">
            {preset.lineup.map((member, index) => (
              <li key={`${member.kind}-${index}`} data-kind={member.kind}>
                <span className="ws-kind-dot" aria-hidden />
                <span className="ws-menu-glyph" aria-hidden>
                  <KindIcon kind={member.kind} size={14} />
                </span>
                <span className="ws-menu-role">{member.role}</span>
                <span className="ws-menu-kind">{member.kind}</span>
              </li>
            ))}
          </ol>

          <div className="ws-menu-foot">
            <p className="ws-menu-note">
              Nothing is spawned until you press start.
            </p>
            <button
              type="button"
              data-menu-item
              ref={firstItemRef}
              className="ws-menu-commit"
              onClick={() => onStartPreset(preset)}
            >
              Start {panesLabel(sessionCount(preset))}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="ws-menu-head">
            <div>
              <p className="ws-menu-title">Add pane in {workspaceName}</p>
              <p className="ws-menu-subtitle">anything opened here inherits the workspace folder</p>
            </div>
          </div>

          <div className="ws-menu-list">
            {PANE_OPTIONS.map((option, index) => (
              <button
                key={option.kind}
                type="button"
                role="menuitem"
                data-menu-item
                data-kind={option.kind}
                ref={index === 0 ? firstItemRef : undefined}
                className="ws-menu-item"
                onClick={() => onAddPane(option.kind)}
              >
                <span className="ws-menu-glyph" aria-hidden>
                  <KindIcon kind={option.kind} size={15} />
                </span>
                <span className="ws-menu-item-text">
                  <span className="ws-menu-item-title">{option.label}</span>
                  <span className="ws-menu-item-detail">{option.detail}</span>
                </span>
                <kbd>{formatShortcut(option.shortcut)}</kbd>
              </button>
            ))}
          </div>

          <div className="ws-menu-presets">
            <p className="ws-menu-section">Or start a squad</p>
            {SQUAD_PRESETS.map((squad) => (
              <button
                key={squad.id}
                type="button"
                role="menuitem"
                data-menu-item
                className="ws-menu-preset"
                onClick={() => setPreset(squad)}
              >
                <span className="ws-menu-item-text">
                  <span className="ws-menu-item-title">{squad.label}</span>
                  <span className="ws-menu-item-detail">{squad.detail}</span>
                </span>
                {/* The list stays scannable with one short number per row; the richer
                    "2 agents · 1 surface" belongs on the lineup step, where it is the point. */}
                <span className="ws-menu-count">{panesLabel(sessionCount(squad))}</span>
                <ChevronRight size={13} strokeWidth={1.75} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
