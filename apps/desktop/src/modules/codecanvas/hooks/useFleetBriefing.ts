"use client";

/**
 * Whether the fleet briefing is revealing headlines right now
 * (`plans/agent-headlines/` follow-on).
 *
 * Read by every agent card, so the store's `version` only advances on a real change — a no-op
 * dismiss must not repaint a board of eight nodes.
 */

import { useCallback, useSyncExternalStore } from "react";
import { fleetBriefing, type FleetBriefing } from "../services/fleet-briefing";

export function useFleetBriefing(briefing: FleetBriefing = fleetBriefing): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => briefing.subscribe(onChange),
    [briefing],
  );
  return useSyncExternalStore(subscribe, () => briefing.isOn(), () => false);
}
