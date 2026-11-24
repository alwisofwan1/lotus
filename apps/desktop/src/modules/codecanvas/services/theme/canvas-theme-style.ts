// Maps a resolved CanvasTheme into the private `--ct-*` "theme source" layer
// that styles/canvas/theme.css consumes (see ADR-0023, Phase 0b). The base block
// reads `var(--ct-canvas-bg, …fallback)`, so injecting these vars drives the
// canvas without an inline-specificity war with legacy `[data-canvas-theme]` rules.

import type { CSSProperties } from "react";
import { resolveCanvasTheme } from "./resolve-canvas-theme";
import type { CanvasTheme } from "../../types/canvas-theme";

/** Resolve a theme and rename every `--x` var to its `--ct-x` source-layer twin. */
export function toCanvasThemeStyle(theme: CanvasTheme): CSSProperties {
  const resolved = resolveCanvasTheme(theme);
  const style: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) {
    style[`--ct-${key.slice(2)}`] = value;
  }
  return style as CSSProperties;
}
