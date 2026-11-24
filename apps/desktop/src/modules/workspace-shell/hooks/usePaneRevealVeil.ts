"use client";

import { useEffect, useRef, useState } from "react";
import { reportPaneVeil } from "@/modules/codespace/terminal-v2/rendering/terminal-v2-render-probe";
import { subscribeTerminalV2Redraw } from "@/modules/codespace/terminal-v2/runtime/terminal-v2-session-redraw";
import {
  createPaneRevealVeil,
  PANE_VEIL_BOOT_MAX_MS,
  PANE_VEIL_BOOT_QUIET_MS,
  PANE_VEIL_RESTART_MAX_MS,
  PANE_VEIL_RESTART_QUIET_MS,
  type PaneRevealVeil,
  type PaneRevealVeilStart,
} from "@/modules/workspace-shell/services/pane-reveal-veil";

interface UsePaneRevealVeilOptions {
  paneId: string;
  /** The pane keeps its renderer; false → true means it was rebuilt and is being repainted. */
  attached: boolean;
  /** Focus mode maximised this pane; either change resizes it and the agent repaints. */
  maximized: boolean;
  /** Pane output, to tell when the repaint has gone quiet. Null for non-terminal panes. */
  subscribeOutput: ((paneId: string, listener: (data: string) => void) => () => void) | null;
  /** The pane's Claude account; a change restarts the agent in place (account move). */
  restartKey?: string | null;
  /** Veil from the first mount until the agent's first output: a pane that was just launched. */
  boot?: boolean;
}

/**
 * `on`: the veil covers the pane. `out`: it is fading away (still mounted so the fade can run).
 * `off`: nothing drawn, so an idle pane carries no animated layer at all.
 * `restart`: `on` while the agent relaunches; the pane also holds keystrokes, which the booting
 * CLI would only echo raw and lose (measured 2026-11-16).
 */
export type PaneVeilPhase = "off" | "on" | "restart" | "out";

/** How long the veil takes to fade away; matches `.ws-pane-veil` in workspace-shell.css. */
export const PANE_VEIL_FADE_MS = 240;

/**
 * Where a pane's veil is while focus mode on/off makes its agent repaint; see `pane-reveal-veil`.
 *
 * The veil is set DURING render (React's "adjust state when a prop changes"): the pane comes back
 * from `display: none` in the same commit that flips `attached`, and setting it from an effect
 * would let one frame of the empty renderer paint first. Only the timer starts in an effect.
 */
export function usePaneRevealVeil({ paneId, attached, maximized, subscribeOutput, restartKey = null, boot = false }: UsePaneRevealVeilOptions): PaneVeilPhase {
  // Same veil as focus mode, so a launch and a focus switch look alike (asked 2026-11-20).
  const [phase, setPhase] = useState<PaneVeilPhase>(boot ? "on" : "off");
  // A new object per veil, so the start effect runs once each time; `awaitRedraw` for a pane that
  // comes back, which gets a redraw step. A maximised/restored one is only resized.
  const [veilRequest, setVeilRequest] = useState<PaneRevealVeilStart | null>(
    () => (boot ? { awaitOutput: true, quietMs: PANE_VEIL_BOOT_QUIET_MS, maxMs: PANE_VEIL_BOOT_MAX_MS } : null),
  );
  const [previous, setPrevious] = useState({ attached, maximized, restartKey });
  const veilRef = useRef<PaneRevealVeil | null>(null);

  if (previous.attached !== attached || previous.maximized !== maximized || previous.restartKey !== restartKey) {
    const returned = attached && !previous.attached;
    const zoomChanged = attached && maximized !== previous.maximized;
    const restarted = attached && restartKey !== previous.restartKey;
    setPrevious({ attached, maximized, restartKey });
    if (restarted) {
      // Hides the old screen until the relaunched agent has repainted, so typing never lands on it.
      setPhase("restart");
      setVeilRequest({ awaitOutput: true, quietMs: PANE_VEIL_RESTART_QUIET_MS, maxMs: PANE_VEIL_RESTART_MAX_MS });
    } else if (returned || zoomChanged) {
      setPhase("on");
      setVeilRequest({ awaitRedraw: returned });
    }
  }

  useEffect(() => {
    const veil = createPaneRevealVeil(() => setPhase("out"));
    veilRef.current = veil;
    return () => {
      veil.dispose();
      veilRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!subscribeOutput) return undefined;
    return subscribeOutput(paneId, () => veilRef.current?.noteOutput());
  }, [paneId, subscribeOutput]);

  useEffect(() => subscribeTerminalV2Redraw((redrawPaneId, redrawPhase) => {
    if (redrawPaneId === paneId) veilRef.current?.noteRedraw(redrawPhase);
  }), [paneId]);

  const veilStartedAt = useRef(0);
  useEffect(() => {
    if (!veilRequest) return;
    veilStartedAt.current = performance.now();
    reportPaneVeil(paneId, "on");
    veilRef.current?.start(veilRequest);
    // Only a new veil restarts the timer; a pane id never changes under one mounted pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [veilRequest]);

  useEffect(() => {
    if (phase !== "out") return undefined;
    reportPaneVeil(paneId, "out", performance.now() - veilStartedAt.current);
    const timer = setTimeout(() => setPhase("off"), PANE_VEIL_FADE_MS);
    return () => clearTimeout(timer);
  }, [paneId, phase]);

  return phase;
}
