import { DESIGN_THEMES } from "@/lib/design-system/themes";
import type {
  AppTheme,
  DesignThemeCssVars,
  ResolvedThemeMode,
  ThemeId,
  ThemePreference,
} from "@/lib/design-system/theme-types";

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

const RETIRED_DARK_THEME_IDS = [
  "void",
  "ghost",
  "plasma",
  "carbon",
  "hex",
  "neon-tokyo",
  "obsidian",
  "nebula",
  "storm",
  "infrared",
  "nova",
  "stealth",
  "hologram",
  "dracula",
  "bridgemind",
  "synthwave",
  "cybernetics",
  "quantum",
  "mecha",
  "abyss",
  "gruvbox",
  "gruvbox-dark",
] as const;

const RETIRED_LIGHT_THEME_IDS = ["paper", "chalk", "solar", "arctic", "parchment", "ivory", "gruvbox-light"] as const;

/**
 * Theme ids Lotus no longer ships, mapped to the mode their users land on. Also embedded in the
 * pre-React bootstrap script, so both normalizers read this one table.
 */
export const RETIRED_THEME_MODES: Readonly<Record<string, ResolvedThemeMode>> = Object.fromEntries([
  ...RETIRED_DARK_THEME_IDS.map((id) => [id, "dark"] as const),
  ...RETIRED_LIGHT_THEME_IDS.map((id) => [id, "light"] as const),
]);

const THEME_IDS = new Set<ThemeId>(["dark", "light"]);

export function normalizeThemePreference(value: unknown): ThemePreference | null {
  if (value === "system") return "system";
  if (typeof value !== "string") return null;
  if (THEME_IDS.has(value as ThemeId)) return value as ThemeId;
  if (Object.hasOwn(RETIRED_THEME_MODES, value)) return RETIRED_THEME_MODES[value];
  return null;
}

export function resolveThemeMode(
  preference: ThemePreference,
  systemMode: ResolvedThemeMode,
): ResolvedThemeMode {
  return preference === "system" ? systemMode : preference;
}

export function getDesignTheme(id: ThemeId): AppTheme {
  return DESIGN_THEMES[id];
}

export function getDesignThemeCssVars(theme: AppTheme): DesignThemeCssVars {
  const { ramp, semantic, ui, text, fill, surface, focusRing, shadow, status } = theme;

  return {
    "--ds-canvas": ramp.canvas,
    "--ds-bg": ui.background,
    "--ds-bg-soft": ui.backgroundSecondary,
    "--ds-surface": ui.backgroundCard,
    "--ds-surface-raised": ui.backgroundElevated,
    "--ds-overlay": ramp.overlay,
    "--ds-hairline": ramp.hairline,
    "--ds-text": ui.foreground,
    "--ds-text-secondary": text.secondary,
    "--ds-text-muted": ui.foregroundMuted,
    "--ds-text-quiet": text.quiet,
    "--ds-success": semantic.success,
    "--ds-warning": semantic.warning,
    "--ds-danger": semantic.danger,
    "--ds-info": semantic.info,
    "--ds-danger-text": status.dangerForeground,
    "--ds-gold": status.gold,
    "--ds-gold-on-accent": status.goldOnAccent,
    "--ds-accent": ui.accent,
    "--ds-accent-text": ui.accentForeground,
    "--ds-border": ui.border,
    "--ds-border-subtle": ui.borderSubtle,
    "--ds-rail": surface.rail,
    "--ds-rail-edge": surface.railEdge,
    "--ds-glass-ground": surface.glassGround,
    "--ds-stone": surface.stone,
    "--ds-shadow-ink": shadow.ink,
    "--ds-shadow-edge": shadow.edge,
    "--ds-shadow-soft": shadow.soft,
    "--ds-shadow-lift": shadow.lift,
    "--ds-focus-ring": focusRing.base,
    "--ds-radius-card": "16px",
    "--ds-radius-control": "10px",
    "--ds-radius-pill": "9999px",
    "--ds-workbench-bg": ui.background,
    "--ds-workbench-bg-soft": ui.backgroundSecondary,
    "--ds-workbench-surface": surface.workbench,
    "--ds-workbench-surface-raised": surface.workbenchRaised,
    "--ds-workbench-surface-soft": fill.soft,
    "--ds-workbench-surface-hover": fill.hover,
    "--ds-workbench-surface-active": fill.active,
    "--ds-workbench-pane-bg": surface.pane,
    "--ds-workbench-terminal-bg": theme.terminal.background,
    "--ds-workbench-pane-header": surface.paneHeader,
    "--ds-workbench-text": ui.foreground,
    "--ds-workbench-text-secondary": text.workbenchSecondary,
    "--ds-workbench-text-muted": text.workbenchMuted,
    "--ds-workbench-text-quiet": text.workbenchQuiet,
    "--ds-workbench-border": ui.borderSubtle,
    "--ds-workbench-border-strong": ui.border,
    "--ds-workbench-accent": ui.accent,
    "--ds-workbench-accent-text": ui.accentForeground,
    "--ds-workbench-accent-soft": surface.accentSoft,
    "--ds-workbench-focus-ring": focusRing.workbench,
    "--ds-workbench-shadow-edge": shadow.workbenchEdge,
    "--ds-workbench-shadow-soft": shadow.workbenchSoft,
    "--ds-workbench-shadow-lift": shadow.workbenchLift,

    "--bg": ui.background,
    "--bg-sidebar": ui.backgroundSecondary,
    "--bg-card": ui.backgroundCard,
    "--bg-elevated": ui.backgroundElevated,
    "--fg": ui.foreground,
    "--fg-muted": ui.foregroundMuted,
    "--accent": ui.accent,
    "--accent-fg": ui.accentForeground,
    "--border": ui.border,
    "--border-sub": ui.borderSubtle,
    "--scrollbar": ui.scrollbar,
    "--text-secondary": text.legacySecondary,
    "--text-muted": text.legacyMuted,
    "--bg-hover": fill.legacyHover,
    "--bubble-ai-bg": surface.bubbleAi,

    // Extension tokens — replace hardcoded primitive colors in CSS files.
    // See plans/lotus-theme-unification for context.
    "--ds-workbench-tab-active-color": ui.accent,
    "--ds-workbench-tab-dirty-color": status.tabDirty,
    "--ds-workbench-folder-icon": status.folderIcon,
    "--ds-workbench-rail-accent": ui.accent,
    "--ds-workbench-popover-bg": surface.popover,
    "--ds-workbench-popover-bg-strong": surface.popoverStrong,
    "--ds-workbench-popover-bg-soft": surface.popoverSoft,
    "--ds-workbench-popover-border": surface.popoverBorder,
    "--ds-workbench-popover-shadow": shadow.popover,
  };
}
