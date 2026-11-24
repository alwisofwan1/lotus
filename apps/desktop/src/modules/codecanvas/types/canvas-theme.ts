// CodeCanvas Artisan Theme Engine — domain types.
// See docs/adr/0023-codecanvas-artisan-theme-engine.md and
// plans/codecanvas-artisan-themes/plan.md.
//
// A CanvasTheme is a CONSTRAINED TOKEN BAG — never raw CSS. It is resolved
// deterministically into CSS custom properties by `resolveCanvasTheme`
// (services/theme/resolve-canvas-theme.ts), scoped to `.codecanvas-shell`.

/** Node-content text scale (terminals, markdown reader, chat). Orthogonal to theme. */
export type TextSize = "xs" | "sm" | "md" | "lg" | "xl";

export const TEXT_SIZES: readonly TextSize[] = ["xs", "sm", "md", "lg", "xl"];
export const DEFAULT_TEXT_SIZE: TextSize = "md";

/** Maps a TextSize to the rem value emitted as `--canvas-node-text-size`. */
export const TEXT_SIZE_REM: Record<TextSize, string> = {
  xs: "0.75rem",
  sm: "0.8125rem",
  md: "0.875rem",
  lg: "0.9375rem",
  xl: "1.0625rem",
};

/** Surface treatment of nodes — a theme axis independent of colour. */
export type CanvasMaterial = "glass" | "solid" | "grain" | "paper";

export const CANVAS_MATERIALS: readonly CanvasMaterial[] = ["glass", "solid", "grain", "paper"];

/**
 * Whitelisted font families. A theme may only name fonts from these buckets;
 * the resolver falls back and the authoring tool rejects anything else.
 * (Actual @font-face / woff2 bundling lands in Phase 1 — these are the names.)
 */
export const CANVAS_FONT_WHITELIST = {
  display: ["Caveat", "Gloria Hallelujah", "Fraunces", "Space Grotesk"],
  body: ["Inter", "Söhne", "IBM Plex Sans", "Newsreader"],
  mono: ["JetBrains Mono", "Berkeley Mono", "IBM Plex Mono", "Geist Mono"],
  /**
   * The HUD voice: run-state badges, context chips, model and tool labels — the 8-10px
   * uppercase-ish metadata a node prints about itself, never its content.
   *
   * A pixel face belongs HERE and nowhere else. At heading size it reads as a costume; at
   * 8-10px it reads as an in-world status readout, which is the register these labels are
   * already in. Note the sizes: `--canvas-font-hud` is only consumed by rules whose
   * font-size is a whole number of pixels, because a pixel face rendered at 8.32px is mush.
   *
   * Deliberately NOT here: anything Mojang owns. Minecraft's face (Mojangles) is their
   * proprietary asset, and a traced clone is the same problem wearing a hat.
   */
  hud: ["Silkscreen", "Pixelify Sans"],
} as const;

export type CanvasFontBucket = keyof typeof CANVAS_FONT_WHITELIST;

/**
 * Status/run-state ramp. THEME-INDEPENDENT (ADR-0023 §2b): these encode meaning,
 * not decoration, so a theme can never remap their hue. The resolver always emits
 * them as `--canvas-status-*` regardless of the active theme. Values mirror the
 * pre-existing `.agent-status--*` colours in agent-node.css so the migration is
 * visually neutral; `blocked` is net-new (no prior CSS) and additive.
 */
export const STATUS_TONES = {
  idle: "#ffffff",
  connecting: "#fbbf24",
  running: "#34d399",
  completed: "#60a5fa",
  error: "#f87171",
  blocked: "#fb923c",
} as const;

export type CanvasStatusState = keyof typeof STATUS_TONES;

/** Background media for a theme's paper layer (image now; video in Phase 2). */
export interface CanvasPaperMedia {
  kind: "image" | "video";
  /** Relative to the theme's folder; resolved to an asset-protocol URL at render. */
  src: string;
  /** Poster frame — required for video. */
  poster?: string;
  fit: "cover" | "contain";
}

/** The canvas background layer. Subsumes the old background-only theme. */
export interface CanvasPaper {
  /** CSS colour or gradient painted behind the graph. */
  fill: string;
  /** Optional dot/line overlay (the former BackgroundVariant). */
  pattern?: "none" | "dots" | "lines";
  media?: CanvasPaperMedia;
  /**
   * The dominant colour of `media`, measured once and authored here.
   *
   * `fill` is a hand-drawn stand-in for the wallpaper, and on a photo theme the two can
   * disagree completely: Lakeside Day's fill is pure blue (sky and deep water) while 46% of
   * the photograph is foliage. Anything derived from `fill` therefore reads as foreign on top
   * of the actual image — which is what made the terminal floor look like a navy hole punched
   * through a green scene.
   *
   * Measured, not eyeballed: k-means over a 96×54 sample of the image, largest cluster.
   * Authored rather than sampled at runtime so the theme resolver stays pure and synchronous,
   * the same as every other design value in this file.
   *
   * Consumed by `resolveTerminalFloor`. Omit it and the floor falls back to `fill`.
   */
  sampled?: string;
}

/** The 5 semantic palette roles. Stored as solid hex; alpha variants are derived. */
export interface CanvasPalette {
  /** Wires, selection rings, active node glow — the canvas's signature colour. */
  accent: string;
  agent: string;
  task: string;
  note: string;
  /** Terminal / browser nodes. */
  info: string;
}

/** Node surface colours. May carry alpha (e.g. translucent glass base). */
export interface CanvasSurface {
  base: string;
  raised: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  /** UI chrome accent (buttons/focus) — distinct from palette.accent (graph). Solid hex. */
  chromeAccent: string;
}

/**
 * Structural + colour config for `material: "glass"`. Required when material is
 * "glass"; absent otherwise. Carries full CSS strings (filters/shadows/colours).
 */
export interface CanvasGlass {
  bg: string;
  filter: string;
  border: string;
  shadow: string;
  inset: string;
  headerGrad: string;
  panelBg: string;
  panelFilter: string;
}

export interface CanvasFonts {
  display: string;
  body: string;
  mono: string;
  /**
   * OPTIONAL, and optional on purpose. The resolver emits `--canvas-font-hud` only when a
   * theme sets this, so every consumer spells its fallback out — `var(--canvas-font-hud,
   * var(--font-mono, …))`. A theme that omits it renders byte-identically to before the
   * bucket existed, which is what let this land without touching the other five builtins.
   */
  hud?: string;
}

/** A complete, validated CodeCanvas theme. */
export interface CanvasTheme {
  id: string;
  name: string;
  descriptor: string;
  mode: "dark" | "light";
  material: CanvasMaterial;
  paper: CanvasPaper;
  palette: CanvasPalette;
  surface: CanvasSurface;
  glass?: CanvasGlass;
  fonts: CanvasFonts;
  /**
   * A 16:9 still that shows what this theme actually looks like — the paper, the node
   * material, the palette on the wires. Same ref rules as `paper.media.src`: a bundled
   * web-absolute path, a remote/data URI, or a file relative to the theme's folder.
   *
   * It exists because `paper.fill` cannot do this job. On the three photo/video themes
   * `fill` is an admitted hand-drawn stand-in for the wallpaper (see CanvasPaper.sampled),
   * so a card painted from `fill` showed Lakeside as a plum gradient — a preview that
   * disagreed with the theme it was previewing. And `fill` says nothing at all about
   * `material`, which is half of what switching a theme changes.
   *
   * OPTIONAL, and the Style tab degrades in a defined order: `preview` →
   * `paper.media.poster` → `paper.media.src` → a CSS card painted from `fill` + palette.
   * So an agent-authored theme still gets a usable card for free, exactly as before.
   *
   * Built-in previews are generated by `scripts/gen-theme-previews.ts`; re-run it when a
   * built-in's paper, palette or glass changes.
   */
  preview?: string;
  defaultTextSize?: TextSize;
  schemaVersion: 1;
  /** Filled by the loader, not authored. */
  origin?: "builtin" | "user";
}
