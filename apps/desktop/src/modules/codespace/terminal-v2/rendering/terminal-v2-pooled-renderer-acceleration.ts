import type { Terminal } from "@xterm/xterm";
import { activateWebglRenderer } from "@/modules/codespace/services/terminal-addons";
import type { TerminalV2PooledXtermLike } from "./terminal-v2-pooled-xterm-renderer-factory";

/**
 * Promoting the slot that is on screen to an accelerated renderer, and giving it back when the
 * slot parks.
 *
 * Why this exists at all: every pooled terminal is built with `customGlyphs` and
 * `rescaleOverlappingGlyphs`, and xterm's own typings say both are ignored by the DOM renderer.
 * Block art, box frames and the shade characters agent CLIs draw meters with therefore come from
 * the font, seams and dither included, until a canvas-backed renderer is live.
 */

/** What an accelerated renderer hands back: something to give up when the slot parks. */
export type TerminalV2PooledXtermAcceleration = {
  dispose(): void;
};

export type TerminalV2PooledXtermAcceleratorContext = {
  /** The slot stopped being the visible one, or died, while the addon import was in flight. */
  isStale(): boolean;
  /** The GPU context was lost; the addon has already disposed itself when this runs. */
  onLost(): void;
};

export type TerminalV2PooledXtermAccelerator = (
  terminal: TerminalV2PooledXtermLike,
  context: TerminalV2PooledXtermAcceleratorContext,
) => Promise<TerminalV2PooledXtermAcceleration | null>;

/**
 * The default accelerator: xterm's WebGL renderer.
 *
 * `shouldActivateTerminalWebgl` still has the final say — `policy = "off"`, the 24h context-loss
 * backoff and a software GPU each still refuse. What it no longer refuses is this surface:
 * `codespace-pooled` is exempt from the blanket Tauri disable, because the pane lifecycle that
 * guard is about is the one this module handles (see the note on `surface` in
 * `terminal-webgl-policy.ts`, and the live verification recorded there).
 *
 * `activePaneEligible` is true for an ATTACHED slot rather than only a focused one. A pooled slot
 * holds at most one pane and parks when that pane stops being visible, so live GPU contexts are
 * bounded by the pool's capacity — and a renderer that changed the SHAPE of block glyphs every
 * time focus moved would be worse than either renderer used consistently.
 */
export const activatePooledWebglRenderer: TerminalV2PooledXtermAccelerator = (
  terminal,
  { isStale, onLost },
) => activateWebglRenderer(terminal as unknown as Terminal, {
  activePaneEligible: true,
  surface: "codespace-pooled",
  isStale,
  onLost,
});

export type TerminalV2PooledRendererAcceleration = {
  /** The slot is now on screen inside a pane, or has gone back to the parking container. */
  setVisible(visible: boolean): void;
  /** The renderer is going away; release the GPU context before the terminal is disposed. */
  dispose(): void;
};

export function createTerminalV2PooledRendererAcceleration({
  terminal,
  accelerate = activatePooledWebglRenderer,
}: {
  terminal: TerminalV2PooledXtermLike;
  accelerate?: TerminalV2PooledXtermAccelerator;
}): TerminalV2PooledRendererAcceleration {
  let disposed = false;
  let visible = false;
  let active: TerminalV2PooledXtermAcceleration | null = null;
  let inFlight = false;

  const release = () => {
    active?.dispose();
    active = null;
  };

  return {
    setVisible(nextVisible) {
      if (disposed) return;
      visible = nextVisible;
      if (!nextVisible) {
        // A parked slot keeps its terminal alive, so holding a GPU context there would spend one
        // of the webview's few contexts on something nobody is looking at. Disposing the addon is
        // all it takes: xterm falls back to the DOM renderer by itself.
        release();
        return;
      }
      if (active || inFlight) return;
      inFlight = true;
      void accelerate(terminal, {
        isStale: () => disposed || !visible,
        onLost: () => {
          // The addon disposed itself before reporting the loss; dropping the reference is what
          // lets a later attach try again once the policy's backoff has expired.
          active = null;
        },
      })
        .then((activation) => {
          inFlight = false;
          if (!activation) return;
          if (disposed || !visible) {
            activation.dispose();
            return;
          }
          active = activation;
        })
        .catch((error: unknown) => {
          inFlight = false;
          console.warn("[terminal-v2] pooled renderer acceleration failed:", error);
        });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      visible = false;
      release();
    },
  };
}
