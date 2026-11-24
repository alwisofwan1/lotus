export type ThemeId = "dark" | "light";
export type ThemePreference = "system" | ThemeId;
export type ResolvedThemeMode = "dark" | "light";

export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  brightBlack: string;
  red: string;
  brightRed: string;
  green: string;
  brightGreen: string;
  yellow: string;
  brightYellow: string;
  blue: string;
  brightBlue: string;
  magenta: string;
  brightMagenta: string;
  cyan: string;
  brightCyan: string;
  white: string;
  brightWhite: string;
};

/**
 * One theme's neutral surfaces, darkest-to-lightest on dark and the reverse on light: every step is
 * the same warm hue at a different lightness, so stacked panels read as one material.
 */
export type SurfaceRamp = {
  /** Behind everything: sidebar, terminal well. */
  canvas: string;
  bg: string;
  /** Cards. */
  surface: string;
  raised: string;
  /** Popovers, menus, dialogs. */
  overlay: string;
  /** The opaque hairline colour; borders laid over a surface use `ui.border` instead. */
  hairline: string;
};

export const STATUS_TONES = ["success", "warning", "danger", "info"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

export type AppTheme = {
  id: ThemeId;
  name: string;
  type: ResolvedThemeMode;
  ramp: SurfaceRamp;
  /** The only colour in the UI: text and icons that report a state, each AA on a card. */
  semantic: Record<StatusTone, string>;
  ui: {
    background: string;
    backgroundSecondary: string;
    backgroundCard: string;
    backgroundElevated: string;
    foreground: string;
    foregroundMuted: string;
    accent: string;
    accentForeground: string;
    border: string;
    borderSubtle: string;
    scrollbar: string;
  };
  /** Text levels below `ui.foreground` (primary) and `ui.foregroundMuted`. */
  text: {
    secondary: string;
    /** Icons, placeholders and disabled text only — at least 3:1, never a sentence to read. */
    quiet: string;
    workbenchSecondary: string;
    workbenchMuted: string;
    workbenchQuiet: string;
    /** `--text-secondary` / `--text-muted`, read by older CSS. */
    legacySecondary: string;
    legacyMuted: string;
  };
  /** Washes laid over a surface for hover and pressed states. */
  fill: {
    soft: string;
    hover: string;
    active: string;
    /** `--bg-hover`, read by older CSS. */
    legacyHover: string;
  };
  /** Surfaces outside the `ui` ramp: translucent workbench panes, chips, popovers. */
  surface: {
    /** The sidebar's own ground, and the edge (if any) between it and the work. */
    rail: string;
    railEdge: string;
    /** The shell ground on macOS glass: a translucent tint the native vibrancy shows through. */
    glassGround: string;
    stone: string;
    workbench: string;
    workbenchRaised: string;
    pane: string;
    paneHeader: string;
    accentSoft: string;
    bubbleAi: string;
    popover: string;
    popoverStrong: string;
    popoverSoft: string;
    popoverBorder: string;
  };
  focusRing: {
    base: string;
    workbench: string;
  };
  /**
   * Full `box-shadow` values: `edge` is the hairline inset, `soft` and `lift` the elevations,
   * `popover` elevation 3 (menus, popovers, tooltips). `ink` is the opaque colour they are drawn in,
   * for a shadow of another shape: mix it to the alpha you need.
   */
  shadow: {
    ink: string;
    edge: string;
    soft: string;
    lift: string;
    popover: string;
    workbenchEdge: string;
    workbenchSoft: string;
    workbenchLift: string;
  };
  /** Status colours outside the semantic set. */
  status: {
    tabDirty: string;
    /** Ink on a `semantic.danger` fill (destructive buttons); not tied to the accent. */
    dangerForeground: string;
    folderIcon: string;
    /** Brand gold for highlights (New workspace, chat skills). */
    gold: string;
    /** Gold that reads on an `ui.accent` fill (a key cap on the primary button). */
    goldOnAccent: string;
  };
  terminal: TerminalTheme;
};

export type DesignThemeCssVars = Record<`--${string}`, string>;
