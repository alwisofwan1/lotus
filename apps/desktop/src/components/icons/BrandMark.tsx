"use client";

import type { ReactNode, SVGProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The Lotus brand mark (2026 rebrand). The new identity ships as raster marks —
 * `public/mark-light.png` / `public/mark-dark.png` — so the correct variant is chosen
 * from the active theme type rather than painted with CSS variables the way the old
 * `LotusFlowerIcon` SVG was.
 *
 * Both variants are rendered and CSS shows the one matching `html[data-theme-type]` (see
 * [[BrandWordmark]] for why: a `src` picked from the theme context broke hydration in Light).
 *
 * Sized purely by the caller's `className` / `style` (matching how the previous inline
 * SVG was sized), so call sites change only their import. Typed as `SVGProps` so this
 * component stays assignable to `SvgIconComponent`; only `className` / `style` are read —
 * the SVG-only attributes in the type are intentionally ignored, not spread onto `<img>`.
 */
export function BrandMark({ className, style }: SVGProps<SVGSVGElement>): ReactNode {
  return (
    <>
      <img src="/mark-dark.png" alt="Lotus" data-brand-variant="dark" className={cn("brand-mark", className)} style={style} />
      <img src="/mark-light.png" alt="Lotus" data-brand-variant="light" className={cn("brand-mark", className)} style={style} />
    </>
  );
}
