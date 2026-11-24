"use client";

import { Cable } from "lucide-react";

/**
 * Connectors' entry in the sidebar, under Automations. `attention` lights when a connection
 * stopped and needs the user (Slack gave up reconnecting): the only connector state that asks
 * for action.
 */
export function ConnectorsNavRow({ active, attention, onOpen }: { active: boolean; attention: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="ws-rail-nav-item"
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={onOpen}
      title={attention ? "Connectors: a connection needs attention" : "Connectors"}
    >
      <Cable size={15} strokeWidth={1.75} aria-hidden />
      <span className="ws-rail-nav-label">Connectors</span>
      {/* A connection to fix has no number worth counting: the lit dot alone. */}
      {attention ? <span className="ws-rail-count" data-tone="ask" role="img" aria-label="needs attention" /> : null}
    </button>
  );
}
