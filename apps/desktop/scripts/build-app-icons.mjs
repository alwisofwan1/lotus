#!/usr/bin/env node
/**
 * Rebuilds the native app icon set from the brand mockup.
 *
 * Why this script exists
 * ----------------------
 * `brand/app-icons/lotus-desktop-icon-*.png` is a *presentation render*, not an icon
 * master: the tile carries a baked soft drop shadow, and the tile itself is 811x791 — not square.
 * Feeding it (or a naive alpha-threshold crop of it) to `tauri icon` produces an icon whose alpha
 * bounding box is mostly shadow, so every platform scales the shadow to fit and the actual tile
 * lands ~13% smaller than a normal app icon, ringed by the leftover shadow edge.
 *
 * So we derive two real masters here instead:
 *
 *   icon-macos.png   1024x1024 canvas, tile inset to 824x824 centred  (Apple's macOS icon grid —
 *                    every system icon sits on this grid, which is what makes Dock icons line up)
 *   icon-square.png  1024x1024 full-bleed tile                        (Windows/Linux draw the
 *                    bitmap as-is and add no inset of their own, so padding here = a small icon)
 *
 * Both are re-masked with a superellipse — the shape family macOS/iOS actually use, where the
 * mockup's corners are a plain circular arc. See SUPERELLIPSE_N for the exponent and why. The baked
 * shadow is dropped entirely; macOS, Windows and Linux all draw their own.
 *
 * Usage:  bun run icons:build      (from apps/desktop)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// sharp is not a declared dependency — it arrives as Next's optional native dep, which is enough
// for an asset script that runs by hand. If Next ever drops it, `bun add -d sharp` here.
const sharp = await import("sharp")
  .then((m) => m.default)
  .catch(() => {
    console.error("sharp is not installed — run `bun add -d sharp` in apps/desktop");
    process.exit(1);
  });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..");
const REPO = path.resolve(DESKTOP, "../..");

const SOURCE = path.join(REPO, "brand/app-icons/lotus-desktop-icon-light.png");
const ICONS = path.join(DESKTOP, "src-tauri/icons");
const MASTERS = path.join(ICONS, "source");

/** Canvas the masters are authored at. */
const CANVAS = 1024;
/** Apple's macOS icon grid: an 824x824 body centred on a 1024x1024 canvas. */
const MACOS_BODY = 824;
/**
 * Superellipse exponent — lower is rounder.
 *
 * Measured against the 1024px layer of real system icons (Notes, Reminders, Maps, App Store,
 * Podcasts): macOS itself sits at n≈5.4, and the brand mockup's own tile at n≈4.9. 4.2 is a
 * deliberate notch rounder than both, which is where this icon reads best next to the third-party
 * icons in the Dock — most of those use a plain circular radius and are rounder than Apple's shape.
 * Override with `--corner <n>` if it ever needs re-tuning.
 */
const SUPERELLIPSE_N = Number(argValue("--corner") ?? 4.2);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
}
/** Sub-samples per axis when rasterising the mask edge. */
const AA = 4;

/* ------------------------------------------------------------------ tile extraction */

/**
 * Isolates the tile from the mockup: opaque *and* light. The drop shadow is dark and partially
 * transparent, so both tests are needed — alpha alone keeps the shadow's opaque core.
 */
function tileMask(data, width, height) {
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const [r, g, b, a] = [data[p], data[p + 1], data[p + 2], data[p + 3]];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    mask[i] = a >= 250 && luma >= 185 ? 1 : 0;
  }
  return mask;
}

function maskBounds(mask, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error("no tile found in source — the light/alpha thresholds need a look");
  return { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * Crops the largest square centred on the tile and bleeds the tile's own colours outward into the
 * corner gaps. The new squircle mask is squarer than the mockup's corners, so it reaches into area
 * the tile never covered; without the bleed that area would expose shadow grey along the corners.
 * Row-wise extension is exact for the near-vertical gradient this tile uses.
 */
function cropSquareAndBleed(data, width, height, mask, bounds) {
  const side = Math.min(bounds.width, bounds.height);
  const cx = (bounds.x0 + bounds.x1) / 2;
  const cy = (bounds.y0 + bounds.y1) / 2;
  const left = Math.round(cx - side / 2);
  const top = Math.round(cy - side / 2);

  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) {
    const sy = top + y;
    let first = -1;
    let last = -1;
    for (let x = 0; x < side; x++) {
      if (mask[sy * width + (left + x)]) {
        if (first < 0) first = x;
        last = x;
      }
    }
    // A row can miss the tile entirely only if the crop overshoots; clamp to the nearest tile row.
    if (first < 0) {
      const fallback = sy < bounds.y0 ? bounds.y0 : bounds.y1;
      for (let x = 0; x < side; x++) {
        if (mask[fallback * width + (left + x)]) {
          if (first < 0) first = x;
          last = x;
        }
      }
    }
    for (let x = 0; x < side; x++) {
      const clamped = Math.min(Math.max(x, first), last);
      const sp = (sy * width + (left + clamped)) * 4;
      const dp = (y * side + x) * 4;
      out[dp] = data[sp];
      out[dp + 1] = data[sp + 1];
      out[dp + 2] = data[sp + 2];
      out[dp + 3] = 255;
    }
  }
  return { buffer: out, side };
}

/* ------------------------------------------------------------------ squircle mask */

/** Coverage map of |x|^n + |y|^n <= 1, super-sampled AAxAA, one quadrant mirrored four ways. */
function squircleAlpha(size) {
  const alpha = Buffer.alloc(size * size);
  const half = size / 2;
  const step = 1 / AA;
  const quadrant = Math.ceil(half);
  for (let y = 0; y < quadrant; y++) {
    for (let x = 0; x < quadrant; x++) {
      let hits = 0;
      for (let sy = 0; sy < AA; sy++) {
        const v = Math.abs((y + (sy + 0.5) * step - half) / half);
        const vn = Math.pow(v, SUPERELLIPSE_N);
        if (vn > 1) continue;
        for (let sx = 0; sx < AA; sx++) {
          const u = Math.abs((x + (sx + 0.5) * step - half) / half);
          if (Math.pow(u, SUPERELLIPSE_N) + vn <= 1) hits++;
        }
      }
      const value = Math.round((hits / (AA * AA)) * 255);
      const xm = size - 1 - x;
      const ym = size - 1 - y;
      alpha[y * size + x] = value;
      alpha[y * size + xm] = value;
      alpha[ym * size + x] = value;
      alpha[ym * size + xm] = value;
    }
  }
  return alpha;
}

/* ------------------------------------------------------------------ masters */

async function buildBody(crop, size) {
  const resized = await sharp(crop.buffer, {
    raw: { width: crop.side, height: crop.side, channels: 4 },
  })
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer();

  const alpha = squircleAlpha(size);
  for (let i = 0; i < size * size; i++) resized[i * 4 + 3] = alpha[i];

  return sharp(resized, { raw: { width: size, height: size, channels: 4 } }).png();
}

async function main() {
  if (!existsSync(SOURCE)) throw new Error(`brand source missing: ${SOURCE}`);
  mkdirSync(MASTERS, { recursive: true });

  const { data, info } = await sharp(SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = tileMask(data, info.width, info.height);
  const bounds = maskBounds(mask, info.width, info.height);
  console.log(`source tile: ${bounds.width}x${bounds.height} at (${bounds.x0},${bounds.y0})`);

  const crop = cropSquareAndBleed(data, info.width, info.height, mask, bounds);

  const squarePath = path.join(MASTERS, "icon-square.png");
  await (await buildBody(crop, CANVAS)).toFile(squarePath);

  const macosPath = path.join(MASTERS, "icon-macos.png");
  const body = await (await buildBody(crop, MACOS_BODY)).toBuffer();
  await sharp({
    create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: body, left: (CANVAS - MACOS_BODY) / 2, top: (CANVAS - MACOS_BODY) / 2 }])
    .png()
    .toFile(macosPath);

  console.log(`masters written to ${path.relative(DESKTOP, MASTERS)}/`);

  // `tauri icon` overwrites the whole directory, so run the macOS master into a scratch dir and
  // lift only icon.icns out of it; everything else comes from the full-bleed master.
  const scratch = mkdtempSync(path.join(tmpdir(), "lotus-icons-"));
  try {
    tauriIcon(macosPath, scratch);
    tauriIcon(squarePath, ICONS);
    copyFileSync(path.join(scratch, "icon.icns"), path.join(ICONS, "icon.icns"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log("icon.icns  <- macOS grid master (824/1024)");
  console.log("icon.ico, icon.png, Square*Logo.png <- full-bleed master");
}

function tauriIcon(input, output) {
  execFileSync("bunx", ["tauri", "icon", input, "-o", output], {
    cwd: DESKTOP,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
