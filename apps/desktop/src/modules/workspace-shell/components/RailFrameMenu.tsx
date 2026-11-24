"use client";

// A group's ••• menu (mockups/code-rail-frames-v2.html): Rename, the colour palette, Ungroup. A split
// (an unnamed Frame) offers a name or separating. The pane menu's shape and keys. There is no
// "close all panes": ungrouping keeps the panes.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { MenuItem } from "@/modules/chat/ui/ThreadActions";
import { FRAME_COLORS, type FrameColor } from "@/modules/codespace/components/types";
import type { RailFrame } from "@/modules/workspace-shell/types";
import { paneCountLabel } from "@/modules/workspace-shell/services/cell-mapping";

export type RailFrameAction = { kind: "rename" } | { kind: "color"; color: FrameColor } | { kind: "delete" };

export function RailFrameMenu({
  frame,
  folder,
  at,
  container,
  onAct,
  onClose,
}: {
  frame: RailFrame;
  folder: string;
  at: { x: number; y: number };
  /** Inside the shell, so the swatches resolve the shell's hue tokens; the body otherwise. */
  container: Element | null;
  onAct: (action: RailFrameAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    // Kept on screen: a row near the bottom opens its menu upward.
    const { width, height } = menu.getBoundingClientRect();
    setPos({ x: Math.min(at.x, innerWidth - width - 8), y: Math.max(8, Math.min(at.y, innerHeight - height - 8)) });
    menu.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const outside = (event: PointerEvent) => !menu.contains(event.target as Node) && onClose();
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [at, onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key.toLowerCase();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role^=menuitem]")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (key === "escape" || key === "tab") onClose();
    else if (key === "arrowdown" || key === "arrowright") items[(i + 1) % items.length]?.focus();
    else if (key === "arrowup" || key === "arrowleft") items[(i - 1 + items.length) % items.length]?.focus();
    else if (key === "r") onAct({ kind: "rename" });
    else if (key === "backspace" || key === "delete") onAct({ kind: "delete" });
    else return;
    event.preventDefault();
    // The rail's and the window's own shortcuts must not see a key the menu used.
    event.stopPropagation();
  };

  return createPortal(
    <div
      ref={ref}
      className="chat-thread-menu"
      role="menu"
      aria-label={`Actions for ${frame.split ? "split" : frame.name}`}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
    >
      <div className="chat-thread-menu-head">
        <span className="chat-thread-menu-title">{frame.split ? "Split" : frame.name}</span>
        <span className="chat-thread-menu-sub">
          {folder} · {paneCountLabel(frame.paneCount)}
        </span>
      </div>
      <MenuItem label={frame.split ? "Name this split…" : "Rename"} keycap="R" onClick={() => onAct({ kind: "rename" })} />
      {frame.split ? null : <div className="ws-frame-swatches" role="group" aria-label="Color">
        {FRAME_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            role="menuitemradio"
            aria-checked={color === frame.color}
            aria-label={color}
            className="ws-frame-swatch"
            data-color={color}
            onClick={() => onAct({ kind: "color", color })}
          />
        ))}
      </div>}
      <MenuItem
        label={frame.split ? "Separate panes" : "Ungroup (keeps panes)"}
        keycap="⌫"
        danger={!frame.split}
        onClick={() => onAct({ kind: "delete" })}
      />
    </div>,
    container ?? document.body,
  );
}
