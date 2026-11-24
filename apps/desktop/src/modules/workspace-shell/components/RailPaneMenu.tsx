"use client";

// A pane row's ••• menu in the Code rail (mockups/code-rail-pane-menu-dia.html). Chat's thread menu in
// shape and keys, in sections: the pane, its group (one "Move to group ›" submenu with each group's
// colour, so the menu does not grow per group), then Close.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { MenuItem } from "@/modules/chat/ui/ThreadActions";
import type { FrameColor } from "@/modules/codespace/components/types";
import type { RailPane, RailWorkspace } from "@/modules/workspace-shell/types";

export type RailPaneAction = "rename" | "retitle" | "maximize" | "close";

/** Regrouping a pane (mockups/code-rail-frames-v2.html): into a new group, another group, or out. */
export type RegroupAction = { kind: "new" } | { kind: "move"; frameId: string } | { kind: "out" };

/** Where a pane can go from its menu: the workspace's other named groups, and what it is in now. */
export function regroupOptions(pane: Pick<RailPane, "id">, workspace: Pick<RailWorkspace, "frames">) {
  const owner = workspace.frames?.find((frame) => frame.paneIds.includes(pane.id));
  return {
    groups: (workspace.frames ?? []).filter((frame) => !frame.split && frame !== owner).map(({ id, name, color }) => ({ id, name, color })),
    framed: owner ? (owner.split ? ("split" as const) : ("group" as const)) : null,
  };
}

const ITEMS: { action: RailPaneAction; label: string; keycap: string; key: string[] }[] = [
  { action: "rename", label: "Rename title…", keycap: "R", key: ["r"] },
  { action: "retitle", label: "Regenerate title", keycap: "T", key: ["t"] },
  { action: "maximize", label: "Maximize", keycap: "M", key: ["m"] },
  { action: "close", label: "Close pane", keycap: "⌫", key: ["backspace", "delete"] },
];

/** What a row offers: a name only where the pane holds a conversation or a shell, a model title only for a conversation. */
export function railPaneActions(pane: Pick<RailPane, "kind" | "runner">): RailPaneAction[] {
  const conversation = pane.kind === "thread" || (pane.kind === "terminal" && Boolean(pane.runner));
  return ITEMS.map((item) => item.action).filter((action) =>
    action === "rename" ? pane.kind === "terminal" || pane.kind === "thread" : action === "retitle" ? conversation : true,
  );
}

export function RailPaneMenu({
  pane,
  at,
  onAct,
  onClose,
  groups = [],
  framed = null,
  onRegroup,
  hide = [],
}: {
  pane: RailPane;
  /** Unused since the head line went (mockups/code-rail-pane-menu-dia.html); callers still pass it. */
  folder?: string;
  at: { x: number; y: number };
  onAct: (action: RailPaneAction) => void;
  onClose: () => void;
  /** The workspace's other named groups, offered under "Move to group". */
  groups?: { id: string; name: string; color: FrameColor }[];
  /** What the pane is in now: a named group, an unnamed split, or nothing. */
  framed?: "group" | "split" | null;
  onRegroup?: (action: RegroupAction) => void;
  /** Actions this place already offers itself (the header renames on its own title). */
  hide?: RailPaneAction[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pos, setPos] = useState(at);
  // The group submenu: where it sits, and whether the keyboard opened it (then it takes focus).
  const [sub, setSub] = useState<{ x: number; y: number; focus: boolean } | null>(null);
  const actions = railPaneActions(pane).filter((action) => !hide.includes(action));
  const items = ITEMS.filter((item) => actions.includes(item.action));
  const mainItems = items.filter((item) => item.action !== "close");
  const closeItem = items.find((item) => item.action === "close");

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    // Kept on screen: a row near the bottom opens its menu upward.
    const { width, height } = menu.getBoundingClientRect();
    setPos({ x: Math.min(at.x, innerWidth - width - 8), y: Math.max(8, Math.min(at.y, innerHeight - height - 8)) });
    menu.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const outside = (event: PointerEvent) =>
      !menu.contains(event.target as Node) && !subRef.current?.contains(event.target as Node) && onClose();
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [at, onClose]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  // Placed beside the menu, flipped left at the window's edge, then focused when the keyboard opened it.
  useEffect(() => {
    const el = subRef.current;
    if (!sub || !el) return;
    const menu = ref.current!.getBoundingClientRect();
    const { width, height } = el.getBoundingClientRect();
    const x = menu.right + 4 + width > innerWidth - 8 ? menu.left - 4 - width : menu.right + 4;
    const y = Math.max(8, Math.min(sub.y, innerHeight - height - 8));
    if (x !== sub.x || y !== sub.y) setSub({ ...sub, x, y });
    if (sub.focus) el.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [sub]);

  const openSub = (focus: boolean) => {
    clearTimeout(closeTimer.current);
    if (sub && !focus) return;
    const trigger = triggerRef.current!.getBoundingClientRect();
    setSub({ x: trigger.right, y: trigger.top - 4, focus });
  };
  // A short delay, so the pointer can cross a neighbouring row on its way into the submenu.
  const closeSubSoon = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setSub(null), 150);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key.toLowerCase();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    const item = items.find((candidate) => candidate.key.includes(key));
    if (key === "escape" || key === "tab") onClose();
    else if (key === "arrowdown") buttons[(i + 1) % buttons.length]?.focus();
    else if (key === "arrowup") buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else if (key === "arrowright" && document.activeElement === triggerRef.current) openSub(true);
    else if (item) onAct(item.action);
    else if (onRegroup && key === "g") onRegroup({ kind: "new" });
    else if (onRegroup && framed && key === "o") onRegroup({ kind: "out" });
    else return;
    event.preventDefault();
    // The rail's and the window's own shortcuts must not see a key the menu used.
    event.stopPropagation();
  };

  const onSubKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key.toLowerCase();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    if (key === "arrowleft" || key === "escape") {
      setSub(null);
      triggerRef.current?.focus();
    } else if (key === "tab") onClose();
    else if (key === "arrowdown") buttons[(i + 1) % buttons.length]?.focus();
    else if (key === "arrowup") buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const menuItem = (item: (typeof ITEMS)[number]) => (
    <MenuItem
      key={item.action}
      label={item.label}
      keycap={item.keycap}
      danger={item.action === "close"}
      onClick={() => onAct(item.action)}
    />
  );

  return createPortal(
    <>
      <div
        ref={ref}
        className="chat-thread-menu ws-pane-menu"
        role="menu"
        aria-label={`Actions for ${pane.title}`}
        style={{ left: pos.x, top: pos.y }}
        onKeyDown={onKeyDown}
        // Any row other than the trigger closes the submenu, as in a native menu.
        onPointerOver={(event) => {
          if (sub && !triggerRef.current?.contains(event.target as Node)) closeSubSoon();
        }}
      >
        {mainItems.map(menuItem)}
        {onRegroup ? (
          <>
            <div className="ws-pane-menu-sep" role="separator" />
            <MenuItem label="New group with pane" keycap="G" onClick={() => onRegroup({ kind: "new" })} />
            {groups.length ? (
              <button
                ref={triggerRef}
                type="button"
                role="menuitem"
                className="chat-thread-menu-item"
                aria-haspopup="menu"
                aria-expanded={Boolean(sub)}
                data-open={sub ? "" : undefined}
                onPointerEnter={() => openSub(false)}
                onPointerLeave={closeSubSoon}
                onClick={() => openSub(true)}
              >
                Move to group
                <svg className="ws-pane-menu-arrow" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>
            ) : null}
            {framed ? (
              <MenuItem label={framed === "group" ? "Take out of group" : "Take out of split"} keycap="O" onClick={() => onRegroup({ kind: "out" })} />
            ) : null}
          </>
        ) : null}
        {closeItem ? menuItem(closeItem) : null}
      </div>
      {sub && onRegroup ? (
        <div
          ref={subRef}
          className="chat-thread-menu ws-pane-menu ws-pane-submenu"
          role="menu"
          aria-label="Move to group"
          style={{ left: sub.x, top: sub.y }}
          onKeyDown={onSubKeyDown}
          onPointerEnter={() => clearTimeout(closeTimer.current)}
          onPointerLeave={closeSubSoon}
        >
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              role="menuitem"
              className="chat-thread-menu-item"
              onClick={() => onRegroup({ kind: "move", frameId: group.id })}
            >
              <span className="ws-pane-menu-dot" data-color={group.color} aria-hidden="true" />
              <span className="ws-pane-menu-label">{group.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </>,
    document.body,
  );
}
