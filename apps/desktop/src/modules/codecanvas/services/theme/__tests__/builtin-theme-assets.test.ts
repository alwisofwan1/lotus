import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "../builtin-themes";
import { validateCanvasThemeSpec } from "../canvas-theme-schema";
import { isLocalAssetRef } from "../canvas-theme-asset";

/**
 * Two gaps this closes, both of which the built-in catalog was exposed to and neither of
 * which any other suite covered.
 *
 * 1. `validateCanvasThemeSpec` is the gate for USER themes, so nothing ever ran the
 *    built-ins through it. They are typed, which catches a missing field but not a
 *    field-level rule — and the schema has rules the type system cannot express, e.g.
 *    "a video paper must carry a poster" and "fonts must be on the whitelist". A built-in
 *    that a user could not have authored is a bug either way round.
 *
 * 2. A theme's `paper.media` path is a plain string. Mistype it and there is no error
 *    anywhere: `isLocalAssetRef` waves web-absolute paths through as ready-to-use, the
 *    webview 404s, and the canvas just shows `paper.fill` — which looks deliberate,
 *    because on four of the built-ins a hand-drawn fill IS the intended look. So a
 *    broken wallpaper is invisible in review and invisible at runtime.
 *
 * Only web-absolute refs (`/assets/...`) are checked here. Those are bundled app assets
 * served from the webview root, so `public/` is their source of truth. Theme-folder refs
 * live under ~/.lotus/canvas-themes/ on the user's machine and cannot be asserted in CI.
 */

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../../public",
);

/** Web-absolute media ref → the file that must back it. */
function bundledAssetPath(ref: string): string {
  return path.join(PUBLIC_DIR, ref.replace(/^\//, ""));
}

describe("built-in theme catalog", () => {
  it("resolves the public/ directory it asserts against", () => {
    // Guards the ../ count above: a wrong path would make every assertion below vacuous
    // by failing for the same reason a genuinely missing asset would.
    expect(existsSync(PUBLIC_DIR), `public/ not found at ${PUBLIC_DIR}`).toBe(true);
  });

  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))(
    "%s satisfies the same schema a user-authored theme must",
    (_id, theme) => {
      // `origin` is stamped by the validator, never trusted from input, so it is dropped
      // rather than compared.
      const { origin: _origin, ...spec } = theme;
      const result = validateCanvasThemeSpec(spec);
      expect(result.ok ? [] : result.errors).toEqual([]);
    },
  );

  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))(
    "%s ships every bundled asset its paper references",
    (id, theme) => {
      const media = theme.paper.media;
      if (!media) return;

      for (const [field, ref] of [
        ["src", media.src],
        ["poster", media.poster],
      ] as const) {
        if (!ref || isLocalAssetRef(ref)) continue; // theme-folder or remote: not ours to check
        expect(
          existsSync(bundledAssetPath(ref)),
          `${id}: paper.media.${field} "${ref}" has no file at ${bundledAssetPath(ref)}`,
        ).toBe(true);
      }
    },
  );

  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))(
    "%s ships the preview still the Style tab shows",
    (id, theme) => {
      // Every BUILT-IN carries one, even though the field is optional on the type: the Style
      // tab's fill+palette fallback exists for agent-authored themes, and shipping a curated
      // theme without a still would silently demote it to that fallback — which on the photo
      // themes shows a hand-drawn gradient in place of the actual wallpaper. That is the exact
      // bug `preview` was added to fix, so it is asserted rather than hoped for.
      const ref = theme.preview;
      expect(ref, `${id}: no preview ref`).toBeTruthy();
      if (!ref || isLocalAssetRef(ref)) return;
      expect(
        existsSync(bundledAssetPath(ref)),
        `${id}: preview "${ref}" has no file at ${bundledAssetPath(ref)}`,
      ).toBe(true);
    },
  );

  it("gives every video paper a poster, so the paused and pre-decode states are covered", () => {
    // useCanvasVideoPolicy pauses the video whenever the window is hidden or the user
    // prefers reduced motion, and the poster is the ONLY thing rendered in those states.
    // The schema already requires this; asserting it here is what makes the requirement
    // apply to the curated catalog, which never passes through the schema in production.
    for (const theme of BUILTIN_THEMES) {
      if (theme.paper.media?.kind !== "video") continue;
      expect(theme.paper.media.poster, `${theme.id}: video paper without a poster`).toBeTruthy();
    }
  });
});
