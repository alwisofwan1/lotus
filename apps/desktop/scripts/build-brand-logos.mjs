#!/usr/bin/env node
/**
 * Derives the in-app wordmark from the brand mockups.
 *
 * The chrome shows the word alone, not the full lockup: the mark already identifies the app from
 * the Dock and the window's own icon, and repeating it in a 44px title bar next to three macOS
 * traffic lights just crowds the row. So the mark side of each lockup is cropped away here and
 * only "LOTUS" ships.
 *
 * Two things this handles that a plain crop would get wrong.
 *
 * 1. The mockup filenames describe the logo's own **ink**, not the theme it belongs to.
 *    `lotus-logo-horizontal-light.png` is drawn in white (measured: rgb 251,251,252) and therefore
 *    belongs on a *dark* background; `…-dark.png` is near-black (rgb 26,32,44) and belongs on a
 *    *light* one. The app's convention — set by `mark-light.png` / `mark-dark.png` — names assets
 *    after the **theme they render in**, so the two are deliberately crossed over here:
 *
 *        lotus-logo-horizontal-dark.png  (dark ink)   ->  public/wordmark-light.png
 *        lotus-logo-horizontal-light.png (white ink)  ->  public/wordmark-dark.png
 *
 * 2. Both files are cropped to the ink and scaled to one cap height, so the CSS height *is* the
 *    cap height and `align-items: center` puts the word on the same row as everything beside it.
 *    "LOTUS" is all caps with no descenders, so its bounding box and its cap box are the same
 *    thing — which is the only reason this is as simple as it looks.
 *
 * What is deliberately NOT normalised: the two mockups are separate renders, not one artwork
 * recoloured — at equal cap height the dark-ink wordmark is ~20% wider, because its tracking is
 * looser. Equalising width instead would change the *type size* between themes, which is the more
 * noticeable of the two, and nobody sees both themes at once anyway.
 *
 * Usage:  bun run logos:build      (from apps/desktop)
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sharp = await import("sharp")
  .then((m) => m.default)
  .catch(() => {
    console.error("sharp is not installed — run `bun add -d sharp` in apps/desktop");
    process.exit(1);
  });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..");
const REPO = path.resolve(DESKTOP, "../..");
const MOCKUPS = path.join(REPO, "brand/logo");
const PUBLIC = path.join(DESKTOP, "public");

/** Exported cap height — ~12x the 11px the chrome renders it at, so it stays crisp on any DPI. */
const HEIGHT = 128;
/** Alpha at or below this is margin, not ink. */
const INK = 8;

const VARIANTS = [
  { theme: "light", source: "lotus-logo-horizontal-dark.png" },
  { theme: "dark", source: "lotus-logo-horizontal-light.png" },
];

async function readRaw(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function bounds({ data, width, height }, fromX = 0, toX = width) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = fromX; x < toX; x++) {
      if (data[(y * width + x) * 4 + 3] <= INK) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error("no ink found");
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * Finds where the wordmark starts — the blank gutter between mark and word.
 *
 * Colour cannot do this: the dark-ink wordmark is a blue-leaning navy, which scores as saturated as
 * the violet mark does. The gutter, on the other hand, is the one run of fully empty columns inside
 * the lockup, and it is there in both mockups.
 */
function wordmarkStart(raw, box) {
  const empty = [];
  for (let x = box.left; x < box.left + box.width; x++) {
    let ink = false;
    for (let y = box.top; y < box.top + box.height && !ink; y++) {
      if (raw.data[(y * raw.width + x) * 4 + 3] > INK) ink = true;
    }
    empty.push(!ink);
  }
  const minRun = Math.max(2, Math.round(box.width * 0.01));
  let run = 0;
  for (let i = Math.round(box.width * 0.1); i < box.width; i++) {
    run = empty[i] ? run + 1 : 0;
    if (run >= minRun && !empty[i + 1]) return box.left + i + 1;
  }
  throw new Error("no gutter between mark and wordmark");
}

async function main() {
  for (const variant of VARIANTS) {
    const file = path.join(MOCKUPS, variant.source);
    if (!existsSync(file)) throw new Error(`brand source missing: ${file}`);

    const raw = await readRaw(file);
    const word = bounds(raw, wordmarkStart(raw, bounds(raw)), raw.width);
    const width = Math.round(word.width * (HEIGHT / word.height));

    const out = path.join(PUBLIC, `wordmark-${variant.theme}.png`);
    await sharp(file)
      .extract(word)
      .resize(width, HEIGHT, { kernel: sharp.kernel.lanczos3 })
      .png()
      .toFile(out);

    console.log(
      `${variant.source}: wordmark ${word.width}x${word.height}` +
        ` -> public/wordmark-${variant.theme}.png  ${width}x${HEIGHT}`,
    );
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
