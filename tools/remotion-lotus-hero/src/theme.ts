/**
 * The APP's palette, not the website's.
 *
 * The first cut of this video used apps/web's desaturated instrument palette on a
 * near-black ground, and it looked nothing like Lotus — a generic architecture
 * diagram. Lotus is a navy canvas of floating, blurred windows with saturated status
 * colours. These values are read out of the product:
 *
 *   apps/desktop/src/modules/codecanvas/types/canvas-theme.ts
 *   apps/desktop/src/modules/codecanvas/types/canvas-background-theme.ts
 *   apps/desktop/src/styles/canvas/agent-node.css
 *
 * A correction worth writing down: the first cut deliberately refused window chrome,
 * reasoning that chrome would make an animation look like a fake screencast. That was
 * wrong. The honesty rule is "never claim what is not real" — not "never depict the
 * real UI". Being coy about the product's own appearance made the video less true.
 */
export const T = {
  /** Ground. `void` is the default background theme: dots, gap 24, 5% white. */
  navy0: "#16233c",
  navy1: "#0e1728",
  navy2: "#080e1a",
  dot: "rgba(255,255,255,0.05)",
  dotGap: 24,

  /** Node windows: translucent, blurred, hairline. */
  panel: "rgba(10,16,28,0.72)",
  panelSolid: "rgba(8,13,23,0.94)",
  bar: "rgba(255,255,255,0.035)",
  hair: "rgba(255,255,255,0.09)",
  hair2: "rgba(255,255,255,0.16)",

  ink: "#e8edf5",
  dim: "#94a3b8",
  faint: "#5b6a80",

  /** Status, from canvas-theme.ts. Saturated — this is the app, not the site. */
  running: "#34d399",
  waiting: "#fbbf24",
  error: "#f87171",
  info: "#60a5fa",
  accent: "#7c3aed",
  cyan: "#67e8f9",
} as const;

export const FPS = 30;

export const TIMELINE = {
  title: { from: 0, durationInFrames: 90 },
  codespace: { from: 90, durationInFrames: 420 },
  codecanvas: { from: 510, durationInFrames: 600 },
  closing: { from: 1110, durationInFrames: 150 },
} as const;

export const TOTAL = TIMELINE.closing.from + TIMELINE.closing.durationInFrames;
