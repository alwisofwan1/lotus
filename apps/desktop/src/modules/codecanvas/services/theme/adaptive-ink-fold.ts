// Adaptive Ink Fold — makes a terminal foreground colour legible on a light terminal floor
// without taking its identity away.
//
// WHY THIS EXISTS AND WHY THE XTERM PALETTE COULD NOT DO IT
// `canvas-terminal-theme.ts` solves 16 ANSI slots against a light floor, and every one of them
// clears AA. None of them was being used. A CLI agent that believes it is running on black emits
// xterm-256 CUBE indices (`38;5;n`, n >= 16), and xterm's ITheme has no say over slots 16-255 —
// they are the fixed 6x6x6 cube plus the 24-step grey ramp. Measured on Garden of Dawn's floor
// rgb(247,230,214): Claude Code's dark-theme `suggestion` rgb(177,185,249) downsamples to slot
// 153 = rgb(175,215,255), which paints at 1.23:1. That is the pale blue this module exists for.
//
// WHAT IT DOES NOT DO
// It never touches background colours. One palette serving both grounds is exactly the trap that
// ruled out xterm's `extendedAnsi`: a folded slot used as `48;5;n` paints a dark block behind
// text. Foreground only, decided by the caller.

/** Opaque sRGB triple, 0-255. */
export type Rgb = readonly [number, number, number];

/** WCAG AA for body text. The bar every folded colour is solved against. */
export const AA_CONTRAST = 4.5;

/**
 * How far below its own legibility threshold the lightest possible input is allowed to land,
 * in OKLCH L.
 *
 * This is what makes the transform a FOLD rather than a clamp, and it is load-bearing. Clamping
 * — "if too light, set to the threshold" — was solved first and collapsed slots 231, 250, 246 and
 * 244 into one identical grey, taking the agent's dim / normal / emphasis distinction with them.
 * A band preserves order: across all 240 cube slots the fold retains 225 distinct colours.
 *
 * 0.16 is wide enough to keep the grey ramp visibly stepped and narrow enough that nothing folds
 * into the near-black the body ink already occupies.
 */
const FOLD_BAND = 0.16;

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toChannel(linear: number): number {
  const v = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
}

/** WCAG 2.1 contrast ratio between two opaque colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** OKLCH is the space this works in: lightness moves, hue and chroma are left alone. */
function toOklch(rgb: Rgb): [L: number, C: number, h: number] {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function fromOklch(L: number, C: number, h: number): Rgb {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    toChannel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toChannel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toChannel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/**
 * The edges of the illegible zone around a ground, in OKLCH lightness, for one hue.
 *
 * Contrast against a ground is U-SHAPED in lightness: high at both ends, bottoming out at the
 * ground's own lightness. So the colours that clear `target` form `[0, dark] ∪ [light, 1]`, and a
 * colour that fails sits between the two. Either edge can be missing — on a mid grey ground a
 * low-chroma hue may be unable to clear the bar going one way at all.
 *
 * Solved per hue rather than taken as constants, because the answer differs a lot by hue: a
 * saturated blue carries its own darkness and clears the bar far lighter than a yellow does. A
 * single global cap would either crush the blues or leave the yellows illegible.
 */
function legibilityEdges(
  C: number,
  h: number,
  ground: Rgb,
  target: number,
): { dark?: number; light?: number } {
  const [groundL] = toOklch(ground);
  const clears = (L: number) => contrastRatio(fromOklch(L, C, h), ground) >= target;

  // Below the ground contrast falls as L rises, so this half is monotonic and bisects cleanly.
  let dark: number | undefined;
  if (clears(0)) {
    let lo = 0;
    let hi = Math.max(0, groundL);
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) / 2;
      if (clears(mid)) lo = mid;
      else hi = mid;
    }
    dark = lo;
  }

  // Above the ground it rises again, so the same bisection runs the other way round.
  let light: number | undefined;
  if (clears(1)) {
    let lo = Math.min(1, groundL);
    let hi = 1;
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) / 2;
      if (clears(mid)) hi = mid;
      else lo = mid;
    }
    light = hi;
  }

  return { dark, light };
}

/**
 * Fold a foreground colour onto `floor` so it clears `target`, keeping its hue.
 *
 * A colour that already clears the bar is returned UNCHANGED — byte for byte, same array
 * contents — so dark ink, and every colour on a dark theme, costs nothing and drifts nowhere.
 *
 * Above the threshold the mapping INVERTS: lighter input becomes darker output. On a dark ground
 * "brighter" means "louder", and on paper louder is darker, so the inversion is what carries the
 * agent's own emphasis ordering across rather than scrambling it.
 */
export function foldForeground(rgb: Rgb, ground: Rgb, target: number = AA_CONTRAST): Rgb {
  // A FAST PATH, not the passthrough guarantee — the edge check below reaches the same answer on
  // its own, as mutation testing confirms. It earns its place by cost: this runs on every
  // coloured cell of every terminal chunk, and it skips two bisections for the common case of a
  // colour that was already fine.
  if (contrastRatio(rgb, ground) >= target) return rgb;

  const [L, C, h] = toOklch(rgb);
  const { dark, light } = legibilityEdges(C, h, ground, target);
  // THE passthrough guarantee. Removing this and the fast path together is what test
  // "returns an already-legible colour untouched" catches.
  if (dark !== undefined && L <= dark) return rgb;
  if (light !== undefined && L >= light) return rgb;

  // Move the shorter way out of the ground. Where only one direction can clear the bar there is
  // no choice; where both can, the smaller move is the one that keeps most of the ink's identity,
  // and it is also the one that reads as "away from the ground".
  const downBy = dark === undefined ? Infinity : L - dark;
  const upBy = light === undefined ? Infinity : light - L;
  if (downBy === Infinity && upBy === Infinity) return rgb; // nothing on this hue can clear it
  const goDown = downBy <= upBy;
  const edge = goDown ? (dark as number) : (light as number);

  // The band, mirrored: on paper a lighter input becomes darker ink, and on a dark ground a
  // darker input becomes lighter ink. Ordering is preserved on both sides.
  //
  // `span` normalises the overshoot by the size of the illegible zone on the INPUT side — going
  // down, inputs run from the edge up to white, so `1 - edge`; going up they run from the edge
  // down to black, so `edge`. That is the honest model, and NOTHING IN THE SUITE PINS IT: using
  // `1 - edge` for both directions inflates the overshoot roughly twofold on a dark ground and
  // still clears the bar, still preserves ordering, and never clips, so every test passes. It is
  // kept because it is the correct model, not because it is defended. Do not read the ternary as
  // load-bearing — if you simplify it, no test will tell you that you were wrong.
  const span = goDown ? Math.max(1e-6, 1 - edge) : Math.max(1e-6, edge);
  const overshoot = (FOLD_BAND * Math.abs(L - edge)) / span;
  let folded = goDown ? edge - overshoot : edge + overshoot;
  let out = fromOklch(folded, C, h);

  // The band placement is solved in OKLCH but the bar is measured in WCAG luminance, and the two
  // disagree slightly at high chroma. Walk the last fraction rather than trusting the model.
  for (let i = 0; i < 300 && contrastRatio(out, ground) < target; i += 1) {
    folded += goDown ? -0.002 : 0.002;
    out = fromOklch(folded, C, h);
  }
  return out;
}

/**
 * A quieter version of `rgb` that still clears `target` on `ground`.
 *
 * WHY THIS IS NOT LEFT TO XTERM
 * xterm implements SGR 2 (dim) by halving the foreground's alpha, and halves
 * `minimumContrastRatio` for dim cells on top of that — so its dim is unconditionally about
 * twice as quiet as whatever the ground can carry. On a dark ground that is fine: the ink had
 * contrast to spare. On Garden of Dawn's floor it puts the terminal's own body ink at 2.92:1,
 * which is the composer field in the reported screenshot.
 *
 * Direction is decided by the ground, not assumed: it moves `rgb` TOWARD the ground until the
 * ratio is just met, so quiet means lighter on paper and darker on a dark strip. Hue is held,
 * like `foldForeground` — a dim comment should read as a quiet version of its colour, not grey.
 *
 * Landing just above the bar rather than comfortably above it is the point. Body ink on this
 * floor measures 12.59:1, so a 4.5:1 result is unmistakably the quieter of the two while still
 * being readable — which is exactly what dim is for.
 */
export function deEmphasise(rgb: Rgb, ground: Rgb, target: number = AA_CONTRAST): Rgb {
  const [, C, h] = toOklch(rgb);
  const [groundL] = toOklch(ground);
  // First make sure the starting point is legible at all; a fold may be needed before quietening.
  const start = toOklch(foldForeground(rgb, ground, target))[0];

  // Walk L from the legible end toward the ground and keep the last value that still clears the
  // bar. Bisection is not safe here: contrast is not monotonic across the ground's own lightness,
  // so a midpoint can land on the far side and mislead the search.
  const steps = 200;
  let best = fromOklch(start, C, h);
  for (let i = 1; i <= steps; i += 1) {
    const candidate = fromOklch(start + ((groundL - start) * i) / steps, C, h);
    if (contrastRatio(candidate, ground) < target) break;
    best = candidate;
  }
  return best;
}

/**
 * The lightness band, below the floor, that a re-grounded panel is allowed to occupy.
 *
 * Not invented: `builtin-themes.ts` paints Garden of Dawn's node header with
 * `rgba(31,39,32,0.075)` and argues the direction — on a light theme the light comes from in
 * front of the page, so a panel is SLIGHTLY darker than its body, never lighter. 0.075 ink is
 * about 0.03 OKLCH L on this floor, which is the quiet end of this band.
 *
 * The band is a band rather than a single offset so that a strong slab and a faint one do not
 * collapse into the same panel: the echo strip is deliberate emphasis and Codex's prompt block
 * is not, and that difference has to survive.
 */
const PANEL_BAND = { near: 0.025, far: 0.13 } as const;

/**
 * Below this OKLCH chroma a colour is treated as having no hue of its own.
 *
 * The distinction matters more than it looks. Preserving chroma is the right rule for a semantic
 * wash — a green diff must stay green — and it preserves NOTHING for a neutral. The first
 * version of this fold kept chroma unconditionally, so Codex's grey prompt block came back grey
 * and Pi's rgb(95,95,95) came back rgb(208,208,208): legible as regions, still foreign to a warm
 * page. A neutral has to borrow the floor's hue to belong to it.
 */
const PANEL_NEUTRAL_CHROMA = 0.02;

/**
 * How much of the floor's own chroma a re-grounded neutral panel carries.
 *
 * Full floor chroma would make the panel the same colour as the paper and only lightness would
 * separate them; none of it leaves the grey patch this exists to remove.
 *
 * Floored at just above `PANEL_NEUTRAL_CHROMA` on purpose: a panel that came out under that
 * threshold was read back as a neutral and re-grounded again, which was one half of the drift.
 */
const PANEL_WARMTH = 0.6;

/**
 * The most chroma a panel may carry. A wash on paper is tinted, not saturated.
 *
 * Used twice, and it has to be the same number in both places: as the cap when building a panel,
 * and as part of deciding whether a colour already IS one. A vivid green sits high enough in
 * OKLCH lightness to fall inside the band on lightness alone — pure green measured `depth` 0.06
 * against this floor — so without the chroma half of the test it was waved through untouched.
 */
const PANEL_CHROMA_CAP = 0.06;

/**
 * Slack on the band edges when deciding whether a colour is ALREADY a panel.
 *
 * Two rules were tried and rejected before this one. A contrast-only threshold could not see the
 * case that mattered — a neutral grey at nearly the floor's lightness measures 1.15:1 and looks
 * harmless by that number alone, which is why Codex's block was waved through. Comparing against
 * the panel we would have produced fixed that and introduced DRIFT: a panel's own chroma reads as
 * chromatic coming back in, so recomputing it landed at the shallow end of the band and the panel
 * crept toward the paper on every pass. Backgrounds are re-emitted constantly, so that is a slow
 * erasure, not a rounding detail.
 *
 * Asking whether the colour already lies in the band answers both. A neutral is never already a
 * panel on a warm floor however light it is, so it is always re-grounded.
 */
const PANEL_BAND_SLACK = 0.005;

/**
 * Above this contrast against the floor, a background is a deliberate INVERSION and is left as it
 * is rather than re-grounded.
 *
 * Not a fudge factor for one runner — a product decision, taken after seeing the re-grounded
 * result. Claude Code's prompt echo strip is the one place an agent inverts the surface to mark
 * "this is what you said", and on paper a dark bar reads as exactly that. Its
 * `userMessageBackground` rgb(55,55,55) measures 9.78:1 against Garden of Dawn's floor. Pi's
 * prompt panel rgb(95,95,95) measures 5.24:1 and is the hole this whole rule exists to remove.
 *
 * The threshold sits between the two cases there is evidence for, and it has a meaning that can
 * be applied to a case we have not seen: a TINT is re-grounded, an inverted SURFACE stays
 * inverted. The foreground fold then solves the ink for whichever ground survives, so a kept
 * strip keeps its white text — that composition is what makes the exemption a single constant
 * rather than a special case threaded through the normaliser.
 */
const INVERTED_GROUND_CONTRAST = 8;

/**
 * Re-ground a background colour onto a light floor: a panel on the paper, not a hole in it.
 *
 * WHY BACKGROUNDS NEEDED THEIR OWN RULE
 * Foregrounds were folded and backgrounds deliberately were not — that asymmetry is what keeps a
 * diff highlight from being darkened into a slab, and it was right. But it left every agent's
 * panel exactly as it was authored for a black terminal. Measured across three runners on Garden
 * of Dawn's floor: Codex's prompt block `rgb(218,218,218)`, a dead grey patch on warm paper; Pi's
 * `rgb(95,95,95)`, at 6:1 against the floor, which is not a panel but a hole.
 *
 * Lightness is compressed into a narrow band just under the floor; hue and chroma are kept, so a
 * green diff wash stays a green wash rather than becoming neutral. Ordering is kept too, so a
 * strong slab still reads stronger than a faint one.
 *
 * Foregrounds are folded against the RESULT of this, not against the original — which is what
 * makes the pair coherent: re-ground the panel first, then solve the ink for the panel it will
 * actually be painted on.
 */
export function foldBackground(rgb: Rgb, floor: Rgb): Rgb {
  // A deliberate inversion, not a panel that lost its ground. Left exactly as authored.
  if (contrastRatio(rgb, floor) >= INVERTED_GROUND_CONTRAST) return rgb;

  const [L, C, h] = toOklch(rgb);
  const [floorL, floorC, floorH] = toOklch(floor);

  // `L` runs 0 (black) up to roughly the floor's own lightness, so normalising by the floor maps
  // the whole slab range onto the band: the darkest input lands at `far`, the lightest at `near`.
  const depth = Math.min(1, Math.max(0, 1 - L / Math.max(1e-6, floorL)));
  const offset = PANEL_BAND.near + (PANEL_BAND.far - PANEL_BAND.near) * depth;

  // A colour with a hue keeps it, capped rather than amplified — a wash on paper is tinted, not
  // saturated. A neutral borrows the paper's instead, which is what makes it read as a panel on
  // this page rather than a grey rectangle laid over it.
  const neutral = C < PANEL_NEUTRAL_CHROMA;
  const panel = neutral
    ? fromOklch(
        floorL - offset,
        Math.max(PANEL_NEUTRAL_CHROMA * 1.5, floorC * PANEL_WARMTH),
        floorH,
      )
    : fromOklch(floorL - offset, Math.min(C, PANEL_CHROMA_CAP), h);

  // Already a panel? Leave the original bytes alone — both the theme's own surfaces and anything
  // this function produced, which is what makes it idempotent.
  const depthNow = floorL - L;
  const alreadyAPanel =
    !neutral &&
    C <= PANEL_CHROMA_CAP + PANEL_BAND_SLACK &&
    depthNow <= PANEL_BAND.far + PANEL_BAND_SLACK &&
    depthNow >= -PANEL_BAND_SLACK;
  return alreadyAPanel ? rgb : panel;
}
