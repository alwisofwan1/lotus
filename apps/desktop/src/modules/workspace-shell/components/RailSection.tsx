"use client";

import { ChevronLeft } from "lucide-react";

interface RailSectionProps {
  /** What the rail shows again on the way back: "Workspaces" in Code, "Threads" in Chat. */
  backLabel: string;
  onBack: () => void;
  /** The node the section draws its own sidebar into (a portal target). */
  targetRef: (el: HTMLDivElement | null) => void;
}

/**
 * A section's place in the window's one sidebar.
 *
 * While a section such as Automations is open, its channels take the place of the rail's list, so
 * the window never shows two sidebars side by side. The section draws into `targetRef` itself (it
 * owns that state); this only gives it the room and the way back to the list it replaced.
 */
export function RailSection({ backLabel, onBack, targetRef }: RailSectionProps) {
  return (
    <div className="ws-rail-host">
      <button type="button" className="ws-rail-back" onClick={onBack} aria-label={`Back to ${backLabel}`}>
        <ChevronLeft size={14} strokeWidth={1.75} aria-hidden />
        <span>{backLabel}</span>
      </button>
      <div className="ws-rail-host-body" ref={targetRef} />
    </div>
  );
}
