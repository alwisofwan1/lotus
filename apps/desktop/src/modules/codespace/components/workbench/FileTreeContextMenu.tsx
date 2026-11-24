"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type FileTreeMenuItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  /** Draw a divider above this item. */
  groupStart?: boolean;
  run: () => void;
};

/** `escape`: Esc or Tab. `outside`: a pointer went down elsewhere. `action`: an item ran. */
export type FileTreeMenuCloseReason = "escape" | "outside" | "action";

interface FileTreeContextMenuProps {
  /** Names the menu for a screen reader, e.g. "Actions for index.ts". */
  label: string;
  items: FileTreeMenuItem[];
  x: number;
  y: number;
  onClose: (reason: FileTreeMenuCloseReason) => void;
}

const EDGE = 8;

/**
 * A menu at the pointer (or under the row, from the keyboard). Rendered into `document.body`:
 * the tree's rows sit in a clipped scroll box, and a parked pane uses `content-visibility`.
 */
export function FileTreeContextMenu({ label, items, x, y, onClose }: FileTreeContextMenuProps) {
  const menuRef = useRef<HTMLUListElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Keep the whole menu on screen, then put focus on its first item.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - rect.width - EDGE));
    const top = Math.max(EDGE, Math.min(y, window.innerHeight - rect.height - EDGE));
    setPosition({ left, top });
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onCloseRef.current("outside");
    };
    const onDismiss = () => onCloseRef.current("outside");
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onDismiss);
    window.addEventListener("resize", onDismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("resize", onDismiss);
    };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (next: number) => buttons[(next + buttons.length) % buttons.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        focusAt(index + 1);
        break;
      case "ArrowUp":
        focusAt(index < 0 ? -1 : index - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(-1);
        break;
      case "Escape":
      case "Tab":
        onClose("escape");
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <ul
      ref={menuRef}
      role="menu"
      aria-label={label}
      className="codespace-context-menu"
      style={{ left: position.left, top: position.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return [
          item.groupStart ? <li key={`${item.id}:divider`} role="separator" className="codespace-context-menu-separator" /> : null,
          <li key={item.id} role="none">
            <button
              role="menuitem"
              type="button"
              tabIndex={-1}
              className={cn("codespace-context-menu-item", item.danger && "is-danger")}
              onClick={() => {
                onClose("action");
                item.run();
              }}
            >
              <Icon className="codespace-context-menu-icon" aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          </li>,
        ];
      })}
    </ul>,
    document.body,
  );
}
