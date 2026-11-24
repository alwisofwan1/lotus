// Merges the built-in theme catalog with user/agent-authored specs (ADR-0023,
// Phase 3). Pure + total: invalid specs are skipped (reported, never thrown), and
// a user theme can't shadow a built-in id — the curated set stays authoritative.

import { BUILTIN_THEMES } from "./builtin-themes";
import { validateCanvasThemeSpec } from "./canvas-theme-schema";
import type { CanvasTheme } from "../../types/canvas-theme";

export interface CatalogMerge {
  themes: CanvasTheme[];
  skipped: Array<{ id: unknown; errors: string[] }>;
}

export function mergeCanvasThemeCatalog(
  userSpecs: unknown[],
  builtins: readonly CanvasTheme[] = BUILTIN_THEMES,
): CatalogMerge {
  const themes: CanvasTheme[] = [...builtins];
  const seen = new Set(themes.map((t) => t.id));
  const skipped: CatalogMerge["skipped"] = [];

  for (const spec of userSpecs) {
    const result = validateCanvasThemeSpec(spec);
    if (!result.ok) {
      skipped.push({ id: (spec as { id?: unknown })?.id, errors: result.errors });
      continue;
    }
    if (seen.has(result.theme.id)) {
      skipped.push({ id: result.theme.id, errors: [`id "${result.theme.id}" collides with a built-in or earlier theme`] });
      continue;
    }
    seen.add(result.theme.id);
    themes.push(result.theme);
  }

  return { themes, skipped };
}
