# Brand assets — copies, not imports

These files are **copies**. `apps/web` imports nothing from any other package in this
repo — see `docs/adr/0011-apps-web-isolation-and-turbopack-root.md`.

The three SVG marks copied from `apps/desktop/public/` on 2026-08-23 (`lotus.svg`,
`lotus-flower.svg`, `codespace.svg`) were deleted on 2026-10-03: the new brand replaced them
and nothing referenced them. The copies below are made by hand — the duplication is
deliberate and was chosen over a cross-package build step, so nothing will warn you when the
desktop mark changes.

## New brand (2026-09-30)

| File | Made from | How |
|---|---|---|
| `lotus-logo-horizontal-light.png` | `brand/logo/lotus-logo-horizontal-light.png` | alpha-cropped to the artwork, resized to 480 px wide |
| `lotus-mark.png` | `brand/mark/lotus-mark-dark.png` | alpha-cropped, resized to 192 px wide |
| `lotus-app-icon.png` | `brand/app-icons/lotus-desktop-icon-dark.png` | alpha-cropped, resized to 256 px wide |

`*-light` in `new-brands/` means *for a dark background* (white wordmark). The site is dark,
so it uses the `-light` logo. The sources carry ~20–60 % empty padding, which is why these
are cropped rather than copied. Astro re-encodes them to WebP at build time.

## Site icons and share card (2026-09-30, LOT2-66)

Rendered into `public/` by `scripts/brand-icons.py` (Pillow). Re-run it when `new-brands/` changes.

| File | Made from | How |
|---|---|---|
| `favicon.ico` (16/32/48), `icon-32.png` | `mark/lotus-mark-dark.png` | alpha-cropped, squared, transparent |
| `apple-touch-icon.png` (180) | `mark/lotus-mark-dark.png` | mark at 62 % on an opaque gradient sampled from the tile |
| `icon-192.png`, `icon-512.png` | `app-icons/lotus-mobile-icon-dark.png` | alpha-cropped tile, squared |
| `icon-maskable-512.png` | `mark/lotus-mark-dark.png` | mark at 50 % on the full-bleed gradient (inside the 80 % safe circle) |
| `og.png` (1200×630) | `scripts/og-card.html` | headless Chrome screenshot; command in that file |

There is no `favicon.svg` any more: the new brand exists only as raster masters, and the
old SVG was the previous mark.

## Fonts (2026-09-30)

`src/assets/fonts/*.woff2` — Fontsource 5.3.0 `@fontsource-variable/{archivo,instrument-sans,jetbrains-mono}`,
latin subset, weight axis. SIL OFL 1.1; each licence sits beside its file as `*-OFL.txt`.
