// CodeCanvas Artisan Theme Engine — built-in theme catalog.
// Built-in themes are CanvasTheme literals; the loader merges these with
// user/agent-authored themes from ~/.lotus/canvas-themes/ (Phase 3).
//
// Phase 0a ships exactly ONE built-in — "void" — whose resolved CSS exactly
// reproduces today's dark look (values lifted verbatim from styles/canvas/theme.css)
// so the eventual flip (Phase 0b) is visually neutral. Additional dark themes
// arrive in Phase 1.

import type { CanvasTheme } from "../../types/canvas-theme";

/**
 * "Void" — the current default, reborn as a full theme.
 * Surface values reproduce the *computed* dark look the canvas shows today — i.e.
 * the app's `--ds-workbench-*` values for the default dark theme (bg #050506,
 * surface from backgroundCard #161412 @0.86, raised from backgroundElevated
 * #201c18 @0.82, border subtle 0.065 / strong 0.11), NOT the stale theme.css
 * fallback literals. Glass values mirror the literals in theme.css. The cyan wire
 * accent (#67e8f9) and white chrome accent (#f5f2ef) reproduce `--canvas-wire*`
 * and `--canvas-accent`/`--canvas-focus-ring` after alpha derivation.
 * Node-role hues (agent/task/note/info) are net-new and unused until Phase 1.
 */
const VOID: CanvasTheme = {
  id: "void",
  name: "Void",
  descriptor: "deep space ink · the original",
  mode: "dark",
  material: "glass",
  paper: { fill: "#050506", pattern: "dots" },
  palette: {
    accent: "#67e8f9", // cyan — wires/selection (matches current --canvas-wire)
    agent: "#a78bfa", // violet
    task: "#5eead4", // teal
    note: "#facc15", // amber
    info: "#7dd3fc", // sky — terminal/browser
  },
  surface: {
    base: "rgba(22,20,18,0.86)", // backgroundCard #161412 @ 0.86
    raised: "rgba(32,28,24,0.82)", // backgroundElevated #201c18 @ 0.82
    border: "rgba(245,242,239,0.065)", // ui.borderSubtle
    borderStrong: "rgba(245,242,239,0.11)", // ui.border
    text: "#f7f2ea",
    textMuted: "rgba(247,242,234,0.42)",
    chromeAccent: "#f5f2ef",
  },
  glass: {
    bg: "rgba(10, 9, 18, 0.58)",
    filter: "blur(20px) saturate(1.3) brightness(1.06)",
    border: "rgba(255, 255, 255, 0.09)",
    shadow: "0 8px 28px rgba(0, 0, 0, 0.44), 0 2px 6px rgba(0, 0, 0, 0.26)",
    inset: "inset 0 1px 0 rgba(255, 255, 255, 0.09), inset 1px 0 0 rgba(255, 255, 255, 0.03)",
    headerGrad: "linear-gradient(180deg, rgba(255,255,255,0.058) 0%, rgba(255,255,255,0.012) 100%)",
    panelBg: "rgba(8, 7, 15, 0.72)",
    panelFilter: "blur(18px) saturate(1.24) brightness(1.02)",
  },
  preview: "/assets/theme-preview/void.webp",
  fonts: { display: "Caveat", body: "Inter", mono: "JetBrains Mono" },
  schemaVersion: 1,
  origin: "builtin",
};

/**
 * "Midnight" — the second built-in, and the first to exercise a non-glass
 * material. Deep-indigo paper, flat ("solid") node surfaces (no backdrop blur),
 * cool periwinkle/sky palette. Distinct enough from Void to prove live switching
 * end-to-end (paper + surface + material all change).
 */
const MIDNIGHT: CanvasTheme = {
  id: "midnight",
  name: "Midnight",
  descriptor: "still indigo · lamplight",
  mode: "dark",
  material: "solid",
  paper: {
    fill: "radial-gradient(ellipse at 50% 0%, #0b1220 0%, #070a14 58%, #05060d 100%)",
    pattern: "dots",
  },
  palette: {
    accent: "#7cc7ff", // sky — wires/selection
    agent: "#8b9cff", // periwinkle
    task: "#5eead4", // teal
    note: "#fcd34d", // amber
    info: "#a5b4fc", // indigo — terminal/browser
  },
  surface: {
    base: "#121a2b", // solid (material=solid consumes this as the node bg)
    raised: "#18233a",
    border: "rgba(180,200,255,0.12)",
    borderStrong: "rgba(180,200,255,0.20)",
    text: "#e8eefc",
    textMuted: "rgba(232,238,252,0.5)",
    chromeAccent: "#cdd9f5",
  },
  preview: "/assets/theme-preview/midnight.webp",
  fonts: { display: "Caveat", body: "Inter", mono: "JetBrains Mono" },
  schemaVersion: 1,
  origin: "builtin",
};

/**
 * "Cobalt" — the grain material: deep cobalt water with a coral accent and a fine
 * film-grain wash over the canvas (CNVS "deep water · coral light"). Solid node
 * surfaces; the grain lives on the backdrop (see data-canvas-material="grain" CSS).
 */
const COBALT: CanvasTheme = {
  id: "cobalt",
  name: "Cobalt",
  descriptor: "deep water · coral light",
  mode: "dark",
  material: "grain",
  paper: {
    fill: "radial-gradient(ellipse at 55% 18%, #1a3a6b 0%, #0d2147 40%, #071328 74%, #040a18 100%)",
    pattern: "none",
  },
  palette: {
    accent: "#ff7e6b", // coral — wires/selection pop on navy
    agent: "#7cc7ff", // sky
    task: "#5eead4", // teal
    note: "#ffd27a", // warm sand
    info: "#8bb4ff", // cornflower
  },
  surface: {
    base: "rgba(16,32,60,0.88)",
    raised: "rgba(22,42,74,0.92)",
    border: "rgba(150,190,255,0.14)",
    borderStrong: "rgba(150,190,255,0.24)",
    text: "#eaf1ff",
    textMuted: "rgba(234,241,255,0.52)",
    chromeAccent: "#dfe9ff",
  },
  preview: "/assets/theme-preview/cobalt.webp",
  fonts: { display: "Caveat", body: "Inter", mono: "JetBrains Mono" },
  schemaVersion: 1,
  origin: "builtin",
};

/**
 * "Lakeside" — a Mediterranean lake village at golden-hour sunset, shipped as a
 * bundled wallpaper (`/assets/background/nature-dark.webp`). Glass node panels float
 * over the warm dusk photo (CNVS-style); the palette is sampled from the scene —
 * coral-gold sun, twilight violet hills, teal water, golden window light.
 */
const LAKESIDE: CanvasTheme = {
  id: "lakeside",
  name: "Lakeside",
  descriptor: "mediterranean sunset · still water",
  mode: "dark",
  material: "glass",
  paper: {
    fill: "linear-gradient(180deg, #3a2238 0%, #221426 55%, #120a16 100%)",
    pattern: "none",
    media: { kind: "image", src: "/assets/background/nature-dark.webp", fit: "cover" },
    // Largest colour cluster of the photograph (k-means, 96×54 sample): warm dusk earth, 27%
    // of the image. The fill calls the scene plum; the photo is more grounded than that, and
    // the terminal floor follows the photo. Already below the luminance ceiling, so it is used
    // as-is. See CanvasPaper.sampled.
    sampled: "rgb(26, 21, 13)",
  },
  palette: {
    accent: "#ff9e57", // sunset coral-gold — wires/selection
    agent: "#c98bff", // twilight violet (hills/clouds)
    task: "#7fd1c4", // lake teal
    note: "#ffd27a", // golden window light
    info: "#8fb8ff", // dusk blue — terminal/browser
  },
  surface: {
    base: "rgba(20,14,22,0.52)",
    raised: "rgba(28,18,26,0.58)",
    border: "rgba(255,220,200,0.16)",
    borderStrong: "rgba(255,220,200,0.26)",
    text: "#fbf2ea",
    textMuted: "rgba(251,242,234,0.56)",
    chromeAccent: "#ffd9b0",
  },
  glass: {
    bg: "rgba(16,10,18,0.40)",
    filter: "blur(22px) saturate(1.35) brightness(1.06)",
    border: "rgba(255,210,180,0.16)",
    shadow: "0 8px 30px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.3)",
    inset: "inset 0 1px 0 rgba(255,225,200,0.12), inset 1px 0 0 rgba(255,225,200,0.05)",
    headerGrad: "linear-gradient(180deg, rgba(255,210,170,0.07) 0%, rgba(255,210,170,0.014) 100%)",
    panelBg: "rgba(12,8,14,0.6)",
    panelFilter: "blur(20px) saturate(1.3) brightness(1.03)",
  },
  preview: "/assets/theme-preview/lakeside.webp",
  fonts: { display: "Caveat", body: "Inter", mono: "JetBrains Mono" },
  schemaVersion: 1,
  origin: "builtin",
};

/**
 * "Lakeside Day" — the daytime counterpart to Lakeside: the same Mediterranean
 * lake village under a vivid blue noon sky (bundled `nature-light.webp`). Dark
 * glass panels float over the bright photo for legibility (true light mode is
 * Phase 4); palette sampled from the scene — lake turquoise, sky blue, leaf green.
 */
const LAKESIDE_DAY: CanvasTheme = {
  id: "lakeside-day",
  name: "Lakeside Day",
  descriptor: "blue water · summer noon",
  mode: "dark",
  material: "glass",
  paper: {
    fill: "linear-gradient(180deg, #2a6fb0 0%, #1b4e7e 55%, #0e3050 100%)",
    pattern: "none",
    media: { kind: "image", src: "/assets/background/nature-light.webp", fit: "cover" },
    // Largest colour cluster of the photograph: deep forest green, 23% of the image — and 46%
    // of the whole frame is green pixels. The fill above is pure blue (sky and deep water),
    // which is emphatically NOT this scene's dominant character; a floor derived from it read
    // as a navy hole punched through foliage. See CanvasPaper.sampled.
    sampled: "rgb(27, 54, 23)",
  },
  palette: {
    accent: "#17b6cf", // lake turquoise — wires/selection
    agent: "#4aa3ff", // sky blue
    task: "#5fb96a", // leaf green
    note: "#f0c24a", // sunlit daisy
    info: "#2fa3a0", // deep teal water — terminal/browser
  },
  surface: {
    base: "rgba(10,20,28,0.56)",
    raised: "rgba(14,26,36,0.62)",
    border: "rgba(200,235,255,0.16)",
    borderStrong: "rgba(200,235,255,0.26)",
    text: "#eef6fb",
    textMuted: "rgba(238,246,251,0.58)",
    chromeAccent: "#d6eefb",
  },
  glass: {
    bg: "rgba(8,16,24,0.46)",
    filter: "blur(22px) saturate(1.3) brightness(1.04)",
    border: "rgba(190,225,255,0.16)",
    shadow: "0 8px 30px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.28)",
    inset: "inset 0 1px 0 rgba(210,235,255,0.12), inset 1px 0 0 rgba(210,235,255,0.05)",
    headerGrad: "linear-gradient(180deg, rgba(200,230,255,0.07) 0%, rgba(200,230,255,0.014) 100%)",
    panelBg: "rgba(6,12,18,0.62)",
    panelFilter: "blur(20px) saturate(1.26) brightness(1.02)",
  },
  preview: "/assets/theme-preview/lakeside-day.webp",
  fonts: { display: "Caveat", body: "Inter", mono: "JetBrains Mono" },
  schemaVersion: 1,
  origin: "builtin",
};

/**
 * "Garden of Dawn" — a sakura over a still lake at first light, and the only light built-in.
 * Everything below was measured off the asset (384x216 sample; k-means k=8 for the clusters,
 * OKLCH for every hue and chroma figure), not eyeballed. Three numbers govern the theme:
 *
 *   • Mean frame luma 199, with 49.7% of the frame above 204 and only 1.1% below 100. This is
 *     a PAGE, like the theme it replaces — hence `mode: "light"`.
 *   • Chroma mass is TRIMODAL. Weighted by OKLCH chroma, the frame's colour lives in three
 *     separated bands: 240-269deg dawn sky 29.3%, 30-59deg blossom and low light 24.9%,
 *     60-89deg lantern gold and grass 24.5%. Everything else together is 21.3%. So the five
 *     roles here separate by HUE, one per real mass.
 *   • Ink is scarce: 2.03% of the frame is below luma 110, and its mean is rgb(88, 97, 88) —
 *     a pine green-grey. So ink is spent on words and on the figure, and nothing else.
 *
 * This theme replaced Crimson Zen, and it is worth recording that it INVERTS that theme's two
 * governing findings rather than merely differing from them:
 *
 *   • Crimson Zen measured ZERO pixels with b > r, and its header note concluded that `info`
 *     must not be blue, because "a sky hue here is a hole punched through autumn". Here 35.7%
 *     of the frame has b > r (27.6% strongly, b - r > 12), and the 240-269deg band is the
 *     LARGEST chromatic mass in the picture. The rule does not relax, it reverses: `info` is
 *     the one role that must be the sky.
 *   • Crimson Zen separated its roles by luminance and chroma because its asset gave it no hue
 *     to separate by. This asset gives three, so the technique it needed is not needed here.
 *
 * THE ONE TECHNIQUE THAT CHANGED, AND WHY. Crimson Zen deepened each measured colour by scaling
 * all three channels by a single factor — the `darkenTo` trick — which preserves hue and
 * saturation exactly. That works when the source is chromatic; its crimson measured
 * rgb(180, 58, 53). This asset is pastel: the MAXIMUM OKLCH chroma anywhere in the frame is
 * 0.120, and the median is 0.033. Scaling those toward black preserves the hue and yields mud —
 * every role lands as a variant of the same warm grey. So each role below instead keeps its
 * MEASURED hue, holds chroma at an authored target above what the frame contains, and solves
 * lightness for the contrast bar. The hues are measured; the chroma is deliberately not.
 *
 * See plans/crimson-zen-theme/PLAN.md for the measurement method this inherits.
 */
const GARDEN_OF_DAWN: CanvasTheme = {
  id: "garden-of-dawn",
  name: "Garden of Dawn",
  descriptor: "sakura · still lake at first light",
  mode: "light",
  material: "glass",
  paper: {
    // Traces the measured row-mean profile in nine bands: cool sky at the top (rgb(164,192,219)),
    // warming through the canopy and the sunrise glow to its rgb(229,217,206) core just under
    // halfway, dropping to the rgb(195,181,156) grass bank, then cooling back to the
    // rgb(198,200,206) water at the bottom. The warm middle between two cool ends is the whole
    // picture in one gradient. Only ever seen while the image decodes.
    fill: "linear-gradient(180deg, #a4c0db 0%, #ccc9d1 11%, #ddcbc9 22%, #e5d2ca 33%, #e5d9ce 44%, #c0b6ab 56%, #c3b59c 67%, #ccc2b6 78%, #c6c8ce 100%)",
    pattern: "none",
    media: {
      // A STILL, where the theme this replaces used a video. Nothing here is animated, so
      // `poster` is not set — CanvasPaperMedia only requires it for `kind: "video"`.
      //
      // Worth stating plainly, because the previous entry in this slot shipped BROKEN: it
      // pointed at a video and a poster that had both been deleted from the working tree, so it
      // rendered as the bare gradient above. Any change to this block should be checked against
      // `ls public/assets/background/`.
      kind: "image",
      src: "/assets/background/garden-of-dawn.png",
      fit: "cover",
    },
    // Largest k-means cluster, 23.6% of the frame, luma 232 — the sunrise light on water and on
    // the pale blossom. A property of the ASSET, not of the theme: replace the wallpaper and
    // re-measure, or the terminal floor drifts away from the scene it exists to belong to.
    //
    // It sits at roughly the frame's p90, which is where Crimson Zen's own sampled colour sat,
    // and it clears LIGHT_LUMA_FLOOR (225) on its own, so resolveTerminalFloor's light branch
    // lifts it by nothing and the floor IS this colour.
    sampled: "rgb(247, 230, 214)",
  },
  palette: {
    // One role per measured hue. Every one clears WCAG AA (4.5:1) against the resolved terminal
    // floor rgb(247,230,214) — the worst ground in the theme, since the glass panel over it
    // resolves to rgb(252,244,234) and scores ~12% higher throughout.
    //
    // Note what these five have in common: except for `agent`, they all land within 0.02 of
    // OKLCH L 0.52, because they were each solved for the same contrast bar. They are told
    // apart by HUE alone. That is the exact inverse of Crimson Zen, whose five shared a hue
    // family and were told apart by luminance.
    accent: "#b5414d", // sakura rose, 4.50:1 — wires, selection, caret. h18 C0.150.
    // The petals' hue spans p05 8deg to p95 60deg with a median of 36; this takes the PINKEST
    // quartile (25.7% of petal pixels sit below h25) rather than the median, because the median
    // is a peach that collides with `note`. The picture's subject earns the signature.
    agent: "#2c4631", // pine ink, 8.51:1 — h150 C0.048. The mean of the 2.03% of the frame
    // below luma 110 is rgb(88,97,88), the pines and the wet rock. Ink is what is scarce here,
    // and the agent is the figure. Deliberately far darker than the other four: this is the
    // only role also asked to behave like ink, and it shares its hue with `surface.text`.
    task: "#626976", // mist stone, 4.54:1 — h262 C0.022. Near-neutral by design. It carries the
    // sky's hue at a seventh of `info`'s chroma, so the two never compete: this is the one place
    // the theme still separates by chroma rather than by hue, and it is the Crimson Zen trick
    // reused for the one role that should recede.
    note: "#915e17", // lantern gold, 4.52:1 — h70 C0.105, the 60-89deg band. The lanterns are
    // the only literal light sources in the frame, which is the right register for a note.
    info: "#306ca2", // dawn sky, 4.55:1 — h248 C0.105, the 240-269deg band and the largest
    // chromatic mass in the picture. BLUE, and see the header note for why that is the point.
  },
  surface: {
    base: "rgba(253,247,238,0.82)",
    raised: "rgba(255,251,245,0.88)",
    // Pine ink at low alpha, never black: a neutral-black hairline on warm paper reads as dirt.
    // 0.20 is inherited from Crimson Zen, where the mockup showed 0.13 leaving a near-white
    // panel on near-white paper detectable only by its shadow. The same holds here — this floor
    // is 3 luma points brighter than that one, so if anything the case is stronger.
    border: "rgba(31,39,32,0.20)",
    borderStrong: "rgba(31,39,32,0.32)",
    text: "#1f2720", // pine ink, 12.59:1 on the floor. Same hue as palette.agent at a seventh
    // the lightness — the figure and the words are the same ink, which is what the 2.03% says.
    // OPAQUE, like every other photo theme's and for the same reason: an alpha muted has no
    // fixed contrast over a photographic backdrop. 5.21:1 on the floor, 5.82:1 on the glass.
    textMuted: "#556357",
    // Chrome accent must be DARK on a light theme — every other built-in puts a near-white here
    // and it would be invisible, and this token is what paints the settings rail, the active
    // segmented pill, every ON toggle and the scrollbar.
    //
    // LACQUER, not dusty rose. The first value here was #953544, which measured OKLCH C0.129 —
    // the same lightness as this one and 24% less chroma. Stacked down a settings pane it read
    // muddy: a lot of desaturated maroon blocks. Chroma is the whole difference between "old
    // paint" and "urushi", so this holds L and hue and spends the change entirely on chroma
    // (h18, C0.160). Contrast is unmoved at 6.01:1 on the floor and 7.32:1 against the white
    // ink it carries, so the deepening is free — it buys richness, not legibility.
    //
    // C0.185 was also solved and rejected: at this lightness it crosses into a magenta-crimson
    // that reads synthetic next to a hand-painted dawn.
    chromeAccent: "#a22638",
  },
  glass: {
    bg: "rgba(253,247,238,0.82)",
    // saturate stays near 1.00, where every dark built-in runs 1.3. On a bright backdrop a high
    // saturate does not add richness, it tints the panels — pink over the canopy, blue over the
    // water. 1.08 is a touch above Crimson Zen's 1.06 because this asset is paler.
    filter: "blur(20px) saturate(1.08) brightness(1.02)",
    // ── GILT EDGE ──
    // The one token that diverges from `surface.border` above, and deliberately. This is
    // `--node-glass-border`, which node-shell.css paints as the 1px edge of EVERY node — agent,
    // terminal, note, browser, task. `surface.border` stays pine ink because it is the hairline
    // inside dense chrome (settings cards, panel separators), where a metallic line would be
    // noise rather than jewellery.
    //
    // Sourced from the lanterns, which are the only literal light sources in the frame and
    // already give this theme its `note` role. As a 1px edge, though, the palette gold (#915e17)
    // is wrong: at 20% alpha it composites to a tan smudge. A gilt line has to be lighter and
    // more chromatic than the ink it replaces AND carry enough alpha to read as metal —
    // rgba(168,124,51,0.66) composites over the glass panel to #c5a571, which measures 2.14:1
    // against that panel where the old ink edge measured 1.48:1.
    //
    // Against the WALLPAPER on its outer side it measures 1.24-1.40:1 (sky/canopy/water) — quiet
    // on purpose. Gilding frames the panel it belongs to; it should not fight the scene behind.
    border: "rgba(168,124,51,0.66)",
    // COOL shadow, and this is the one place this theme departs from Crimson Zen's reasoning
    // rather than inverting its data. That theme argued a black shadow on rice paper looks like
    // a smudge and used a warm brown. The argument holds; the colour does not. In THIS frame the
    // shadows are the blue end — the sky, the water, the mountain haze — so a warm shadow would
    // be the only light in the picture coming from the wrong place. Sampled from the mountain
    // shade, rgb(58,74,104).
    shadow: "0 10px 30px rgba(58,74,104,0.20), 0 2px 6px rgba(58,74,104,0.12)",
    // Champagne rather than pure white, which is what makes the gilt edge read as METAL instead
    // of as a yellow line: a real gilded edge catches a warm highlight just inside it, so the
    // eye gets two tones a pixel apart. Pure white here left the gold looking printed on.
    inset: "inset 0 1px 0 rgba(255,246,224,0.82), inset 1px 0 0 rgba(255,246,224,0.40)",
    // INVERTED against every dark built-in: a light theme's header is slightly DARKER than its
    // body, because the light is coming from in front of the page instead of from behind it.
    headerGrad: "linear-gradient(180deg, rgba(31,39,32,0.075) 0%, rgba(31,39,32,0.02) 100%)",
    panelBg: "rgba(254,249,242,0.90)",
    panelFilter: "blur(18px) saturate(1.06) brightness(1.01)",
  },
  preview: "/assets/theme-preview/garden-of-dawn.webp",
  fonts: {
    // Unchanged from the theme this replaced, and re-argued rather than inherited. Fraunces is
    // the only face in the display bucket with brush-like stroke contrast, and its softness
    // suits a dawn scene at least as well as it suited a maple in mist; Caveat and Gloria
    // Hallelujah are Western felt-tip and Space Grotesk is geometric and cold. Newsreader is a
    // screen-first text serif that belongs on paper in a way Inter and IBM Plex Sans do not.
    // IBM Plex Mono is humanist and slightly warm: softer terminals than JetBrains Mono's
    // engineering grotesk. All three are already bundled; see layout.tsx.
    display: "Fraunces",
    body: "Newsreader",
    mono: "IBM Plex Mono",
    // `hud` is OMITTED, deliberately. Both whitelisted HUD faces are pixel faces, and
    // canvas-theme.ts already says a pixel face at heading size is a costume — over a painted
    // landscape it is a costume at any size. Omitting the key means every consumer keeps its
    // existing `var(--canvas-font-hud, …)` fallback.
  },
  // "md", where the other photo theme uses "sm". Density is what a DARK photo backdrop needs —
  // less panel area covering the scene. A serif needs the opposite, and this paper is bright
  // enough that a panel does not read as a hole punched in the wallpaper.
  defaultTextSize: "md",
  schemaVersion: 1,
  origin: "builtin",
};

export const BUILTIN_THEMES: readonly CanvasTheme[] = [
  VOID,
  MIDNIGHT,
  COBALT,
  LAKESIDE,
  LAKESIDE_DAY,
  GARDEN_OF_DAWN,
];

export const DEFAULT_CANVAS_THEME_ID = "void";

export function findBuiltinTheme(id: string): CanvasTheme | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}

/** The default theme, guaranteed to exist. */
export function defaultCanvasTheme(): CanvasTheme {
  return findBuiltinTheme(DEFAULT_CANVAS_THEME_ID) ?? BUILTIN_THEMES[0];
}
