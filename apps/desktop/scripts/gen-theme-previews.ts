/**
 * Theme preview generator (ADR-0023, Style tab revamp).
 *
 * Emits one 16:9 HTML tile per built-in theme that renders the theme's REAL look —
 * the actual paper (photo/video-poster or gradient), the actual glass/solid node
 * material, the actual palette on the wires and chips. Screenshotted by a browser and encoded to webp, those become the
 * `preview` assets the Style tab shows.
 *
 * Why render rather than crop the wallpaper: three built-ins have no wallpaper at
 * all (their paper IS a CSS gradient), and for the three that do, the wallpaper
 * alone says nothing about the material — which is half of what a theme changes.
 * One pipeline for all six keeps the six cards comparable.
 *
 * The theme NAME is deliberately not drawn into the bitmap — the Style tab renders it
 * as live text in the theme's display font, which stays sharp at any card size and
 * means renaming a theme does not invalidate its asset.
 *
 * RE-RUN THIS when a built-in's paper, palette or glass change; the assets
 * are committed, so a stale one is invisible at runtime.
 *
 *   bun scripts/gen-theme-previews.ts            # writes HTML tiles into a temp dir
 *   (screenshot each at 1280x720, then: cwebp -q 76 -resize 1280 720)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_THEMES } from "../src/modules/codecanvas/services/theme/builtin-themes";
import type { CanvasTheme } from "../src/modules/codecanvas/types/canvas-theme";

const OUT = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/__theme-prev");

/**
 * A web-absolute bundled ref (`/assets/...`) passed straight through. The tiles are
 * written INTO public/ and served over http, because Chromium blocks the file:
 * protocol under automation — so the ref the app uses is the ref the tile uses.
 */
function mediaUrl(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (!ref.startsWith("/")) return undefined; // theme-folder refs aren't bundled
  return ref;
}

/** The still image for a paper: the image itself, or a video's poster. */
function paperStill(theme: CanvasTheme): string | undefined {
  const m = theme.paper.media;
  if (!m) return undefined;
  return mediaUrl(m.kind === "video" ? m.poster : m.src);
}

/** Node surface for the tile's chips — the theme's material, not a generic card. */
function chipSurface(theme: CanvasTheme): string {
  const g = theme.glass;
  if (theme.material === "glass" && g) {
    return `background:${g.bg};backdrop-filter:${g.filter};-webkit-backdrop-filter:${g.filter};border:1px solid ${g.border};box-shadow:${g.shadow},${g.inset};`;
  }
  return `background:${theme.surface.base};border:1px solid ${theme.surface.borderStrong};box-shadow:0 10px 30px rgba(0,0,0,0.34);`;
}

function dotsLayer(theme: CanvasTheme): string {
  if (theme.paper.pattern !== "dots") return "";
  return `<div style="position:absolute;inset:0;background-image:radial-gradient(${theme.surface.text} 1px,transparent 1px);background-size:26px 26px;opacity:0.09"></div>`;
}

/** A mini node: header strip + a few content bars, tinted by one palette role. */
function chip(theme: CanvasTheme, opts: { x: number; y: number; w: number; h: number; role: string; bars: number[] }) {
  const { x, y, w, h, role, bars } = opts;
  const head = theme.material === "glass" && theme.glass ? theme.glass.headerGrad : "transparent";
  const rows = bars
    .map(
      (pct, i) =>
        `<div style="height:9px;width:${pct}%;border-radius:5px;background:${
          i === 0 ? role : theme.surface.textMuted
        };opacity:${i === 0 ? 0.9 : 0.42}"></div>`,
    )
    .join("");
  return `
  <div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:18px;overflow:hidden;${chipSurface(theme)}">
    <div style="height:38px;background:${head};display:flex;align-items:center;gap:9px;padding:0 16px;border-bottom:1px solid ${theme.surface.border}">
      <span style="width:9px;height:9px;border-radius:50%;background:${role}"></span>
      <span style="height:8px;width:44%;border-radius:4px;background:${theme.surface.text};opacity:0.5"></span>
    </div>
    <div style="padding:16px;display:flex;flex-direction:column;gap:11px">${rows}</div>
  </div>`;
}

function tileHtml(theme: CanvasTheme): string {
  const still = paperStill(theme);
  const p = theme.palette;
  const paper = still
    ? `<img src="${still}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:${theme.paper.media?.fit ?? "cover"}">`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com">
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Space+Grotesk:wght@600&family=Fraunces:wght@600&family=Gloria+Hallelujah&display=swap" rel="stylesheet">
<style>
  html,body{margin:0;padding:0;width:1280px;height:720px;overflow:hidden}
</style></head>
<body><div style="position:relative;width:1280px;height:720px;background:${theme.paper.fill}">
  ${paper}
  ${dotsLayer(theme)}
  <svg width="1280" height="720" style="position:absolute;inset:0" aria-hidden="true">
    <path d="M 470 300 C 590 300 600 470 730 470" fill="none" stroke="${p.accent}" stroke-width="4" stroke-linecap="round" opacity="0.85"/>
    <path d="M 470 340 C 620 340 700 190 850 190" fill="none" stroke="${p.accent}" stroke-width="3" stroke-linecap="round" opacity="0.4"/>
    <circle cx="730" cy="470" r="7" fill="${p.accent}"/>
  </svg>
  ${chip(theme, { x: 128, y: 232, w: 392, h: 236, role: p.agent, bars: [72, 92, 60] })}
  ${chip(theme, { x: 742, y: 372, w: 372, h: 226, role: p.info, bars: [64, 86, 48] })}
</div></body></html>`;
}

mkdirSync(OUT, { recursive: true });
for (const theme of BUILTIN_THEMES) {
  const file = path.join(OUT, `${theme.id}.html`);
  writeFileSync(file, tileHtml(theme));
  console.log(file);
}
