"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { TaskStatusGlyph } from "@/modules/tasks/components/TaskGlyphs";
import type { BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";
import { statusLabel, statusTone, type StatusVocabulary } from "@/modules/tasks/services/task-vocabulary";

/**
 * The Task node's menus (`plans/canvas-dock/` board 18). Never a native `<select>`: its popup is
 * drawn by the OS outside the canvas's zoom, and could not show the tracker's glyphs and keys.
 */

/**
 * Open/close and outside press for one small popover inside a node. The menu is portalled to the
 * body at fixed coordinates: inside the node it would be clipped by the node's own scroll area.
 * A pan or zoom of the canvas closes it rather than leaving it floating over the wrong place.
 *
 * occlusion-exempt: a small menu anchored to its chip, closed by any press or wheel outside it; it
 * covers a few rows beside the node, never a working surface.
 */
export function useNodePopover(direction: "down" | "up" = "down") {
  // Where the menu sits and what it is portalled into, measured when it opens; null while closed.
  const [shown, setShown] = useState<{ place: CSSProperties; host: Element } | null>(null);
  const open = shown !== null;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const setOpen = useCallback(
    (next: boolean) => {
      const root = rootRef.current;
      if (!next || !root) {
        setShown(null);
        return;
      }
      const rect = root.getBoundingClientRect();
      const minWidth = Math.max(rect.width, 176);
      setShown({
        place:
          direction === "down"
            ? { position: "fixed", top: rect.bottom + 4, left: rect.left, minWidth }
            : { position: "fixed", bottom: window.innerHeight - rect.top + 4, left: rect.left, minWidth },
        // Inside the canvas, so its theme tokens still apply; the flow's wrapper is not transformed.
        host: root.closest(".react-flow") ?? document.body,
      });
    },
    [direction],
  );
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      [rootRef.current, menuRef.current].some((element) => element?.contains(target as globalThis.Node));
    const onPress = (event: PointerEvent) => {
      if (!inside(event.target)) setShown(null);
    };
    const onWheel = (event: WheelEvent) => {
      if (!inside(event.target)) setShown(null);
    };
    const close = () => setShown(null);
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("wheel", onWheel, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  const portal = (menu: ReactNode) =>
    shown
      ? createPortal(
          <div ref={menuRef} className="canvas-task-menu-layer" style={shown.place}>
            {menu}
          </div>,
          shown.host,
        )
      : null;
  return { open, setOpen, rootRef, portal };
}

export function TaskStatusMenu({
  status,
  vocabulary,
  onPick,
  openRequest = 0,
}: {
  status: BridgeTaskStatus;
  vocabulary: StatusVocabulary;
  onPick: (status: BridgeTaskStatus) => void;
  /** Bumped by the node's "S" key: each new non-zero value opens the menu. */
  openRequest?: number;
}) {
  const { open, setOpen, rootRef, portal } = useNodePopover("down");
  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest, setOpen]);
  const order = vocabulary.order as readonly BridgeTaskStatus[];
  const pick = (next: BridgeTaskStatus) => {
    setOpen(false);
    if (next !== status) onPick(next);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && order[index]) {
      event.preventDefault();
      event.stopPropagation();
      pick(order[index]!);
    }
  };
  return (
    <div className="canvas-task-menu-root nodrag nowheel" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="canvas-task-chip canvas-task-status-chip"
        data-tone={statusTone(vocabulary, status)}
        aria-label={`Status: ${statusLabel(vocabulary, status)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <TaskStatusGlyph status={status} vocabulary={vocabulary} size={12} decorative />
        <span>{statusLabel(vocabulary, status)}</span>
        <ChevronDown size={11} aria-hidden />
      </button>
      {portal(
        <div className="canvas-task-menu" role="menu" aria-label="Set status">
          {order.map((option, index) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === status}
              className="canvas-task-menu-item"
              data-tone={statusTone(vocabulary, option)}
              autoFocus={option === status}
              onClick={() => pick(option)}
            >
              <TaskStatusGlyph status={option} vocabulary={vocabulary} size={12} decorative />
              <span className="canvas-task-menu-label">{statusLabel(vocabulary, option)}</span>
              <kbd aria-hidden>{index + 1}</kbd>
            </button>
          ))}
        </div>,
      )}
    </div>
  );
}

export interface SplitMenuItem {
  key: string;
  label: string;
  hint?: string;
  checked?: boolean;
  icon?: ReactNode;
  onSelect: () => void;
}

/**
 * One primary action with its choices behind a chevron: Delegate · Alwi ▾ on a linked task, Run ▾
 * on a local one. `items` are grouped; a group boundary draws a rule.
 */
export function TaskSplitButton({
  label,
  icon,
  primary,
  disabled,
  title,
  onClick,
  menuLabel,
  groups,
}: {
  label: ReactNode;
  icon?: ReactNode;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
  /** Absent: the whole button opens the menu. */
  onClick?: () => void;
  menuLabel: string;
  groups: readonly (readonly SplitMenuItem[])[];
}) {
  const { open, setOpen, rootRef, portal } = useNodePopover("up");
  const filled = groups.filter((group) => group.length > 0);
  const toggle = () => setOpen(!open);
  return (
    <div
      className={`canvas-task-split nodrag nowheel${primary ? " canvas-task-split--primary" : ""}`}
      ref={rootRef}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button type="button" className="canvas-task-split-main" disabled={disabled} title={title} onClick={onClick ?? toggle}>
        {icon}
        <span className="canvas-task-split-label">{label}</span>
      </button>
      {filled.length > 0 ? (
        <button
          type="button"
          className="canvas-task-split-more"
          aria-label={menuLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          <ChevronDown size={12} aria-hidden />
        </button>
      ) : null}
      {portal(
        <div className="canvas-task-menu" role="menu" aria-label={menuLabel}>
          {filled.map((group, index) => (
            <div key={index} className="canvas-task-menu-group" role="group">
              {group.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  className="canvas-task-menu-item"
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.icon ?? <span className="canvas-task-menu-icon" aria-hidden />}
                  <span className="canvas-task-menu-label">{item.label}</span>
                  {item.hint ? <span className="canvas-task-menu-hint">{item.hint}</span> : null}
                  {item.checked ? <Check size={12} aria-hidden /> : null}
                </button>
              ))}
            </div>
          ))}
        </div>,
      )}
    </div>
  );
}

/** `4m`, `2h`, `3d` — the same short ages the Tasks rows print. */
export function shortAge(since: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
