const TERMINAL_GRID_LIVE_RESIZE_EVENT = "lotus:terminal-grid-live-resize";

export type LegacyTerminalGridResizePhase = "live" | "commit";

export type LegacyTerminalGridResizeEventDetail = {
  phase: LegacyTerminalGridResizePhase;
};

export function emitLegacyTerminalGridLiveResize(detail: LegacyTerminalGridResizeEventDetail = { phase: "live" }): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<LegacyTerminalGridResizeEventDetail>(TERMINAL_GRID_LIVE_RESIZE_EVENT, { detail }));
}

export function subscribeLegacyTerminalGridLiveResize(callback: (detail: LegacyTerminalGridResizeEventDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const listener = (event: Event) => {
    const detail = event instanceof CustomEvent
      ? event.detail as LegacyTerminalGridResizeEventDetail | undefined
      : undefined;
    callback(detail?.phase ? detail : { phase: "live" });
  };

  window.addEventListener(TERMINAL_GRID_LIVE_RESIZE_EVENT, listener);
  return () => window.removeEventListener(TERMINAL_GRID_LIVE_RESIZE_EVENT, listener);
}
