"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * "LOTUS" set in the brand's own letterforms — the wordmark half of the horizontal lockup, with
 * the mark cropped away. [[BrandMark]] is the other half, for anywhere the mark stands alone.
 *
 * Raster, like the mark. Both variants are rendered and CSS shows the one matching
 * `html[data-theme-type]` (globals.css, `[data-brand-variant]`). Picking the `src` from the theme
 * context instead broke hydration: the server renders the default (Dark) theme while the client's
 * first render already reads the stored one, so a Light user got a `src` mismatch. The attribute
 * is set by the pre-paint bootstrap, so the right variant is there on the first frame too.
 *
 * Both files are emitted by `scripts/build-brand-logos.mjs` at one cap height, so a `height` on
 * this element *is* the cap height.
 */
export function BrandWordmark({ className }: { className?: string }): ReactNode {
  return (
    <>
      <img src="/wordmark-dark.png" alt="Lotus" data-brand-variant="dark" className={cn("brand-wordmark", className)} />
      <img src="/wordmark-light.png" alt="Lotus" data-brand-variant="light" className={cn("brand-wordmark", className)} />
    </>
  );
}
