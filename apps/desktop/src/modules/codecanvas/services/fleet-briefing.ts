/**
 * The fleet briefing: reveal every agent's headline at once, whatever the zoom
 * (`plans/agent-headlines/` follow-on, after CNVS 1.4.0's `F` key).
 *
 * **Why it exists.** The card headline renders only when the terminal does not — below zoom 0.5,
 * where `collapsed` takes the PTY viewport away. That trade keeps ~14px of chrome off every card at
 * full zoom, and its cost is that the answer is unavailable exactly when the operator is zoomed in
 * on one thing and wants to know what everyone ELSE is doing. The briefing is the deliberate way to
 * ask, without moving the camera.
 *
 * A toggle rather than a hold, because the canvas hotkey dispatcher resolves ordinary chords on
 * keydown only — press-and-hold is available to modifier-only chords and nothing else. So it is
 * dismissed explicitly instead: Escape clears it, alongside everything else Escape steps out of.
 */

export interface FleetBriefing {
  isOn(): boolean;
  toggle(): void;
  /** Turn it off. Idempotent — Escape fires for many reasons and callers must not have to check. */
  dismiss(): void;
  subscribe(listener: () => void): () => void;
  /** Advances only on a real change, so a no-op dismiss repaints no cards. */
  version(): number;
}

export function createFleetBriefing(): FleetBriefing {
  let on = false;
  let version = 0;
  const listeners = new Set<() => void>();
  const set = (next: boolean) => {
    if (on === next) return;
    on = next;
    version += 1;
    listeners.forEach((listener) => listener());
  };

  return {
    isOn: () => on,
    toggle: () => set(!on),
    dismiss: () => set(false),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
}

/** Process-wide: the hotkey writes, every agent card reads. */
export const fleetBriefing: FleetBriefing = createFleetBriefing();
