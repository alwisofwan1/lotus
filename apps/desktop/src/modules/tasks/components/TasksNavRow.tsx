"use client";

import { ListTodo } from "lucide-react";

/**
 * The tracker's entry in the window's sidebar.
 *
 * This is where `bb` puts it, and the placement carries a claim: Tasks is not a fourth kind of
 * workspace to switch into, it is a panel you step into and back out of while everything else
 * keeps running. Putting it in the mode switcher said the opposite.
 *
 * The count is **open tasks**, not all of them — `bb`'s sidebar does the same, and the reason is
 * that a badge is a prompt to act. "47" when 45 are done is a number that teaches you to ignore
 * the badge. Zero draws nothing at all.
 */

export interface TasksNavRowProps {
  openCount: number;
  active: boolean;
  onOpen: () => void;
}

export function TasksNavRow({ openCount, active, onOpen }: TasksNavRowProps) {
  return (
    <button
      type="button"
      className="ws-rail-nav-item"
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={onOpen}
      title={openCount > 0 ? `Tasks — ${openCount} open` : "Tasks"}
    >
      <ListTodo size={15} strokeWidth={1.75} aria-hidden />
      <span className="ws-rail-nav-label">Tasks</span>
      {/* Capped: past 99 the exact number is not something anyone acts on. The title keeps it. */}
      {openCount > 0 ? <span className="ws-rail-count">{openCount > 99 ? "99+" : openCount}</span> : null}
    </button>
  );
}
