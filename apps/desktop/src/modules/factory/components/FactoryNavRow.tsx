"use client";

import { Factory } from "lucide-react";
import "@/styles/factory.css";

/**
 * Factory's entry in the sidebar. The badge counts only the runs that wait for a person, in the
 * same orange as "needs you" everywhere else; working and finished runs stay quiet.
 */
export function FactoryNavRow({ active, needsYou, onOpen }: { active: boolean; needsYou: number; onOpen: () => void }) {
  const waiting = needsYou > 0;
  const noun = needsYou === 1 ? "run needs you" : "runs need you";
  return (
    <button
      type="button"
      className="ws-rail-nav-item"
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={onOpen}
      title={waiting ? `Factory: ${needsYou} ${noun}` : "Factory"}
    >
      <Factory size={15} strokeWidth={1.75} aria-hidden />
      <span className="ws-rail-nav-label">Factory</span>
      {waiting ? (
        <span className="ws-rail-count" data-tone="ask" aria-label={`${needsYou} ${noun}`}>
          {needsYou}
        </span>
      ) : null}
    </button>
  );
}
