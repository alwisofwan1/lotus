"use client";

import { Workflow } from "lucide-react";

/**
 * Automation's entry in the window's sidebar, above Tasks. A panel you step into, like Tasks —
 * see `TasksNavRow` for why that is a sidebar row and not a mode.
 *
 * The count is drafts waiting for a human: the only automation state that asks for action.
 */

export interface AutomationNavRowProps {
  pendingCount: number;
  active: boolean;
  onOpen: () => void;
}

export function AutomationNavRow({ pendingCount, active, onOpen }: AutomationNavRowProps) {
  return (
    <button
      type="button"
      className="ws-rail-nav-item"
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={onOpen}
      title={pendingCount > 0 ? `Automations: ${pendingCount} waiting for you` : "Automations"}
    >
      <Workflow size={15} strokeWidth={1.75} aria-hidden />
      <span className="ws-rail-nav-label">Automations</span>
      {/* Drafts waiting on a human: the rail's one "needs you" signal, the same as a folder's. */}
      {pendingCount > 0 ? (
        <span className="ws-rail-count" data-tone="ask">
          {pendingCount}
        </span>
      ) : null}
    </button>
  );
}
