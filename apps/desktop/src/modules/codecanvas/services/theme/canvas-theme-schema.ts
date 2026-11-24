// Validation for user/agent-authored theme specs (ADR-0023, Phase 3).
// The agent writes a theme.json; this is the gate that keeps the catalog safe —
// a constrained token bag, never raw CSS. Both the catalog loader (skip invalid)
// and the save tool (reject + report) validate through here.

import {
  CANVAS_FONT_WHITELIST,
  CANVAS_MATERIALS,
  TEXT_SIZES,
  type CanvasMaterial,
  type CanvasTheme,
  type TextSize,
} from "../../types/canvas-theme";

export type ThemeValidation =
  | { ok: true; theme: CanvasTheme }
  | { ok: false; errors: string[] };

const PALETTE_ROLES = ["accent", "agent", "task", "note", "info"] as const;
const SURFACE_KEYS = ["base", "raised", "border", "borderStrong", "text", "textMuted", "chromeAccent"] as const;
const GLASS_KEYS = ["bg", "filter", "border", "shadow", "inset", "headerGrad", "panelBg", "panelFilter"] as const;
const PATTERNS = ["none", "dots", "lines"] as const;
const FITS = ["cover", "contain"] as const;

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/**
 * Every whitelisted face, from every bucket. Derived rather than listed: the three buckets
 * used to be spelled out here, so adding the `hud` bucket made a valid built-in fail its own
 * schema until this line changed. Object.values means the next bucket cannot repeat that.
 *
 * Flat on purpose, and it always was: a face from any bucket satisfies any role, so
 * `fonts.body: "JetBrains Mono"` validates. That looseness is pre-existing and left alone —
 * tightening it would invalidate user themes already on disk. What it does NOT let through
 * is an unbundled face, which is the failure that actually bites (see layout.tsx). The
 * built-in catalog is held to the stricter per-bucket rule by canvas-hud-font.css.test.ts.
 */
const ALL_FONTS = new Set<string>(Object.values(CANVAS_FONT_WHITELIST).flat());

/**
 * Validate a raw parsed theme spec. On success returns the typed theme with
 * `origin: "user"` stamped (callers never trust an authored `origin`).
 */
export function validateCanvasThemeSpec(raw: unknown): ThemeValidation {
  const e: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["theme must be a JSON object"] };

  if (!isStr(raw.id) || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) e.push("id must be a non-empty kebab-case string");
  if (!isStr(raw.name)) e.push("name is required");
  if (!isStr(raw.descriptor)) e.push("descriptor is required");
  if (raw.mode !== "dark" && raw.mode !== "light") e.push('mode must be "dark" or "light"');
  if (!CANVAS_MATERIALS.includes(raw.material as CanvasMaterial)) e.push(`material must be one of ${CANVAS_MATERIALS.join("/")}`);
  if (raw.schemaVersion !== 1) e.push("schemaVersion must be 1");

  // paper
  const paper = raw.paper;
  if (!isObj(paper) || !isStr(paper.fill)) {
    e.push("paper.fill is required");
  } else {
    if (paper.pattern !== undefined && !PATTERNS.includes(paper.pattern as (typeof PATTERNS)[number]))
      e.push(`paper.pattern must be one of ${PATTERNS.join("/")}`);
    if (paper.media !== undefined) {
      const m = paper.media;
      if (!isObj(m)) e.push("paper.media must be an object");
      else {
        if (m.kind !== "image" && m.kind !== "video") e.push('paper.media.kind must be "image" or "video"');
        if (!isStr(m.src)) e.push("paper.media.src is required");
        if (!FITS.includes(m.fit as (typeof FITS)[number])) e.push(`paper.media.fit must be one of ${FITS.join("/")}`);
        if (m.kind === "video" && !isStr(m.poster)) e.push("paper.media.poster is required for video");
      }
    }
  }

  // palette — exactly the 5 roles, all strings
  const palette = raw.palette;
  if (!isObj(palette)) e.push("palette is required");
  else for (const role of PALETTE_ROLES) if (!isStr(palette[role])) e.push(`palette.${role} is required`);

  // surface
  const surface = raw.surface;
  if (!isObj(surface)) e.push("surface is required");
  else for (const k of SURFACE_KEYS) if (!isStr(surface[k])) e.push(`surface.${k} is required`);

  // fonts — must be whitelisted (ADR-0023: curated bundled set)
  const fonts = raw.fonts;
  if (!isObj(fonts)) e.push("fonts is required");
  else {
    for (const k of ["display", "body", "mono"] as const) {
      if (!isStr(fonts[k])) e.push(`fonts.${k} is required`);
      else if (!ALL_FONTS.has(fonts[k] as string)) e.push(`fonts.${k} "${fonts[k]}" is not in the font whitelist`);
    }
    // hud is OPTIONAL — the fourth bucket (badges/chips/meta). Absent means the consumers
    // keep their existing fallback, so a theme written before the bucket existed stays valid.
    if (fonts.hud !== undefined) {
      if (!isStr(fonts.hud)) e.push("fonts.hud must be a non-empty string when present");
      else if (!ALL_FONTS.has(fonts.hud)) e.push(`fonts.hud "${fonts.hud}" is not in the font whitelist`);
    }
  }

  // glass required iff material glass
  if (raw.material === "glass") {
    const glass = raw.glass;
    if (!isObj(glass)) e.push('glass config is required when material is "glass"');
    else for (const k of GLASS_KEYS) if (!isStr(glass[k])) e.push(`glass.${k} is required`);
  }

  // optional preview — a ref string, validated only as a non-empty string. The file's
  // existence cannot be checked here (it may be a theme-folder file on the user's disk),
  // and a missing preview is a defined, non-fatal state: the Style tab falls back.
  if (raw.preview !== undefined && !isStr(raw.preview)) e.push("preview must be a non-empty string when present");

  // optional defaultTextSize
  if (raw.defaultTextSize !== undefined && !TEXT_SIZES.includes(raw.defaultTextSize as TextSize))
    e.push(`defaultTextSize must be one of ${TEXT_SIZES.join("/")}`);

  if (e.length) return { ok: false, errors: e };
  return { ok: true, theme: { ...(raw as unknown as CanvasTheme), origin: "user" } };
}
