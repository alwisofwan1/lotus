import { describe, expect, it } from "vitest";
import { deEmphasise, foldBackground, foldForeground } from "../adaptive-ink-fold";

/**
 * Garden of Dawn's resolved terminal floor. Not imported from the theme on purpose: this suite
 * is about the fold, and pinning the literal keeps a theme edit from silently rewriting the bar
 * these tests measure against.
 */
const DAWN_FLOOR = [247, 230, 214] as const;

/**
 * WCAG 2.1 relative luminance, hand-written from the spec rather than imported from the module
 * under test. An assertion that borrows the implementation's own maths can never disagree with it.
 */
function contrast(a: readonly number[], b: readonly number[]): number {
  const lum = (rgb: readonly number[]) =>
    rgb
      .map((c) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, v, i) => sum + [0.2126, 0.7152, 0.0722][i] * v, 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG relative luminance, from the spec — same independence rule as `contrast`. */
function luminance(rgb: readonly number[]): number {
  return rgb
    .map((c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, v, i) => sum + [0.2126, 0.7152, 0.0722][i] * v, 0);
}

describe("foldForeground", () => {
  it("makes xterm-256 slot 153 legible on the Garden of Dawn floor", () => {
    // The colour the user circled: Claude Code's dark-theme `suggestion` rgb(177,185,249),
    // downsampled by chalk to cube slot 153. It measures 1.23:1 as painted.
    const asPainted = [175, 215, 255] as const;
    expect(contrast(asPainted, DAWN_FLOOR)).toBeLessThan(1.3);

    expect(contrast(foldForeground(asPainted, DAWN_FLOOR), DAWN_FLOOR)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps a folded colour recognisably its own hue", () => {
    // Channel ORDER is the cheapest hue assertion that borrows nothing from the implementation:
    // a blue whose blue channel stops dominating is no longer the agent's blue, whatever its
    // contrast says. Slot 153 is blue-dominant, slot 214 (warning amber) is red-dominant.
    const [r1, g1, b1] = foldForeground([175, 215, 255], DAWN_FLOOR);
    expect(b1).toBeGreaterThan(g1);
    expect(g1).toBeGreaterThan(r1);

    const [r2, g2, b2] = foldForeground([255, 175, 0], DAWN_FLOOR);
    expect(r2).toBeGreaterThan(g2);
    expect(g2).toBeGreaterThan(b2);
  });

  it("returns an already-legible colour untouched", () => {
    // Garden of Dawn's own ink and its `info` role, both solved against this floor in the theme
    // file. A fold that "improves" colours already over the bar would quietly overrule the theme.
    expect(foldForeground([31, 39, 32], DAWN_FLOOR)).toEqual([31, 39, 32]);
    expect(foldForeground([48, 108, 162], DAWN_FLOOR)).toEqual([48, 108, 162]);
    // Cube slot 240, the darkest greys the agent paints — legible as they are, at 5.84:1.
    expect(foldForeground([88, 88, 88], DAWN_FLOOR)).toEqual([88, 88, 88]);
  });

  it("keeps the grey ramp ordered, so dim text stays dimmer than body text", () => {
    // xterm's 24-step grey ramp, upper half: slot n paints channel 8 + (n - 232) * 10, so these
    // are slots 244, 246, 248, 250, 252 and 255 — every one illegible as painted (3.24:1 down to
    // 1.05:1). The agent uses this ramp for `subtle` / `inactive` / `text`, so its ORDER carries
    // meaning. A clamp puts them all on the threshold and that meaning is gone; a fold must not.
    //
    // Ramp values, never arbitrary integers: two inputs a few counts apart necessarily round to
    // the same folded byte, and asserting on those would be testing rounding, not ordering.
    const ramp = [128, 148, 168, 188, 208, 238].map(
      (v) => foldForeground([v, v, v], DAWN_FLOOR)[0],
    );

    // Lighter input folds DARKER, strictly: on paper the loud end of the ramp is the dark end.
    for (let i = 1; i < ramp.length; i += 1) {
      expect(ramp[i]).toBeLessThan(ramp[i - 1]);
    }
    // And they must stay visibly apart, not merely non-equal.
    expect(ramp[0] - ramp[ramp.length - 1]).toBeGreaterThanOrEqual(8);
  });
});

describe("deEmphasise", () => {
  // xterm renders SGR 2 (dim) by halving the foreground's ALPHA — see DomRendererRowFactory and
  // the webgl TextureAtlas, both of which also cut minimumContrastRatio in half for dim cells.
  // On a light ground that lands the terminal's own ink at 2.92:1: measured rgb(139,135,133) on
  // Garden of Dawn's floor, matching the rgb(138,135,133) sampled from the composer field.
  //
  // So dim cannot be left to xterm here. This is the replacement: real de-emphasis that still
  // clears AA.
  const BODY_INK = [31, 39, 51] as const;

  it("stays legible where xterm's own dim does not", () => {
    const dim = deEmphasise(BODY_INK, DAWN_FLOOR);
    expect(contrast(dim, DAWN_FLOOR)).toBeGreaterThanOrEqual(4.5);

    // What xterm would have produced, for comparison: the same ink at half alpha over the floor.
    const xtermDim = BODY_INK.map((c, i) => Math.round((c + DAWN_FLOOR[i]) / 2));
    expect(contrast(xtermDim, DAWN_FLOOR)).toBeLessThan(3);
  });

  it("still reads as quieter than the body ink it came from", () => {
    // De-emphasis that lands at the same weight as body text is not de-emphasis. The point of
    // dim is hierarchy, so the result must sit clearly lighter than what it de-emphasises.
    const dim = deEmphasise(BODY_INK, DAWN_FLOOR);
    expect(contrast(dim, DAWN_FLOOR)).toBeLessThan(contrast(BODY_INK, DAWN_FLOOR) / 2);
  });

  it("de-emphasises against a dark ground by going lighter, not darker", () => {
    // The composer is not the only place dim appears. On the dark echo strip the quiet direction
    // is UP, and a rule that only ever darkens would erase the text there.
    const strip = [55, 55, 55] as const;
    const dim = deEmphasise([255, 255, 255], strip);
    expect(contrast(dim, strip)).toBeGreaterThanOrEqual(4.5);
    expect(dim[0]).toBeGreaterThan(strip[0]);
  });

  it("quietens a colour that was not legible to begin with", () => {
    // Dim arrives on top of whatever colour is already active, and on a light floor that colour
    // is routinely one the agent picked for black — the agent's own `text` is pure white here.
    // Quietening from white directly would walk the wrong side of the bar and return white.
    const dim = deEmphasise([255, 255, 255], DAWN_FLOOR);
    expect(contrast([255, 255, 255], DAWN_FLOOR)).toBeLessThan(1.3);
    expect(contrast(dim, DAWN_FLOOR)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("foldBackground", () => {
  // Agents pick panel backgrounds for a black terminal, and Lotus left them alone — that rule is
  // what keeps a diff highlight from being darkened into a slab. On a light floor the cost showed
  // up across three different runners at once: Codex painted its prompt block rgb(218,218,218),
  // Pi painted its own rgb(95,95,95). Measured against Garden of Dawn's floor those are a dead
  // grey patch and a hole punched through the paper.
  //
  // The rule here is the theme file's own: builtin-themes.ts sets Garden of Dawn's header
  // gradient to rgba(31,39,32,0.075) and explains why — on a light theme the light comes from in
  // front of the page, so a panel sits SLIGHTLY darker than its body. A panel, not a slab.

  it("brings a dark slab back to the paper as a quiet panel", () => {
    const slab = [95, 95, 95] as const; // Pi's prompt block
    expect(contrast(slab, DAWN_FLOOR)).toBeGreaterThan(5); // a hole, as painted

    const panel = foldBackground(slab, DAWN_FLOOR);
    expect(contrast(panel, DAWN_FLOOR)).toBeLessThan(1.5);
    // Still visible as its own region, or it has stopped being a panel at all.
    expect(contrast(panel, DAWN_FLOOR)).toBeGreaterThan(1.05);
  });

  it("keeps the panel darker than the paper, never lighter", () => {
    // Direction is the theme's, not a guess: light from in front of the page.
    for (const bg of [[95, 95, 95], [218, 218, 218], [55, 55, 55]] as const) {
      const panel = foldBackground(bg, DAWN_FLOOR);
      expect(luminance(panel)).toBeLessThan(luminance(DAWN_FLOOR));
    }
  });

  it("keeps a semantic wash its own colour", () => {
    // Diff add/remove is the case that must not be flattened to neutral: a green wash that comes
    // back grey has lost the only thing it was carrying.
    const added = [34, 92, 43] as const; // Claude Code's dark-theme diffAdded
    const panel = foldBackground(added, DAWN_FLOOR);
    expect(panel[1]).toBeGreaterThan(panel[0]);
    expect(panel[1]).toBeGreaterThan(panel[2]);
  });

  it("keeps darker slabs darker than lighter ones", () => {
    // The echo strip (55,55,55) is deliberate emphasis; a mid grey is not. Both become panels,
    // but they must not become the SAME panel.
    //
    // Both inputs are chosen to be well clear of the pass-through case: an earlier version of
    // this test compared against rgb(218,218,218), which passes through untouched, so it proved
    // the pass-through rule and said nothing at all about the band. Collapsing the band to a
    // single offset did not fail it.
    const strong = foldBackground([55, 55, 55], DAWN_FLOOR);
    const faint = foldBackground([150, 150, 150], DAWN_FLOOR);
    expect(luminance(strong)).toBeLessThan(luminance(faint));
  });

  it("gives a neutral slab the paper's own warmth", () => {
    // THE case the report is about, and the one the first version of this fold missed entirely.
    // Codex paints its prompt block rgb(218,218,218) — a neutral grey whose LIGHTNESS is close
    // enough to the floor to look harmless by contrast alone (1.15:1), which is why it was
    // passed straight through. On warm cream paper it reads as a dead grey patch.
    //
    // A neutral has no hue to preserve, so preserving its chroma preserves nothing: it has to
    // take the floor's hue to belong to the page at all.
    const panel = foldBackground([218, 218, 218], DAWN_FLOOR);
    expect(panel).not.toEqual([218, 218, 218]);
    // Warm, in the floor's own direction: the floor is rgb(247,230,214), so r > g > b.
    expect(panel[0]).toBeGreaterThan(panel[1]);
    expect(panel[1]).toBeGreaterThan(panel[2]);
    // And still a panel, not a slab.
    expect(contrast(panel, DAWN_FLOOR)).toBeLessThan(1.5);
    expect(contrast(panel, DAWN_FLOOR)).toBeGreaterThan(1.03);
  });

  it("warms a dark slab rather than leaving it grey", () => {
    // Same rule, other end of the range: Pi's rgb(95,95,95) came back rgb(208,208,208) — legible
    // as a region, still foreign to the theme.
    const panel = foldBackground([95, 95, 95], DAWN_FLOOR);
    expect(panel[0]).toBeGreaterThan(panel[2]);
  });

  it("leaves a background that already sits on the paper alone", () => {
    // The theme's own surfaces must pass through untouched, or the fold starts fighting the theme.
    const themePanel = [237, 221, 206] as const;
    expect(foldBackground(themePanel, DAWN_FLOOR)).toEqual(themePanel);
  });

  it("does not drift when a panel is folded again", () => {
    // What the pass-through rule is actually FOR, and the only assertion that pins it: a panel's
    // own chroma reads as chromatic on the way back in, so recomputing it lands at the shallow
    // end of the band and the panel creeps lighter every pass. Backgrounds are re-emitted
    // constantly, so a rule that is not idempotent drifts in the direction of the paper until
    // the panel is gone.
    for (const bg of [[95, 95, 95], [218, 218, 218], [34, 92, 43]] as const) {
      const once = foldBackground(bg, DAWN_FLOOR);
      expect(foldBackground(once, DAWN_FLOOR)).toEqual(once);
    }
  });

  it("keeps a wash a wash, not a saturated block", () => {
    // The chroma cap. A vivid input must arrive as a tint on paper: without the cap its chroma
    // survives at panel lightness, the channels clip apart, and the "wash" is a colour block.
    const vivid = foldBackground([0, 255, 0], DAWN_FLOOR);
    expect(Math.max(...vivid) - Math.min(...vivid)).toBeLessThan(60);
    // Still recognisably green, though — capped, not neutralised.
    expect(vivid[1]).toBeGreaterThan(vivid[0]);
  });
});

describe("foldBackground · deliberately inverted grounds", () => {
  // A product decision, taken after seeing the re-grounded result: Claude Code's prompt echo
  // strip should STAY dark. It is the one place a runner deliberately inverts the surface to mark
  // "this is what you said", and on paper a dark bar reads as exactly that.
  //
  // The line is drawn at a ground dark enough to be a full inversion rather than a tint. Claude's
  // `userMessageBackground` rgb(55,55,55) measures 9.78:1 against Garden of Dawn's floor; Pi's
  // prompt panel rgb(95,95,95) measures 5.24:1 and is the "hole" that started the panel rule. The
  // two cases we have evidence for fall either side of 8:1, and the rule has a readable meaning:
  // a tint gets re-grounded, an inverted SURFACE is left inverted.

  it("leaves a fully inverted ground alone", () => {
    const echoStrip = [55, 55, 55] as const;
    expect(contrast(echoStrip, DAWN_FLOOR)).toBeGreaterThan(8);
    expect(foldBackground(echoStrip, DAWN_FLOOR)).toEqual(echoStrip);
  });

  it("still re-grounds a mid slab that only reads as a hole", () => {
    // The exemption must not swallow the panel rule: Pi's block is not an inversion, it is a
    // panel that was subtle on black and is a hole on paper.
    const piPanel = [95, 95, 95] as const;
    expect(contrast(piPanel, DAWN_FLOOR)).toBeLessThan(8);
    expect(foldBackground(piPanel, DAWN_FLOOR)).not.toEqual(piPanel);
  });
});

describe("foldForeground · on a dark ground", () => {
  // Contrast against a ground is U-SHAPED in lightness: it is high at both ends and bottoms out
  // at the ground's own lightness. The first version of this fold assumed the light-floor half of
  // that curve and only ever moved ink DOWNWARD, which is correct on paper and catastrophic on a
  // dark ground — it drove inks toward rgb(0,0,0), i.e. straight into the ground.
  //
  // It stayed hidden while every background was re-grounded onto the paper, because then no dark
  // ground survived to fold against. Exempting the echo strip brought one back and the sweep
  // returned 33 failures at 1.01-1.76:1.
  const STRIP = [55, 55, 55] as const;

  it("lightens ink on a dark ground instead of darkening it into the ground", () => {
    // ANSI green solved for a light floor: rgb(20,117,79), which is 1.76:1 on the strip.
    const ink = [20, 117, 79] as const;
    expect(contrast(ink, STRIP)).toBeLessThan(2.5);

    const folded = foldForeground(ink, STRIP);
    expect(contrast(folded, STRIP)).toBeGreaterThanOrEqual(4.5);
    expect(luminance(folded)).toBeGreaterThan(luminance(ink));
  });

  it("keeps hue while lightening", () => {
    const folded = foldForeground([20, 117, 79], STRIP);
    expect(folded[1]).toBeGreaterThan(folded[0]);
    expect(folded[1]).toBeGreaterThan(folded[2]);
  });

  it("still darkens on a light ground", () => {
    // The light-floor behaviour is the majority case and must not move: slot 153 goes darker.
    const folded = foldForeground([175, 215, 255], DAWN_FLOOR);
    expect(luminance(folded)).toBeLessThan(luminance([175, 215, 255]));
  });

  it("takes the only direction that can clear the bar", () => {
    // Worth writing down, because it is not obvious and it decides most cases: at AA 4.5 there is
    // almost NO ground where both directions work. Going darker needs the ground's own luminance
    // above 0.175 to have room; going lighter needs it below 0.183. Everywhere outside that sliver
    // exactly one direction is reachable and the "shorter way" logic never gets a choice.
    //
    // rgb(90,90,90) sits below the sliver, so nothing on that ground can clear the bar by getting
    // darker — an earlier version of this test asserted it would, which was wrong about the maths
    // rather than about the code.
    const onMidDark = foldForeground([70, 70, 70], [90, 90, 90]);
    expect(luminance(onMidDark)).toBeGreaterThan(luminance([70, 70, 70]));
    expect(contrast(onMidDark, [90, 90, 90])).toBeGreaterThanOrEqual(4.5);
  });

  it("moves the shorter way when the ground does allow both", () => {
    // rgb(117,117,117) has luminance 0.178 — inside that sliver — so both edges are reachable and
    // the choice is real. The nearer edge wins, which is what keeps most of the ink's identity.
    const ground = [117, 117, 117] as const;
    const down = foldForeground([100, 100, 100], ground);
    expect(luminance(down)).toBeLessThan(luminance([100, 100, 100]));
    expect(contrast(down, ground)).toBeGreaterThanOrEqual(4.5);

    const up = foldForeground([220, 220, 220], ground);
    expect(luminance(up)).toBeGreaterThan(luminance([220, 220, 220]));
    expect(contrast(up, ground)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("foldForeground · ordering on a dark ground", () => {
  // The mirror of "keeps the grey ramp ordered". On paper a lighter input becomes darker ink; on
  // a dark ground a darker input becomes lighter ink. Either way the agent's own emphasis
  // ordering has to survive, and either way that depends on the band being normalised by the
  // distance to the end of the axis we are actually travelling toward.
  //
  // Normalising by the wrong end pushes every overshoot far past white, where the channels clip
  // and the whole ramp collapses onto one colour — legible, and no longer a ramp.

  it("keeps a dark ramp ordered, inverted", () => {
    const strip = [55, 55, 55] as const;
    const folded = [30, 45, 60, 75, 90].map(
      (v) => luminance(foldForeground([v, v, v], strip)),
    );

    for (let i = 1; i < folded.length; i += 1) {
      expect(folded[i]).toBeLessThan(folded[i - 1]);
    }
    // Visibly apart, not merely non-equal — the clipping failure produces exact ties.
    expect(folded[0] - folded[folded.length - 1]).toBeGreaterThan(0.05);
  });
});
