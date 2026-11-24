import { describe, expect, it } from "vitest";
import { normalizeLiveAgentAnsi } from "../live-agent-ansi-normalizer";

const surfaceShadow = "38;2;55;48;47";

/**
 * WCAG 2.1 contrast, hand-written from the spec rather than imported from the module under test —
 * an assertion that borrows the implementation's own maths can never disagree with it.
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

/**
 * Does any SGR sequence in `chunk` set the dim attribute?
 *
 * Written as a parameter walk rather than a regex because `2` is overloaded: as an attribute it
 * means dim, and inside `38;2;r;g;b` / `48;2;r;g;b` it selects the truecolor space. A regex
 * cannot tell the two apart, which is exactly the mistake this helper exists to avoid.
 */
function dimAttributeSet(chunk: string): boolean {
  for (const match of chunk.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const params = match[1].split(";");
    for (let i = 0; i < params.length; i += 1) {
      if (params[i] === "38" || params[i] === "48") {
        i += params[i + 1] === "5" ? 2 : 4; // skip the colour payload
        continue;
      }
      if (params[i] === "2") return true;
    }
  }
  return false;
}

describe("normalizeLiveAgentAnsi", () => {
  it("resets palette black backgrounds so Canvas live agents do not show hard black blocks", () => {
    expect(normalizeLiveAgentAnsi("\x1b[40m  \x1b[0m")).toBe("\x1b[49m  \x1b[0m");
    expect(normalizeLiveAgentAnsi("\x1b[1;40;31mX\x1b[0m")).toBe("\x1b[1;49;31mX\x1b[0m");
  });

  it("resets indexed and truecolor near-black backgrounds", () => {
    expect(normalizeLiveAgentAnsi("\x1b[48;5;0mX")).toBe("\x1b[49mX");
    expect(normalizeLiveAgentAnsi("\x1b[48;2;0;0;0mX")).toBe("\x1b[49mX");
    expect(normalizeLiveAgentAnsi("\x1b[48;2;8;8;8mX")).toBe("\x1b[49mX");
  });

  it("maps black foreground cells to a Canvas surface shadow instead of pure black", () => {
    expect(normalizeLiveAgentAnsi("\x1b[30m█")).toBe(`\x1b[${surfaceShadow}m█`);
    expect(normalizeLiveAgentAnsi("\x1b[38;5;0m█")).toBe(`\x1b[${surfaceShadow}m█`);
    expect(normalizeLiveAgentAnsi("\x1b[38;2;0;0;0m█")).toBe(`\x1b[${surfaceShadow}m█`);
  });

  it("folds an illegible indexed foreground onto a light terminal floor", () => {
    // The reported bug end to end: Claude Code paints a path in cube slot 153 while it believes
    // it is on black. On Garden of Dawn's floor that is 1.23:1.
    const folded = normalizeLiveAgentAnsi("\x1b[38;5;153mtmp/helo.txt", {
      mode: "light",
      floor: "rgb(247, 230, 214)",
    });

    // Re-emitted as truecolor, because the cube slot it arrived as is not addressable.
    const match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(folded);
    expect(match).not.toBeNull();
    expect(folded).toContain("tmp/helo.txt");

    const [r, g, b] = match!.slice(1).map(Number);
    // Same hue assertion as the fold suite: still blue-dominant.
    expect(b).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(r);
    // And no longer the pale original.
    expect([r, g, b]).not.toEqual([175, 215, 255]);
  });

  it("folds an illegible truecolor foreground too", () => {
    // What the same agent emits once COLORTERM is advertised: its dark-theme `suggestion`,
    // undownsampled. 1.54:1 on this floor — the cube was never the only way to be illegible.
    const folded = normalizeLiveAgentAnsi("\x1b[38;2;177;185;249mpath", {
      mode: "light",
      floor: "rgb(247, 230, 214)",
    });
    const [r, g, b] = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(folded)!.slice(1).map(Number);
    expect([r, g, b]).not.toEqual([177, 185, 249]);
    expect(b).toBeGreaterThan(r);
  });

  it("never emits a foreground that fails against the background beside it", () => {
    // REGRESSION GUARD, restated. Claude Code echoes the submitted prompt on a dark
    // `userMessageBackground` rgb(55,55,55) strip. Folding its white text against the light FLOOR
    // produced rgb(62,62,62) ink — 1.11:1 on that strip, where unfolded white measured 11.90:1.
    // Sampled from the screenshot: strip rgb(58,58,58), text rgb(62,62,62).
    //
    // The invariant form: whatever ground a glyph ends up on, the ink must clear AA against it.
    // This is what the test became when backgrounds started being re-grounded and no dark strip
    // survived. The strip is now exempt again as a deliberate inversion, so the original literal
    // is checkable too and is asserted below — the invariant stays because it holds for the cases
    // that are NOT exempt, which the literal cannot cover.
    const cases = [
      "\x1b[48;2;55;55;55m\x1b[38;2;255;255;255m❯ buatkan file bebas",
      "\x1b[48;2;95;95;95m\x1b[38;5;153mpath",
      "\x1b[48;5;236m\x1b[38;2;177;185;249mpath",
    ];
    for (const chunk of cases) {
      const out = normalizeLiveAgentAnsi(chunk, { mode: "light", floor: "rgb(247, 230, 214)" });
      const bg = /\x1b\[48;2;(\d+);(\d+);(\d+)m/.exec(out)!.slice(1).map(Number);
      const fg = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(out)!.slice(1).map(Number);
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }

    // And specifically on the echo strip, which is exempt from re-grounding: the strip stays
    // rgb(55,55,55) and its white text is left exactly as the agent sent it. This is the literal
    // that the original regression test asserted, restored now that the exemption brings it back.
    const strip = normalizeLiveAgentAnsi(cases[0], { mode: "light", floor: "rgb(247, 230, 214)" });
    expect(strip).toContain("\x1b[48;2;55;55;55m");
    expect(strip).toContain("\x1b[38;2;255;255;255m");
  });

  it("returns to the floor once the background is reset", () => {
    // The state machine has to unwind, or every later line inherits a background that is gone.
    const light = { mode: "light", floor: "rgb(247, 230, 214)" } as const;
    const chunk = "\x1b[48;2;55;55;55mbar\x1b[49m\x1b[38;5;153mpath";
    const [r, g, b] = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(
      normalizeLiveAgentAnsi(chunk, light),
    )!.slice(1).map(Number);
    // Back on the cream floor, slot 153 must fold again.
    expect([r, g, b]).not.toEqual([175, 215, 255]);
    expect(b).toBeGreaterThan(r);
  });

  it("re-grounds a background onto the paper instead of leaving a slab", () => {
    // POLICY CHANGE, and this test used to assert the opposite. Backgrounds were deliberately
    // never touched, which is what kept a folded slot from painting a dark block behind text —
    // the reason this work never went into xterm's `extendedAnsi`. That was right as far as it
    // went, and it left every agent's panel exactly as authored for a black terminal: measured on
    // Garden of Dawn's floor, Codex's prompt block rgb(218,218,218) is a dead grey patch and
    // Pi's rgb(95,95,95) is a hole at 5.24:1.
    //
    // They are now re-grounded as panels on the paper. What has NOT changed is the thing the old
    // rule protected: a background is never given a foreground's fold, so nothing becomes a dark
    // block. See the fold suite for the band and the idempotency it guarantees.
    const light = { mode: "light", floor: "rgb(247, 230, 214)" } as const;

    const panel = /\x1b\[48;2;(\d+);(\d+);(\d+)m/.exec(
      normalizeLiveAgentAnsi("\x1b[48;2;95;95;95mX", light),
    );
    expect(panel).not.toBeNull();
    const bg = panel!.slice(1).map(Number);
    expect(contrast(bg, [247, 230, 214])).toBeLessThan(1.5);
    expect(bg[0]).toBeGreaterThan(bg[2]); // warm, like the paper

    // An indexed background is re-grounded too, and re-emitted as truecolor because the cube
    // slot it arrived as cannot express the panel.
    expect(normalizeLiveAgentAnsi("\x1b[48;5;236mX", light)).toMatch(/\x1b\[48;2;\d+;\d+;\d+mX/);
  });

  it("solves the ink for the panel the glyph will actually sit on", () => {
    // The two folds have to agree. Re-grounding the background moves the ground out from under
    // the text, so a foreground solved against the ORIGINAL background would be answering a
    // question that is no longer being asked — the echo-bar regression, one turn of the screw
    // later. White on rgb(55,55,55) needs no fold; white on the warm panel that replaces it does.
    const out = normalizeLiveAgentAnsi(
      "\x1b[48;2;55;55;55m\x1b[38;2;255;255;255m❯ prompt",
      { mode: "light", floor: "rgb(247, 230, 214)" },
    );
    const bg = /\x1b\[48;2;(\d+);(\d+);(\d+)m/.exec(out)!.slice(1).map(Number);
    const fg = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(out)!.slice(1).map(Number);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves backgrounds alone on a dark surface", () => {
    const chunk = "\x1b[48;2;95;95;95mX";
    expect(normalizeLiveAgentAnsi(chunk, { mode: "dark", floor: "rgb(8, 8, 12)" })).toBe(chunk);
    expect(normalizeLiveAgentAnsi(chunk)).toBe(chunk);
  });

  it("passes malformed and non-indexed colour sequences through untouched", () => {
    const light = { mode: "light", floor: "rgb(247, 230, 214)" } as const;
    // Truncated: an indexed foreground with no index. Must never become `38;2;NaN;NaN;NaN`.
    expect(normalizeLiveAgentAnsi("\x1b[38;5mX", light)).toBe("\x1b[38;5mX");
    // Slots 1-15 as an INDEX carry no colour this module can see, and no palette was handed in
    // here, so there is nothing to fold. (The claim this comment used to make — that
    // canvas-terminal-theme.ts had already solved these against a light floor — turned out to be
    // false: ten of its light entries sit under AA on this floor. See the palette suite below.)
    expect(normalizeLiveAgentAnsi("\x1b[38;5;9mX", light)).toBe("\x1b[38;5;9mX");
    // An unparseable floor leaves the fold switched off rather than emitting nonsense.
    expect(normalizeLiveAgentAnsi("\x1b[38;5;153mX", { mode: "light", floor: "" })).toBe(
      "\x1b[38;5;153mX",
    );
  });

  it("leaves output untouched on dark themes", () => {
    // The default, and what every existing caller gets. A dark canvas must cost nothing.
    const chunk = "\x1b[38;5;153mtmp/helo.txt\x1b[0m";
    expect(normalizeLiveAgentAnsi(chunk, { mode: "dark", floor: "rgb(8, 8, 12)" })).toBe(chunk);
    expect(normalizeLiveAgentAnsi(chunk)).toBe(chunk);
  });

  it("preserves non-black ANSI colour and reset sequences", () => {
    expect(normalizeLiveAgentAnsi("\x1b[38;2;222;112;78;48;2;30;40;50mX\x1b[m")).toBe("\x1b[38;2;222;112;78;48;2;30;40;50mX\x1b[m");
  });
});

describe("normalizeLiveAgentAnsi · dim on a light surface", () => {
  // Claude Code is an Ink app and uses `dimColor` in 248 places, which chalk emits as SGR 2.
  // xterm renders that by halving the foreground's alpha, so on Garden of Dawn's floor the
  // composer field measured rgb(138,135,133) — 2.92:1. This is the field in the report.
  const light = {
    mode: "light",
    floor: "rgb(247, 230, 214)",
    foreground: "rgb(31, 39, 51)",
  } as const;

  it("replaces xterm's dim with an explicit legible ink", () => {
    const out = normalizeLiveAgentAnsi("\x1b[2misi filenya sama konten random dong", light);

    // The dim ATTRIBUTE must be gone, or xterm halves whatever colour we put there. `2` cannot
    // be matched with a regex — it also appears as the colour-space selector in `38;2;r;g;b` —
    // so the parameters are walked the way a terminal walks them, skipping colour payloads.
    expect(dimAttributeSet(out)).toBe(false);
    const [r, g, b] = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(out)!.slice(1).map(Number);
    // Legible, and not simply the body ink — dim still has to read as quieter.
    expect([r, g, b]).not.toEqual([31, 39, 51]);
    expect(r).toBeGreaterThan(31);
  });

  it("hands intensity back on SGR 22", () => {
    // Having taken the dim attribute away, the normaliser owes the stream a way back: without
    // this, every line after a dim run keeps rendering in the quiet ink.
    const out = normalizeLiveAgentAnsi("\x1b[2mquiet\x1b[22mloud", light);

    // A bare `22` is NOT enough and is the trap here: it cancels an intensity attribute we no
    // longer set, leaving our explicit quiet ink in force. The reset has to name the default
    // foreground — `39` — as well.
    const sequences = [...out.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1].split(";"));
    const restore = sequences.find((params) => params.includes("22"));
    expect(restore).toBeDefined();
    expect(restore).toContain("39");
    expect(out.endsWith("loud")).toBe(true);
  });

  it("leaves dim alone on a dark surface", () => {
    const chunk = "\x1b[2mquiet\x1b[22m";
    // Also the positive control for dimAttributeSet: it has to be able to SEE dim, or the
    // assertion above passes for the wrong reason.
    expect(dimAttributeSet(chunk)).toBe(true);
    expect(dimAttributeSet(`\x1b[38;2;1;2;3m`)).toBe(false);

    expect(normalizeLiveAgentAnsi(chunk, { mode: "dark", floor: "rgb(8, 8, 12)" })).toBe(chunk);
    expect(normalizeLiveAgentAnsi(chunk)).toBe(chunk);
  });
});

describe("normalizeLiveAgentAnsi · the 16-slot palette", () => {
  // The palette xterm would paint slots 0-15 with. Solved against a light floor in
  // canvas-terminal-theme.ts, where TEN of its entries still sit under AA on Garden of Dawn's
  // floor rgb(247,230,214): brightBlack 3.97, brightCyan 3.55, brightGreen 3.56,
  // brightYellow 3.61, brightRed 4.11, brightMagenta 4.01, brightBlue 4.16, white 1.01,
  // brightWhite 1.16, cursorAccent 1.13.
  //
  // They cannot be fixed in that file, because a palette is background-BLIND — the same trap as
  // xterm's extendedAnsi and as the regression in the echo bar. White has to stay white on a
  // dark panel and become ink on the floor, and only the stream knows which.
  const PALETTE = [
    "rgb(24, 28, 38)", "rgb(179, 53, 46)", "rgb(20, 117, 79)", "rgb(142, 92, 10)",
    "rgb(39, 93, 184)", "rgb(139, 63, 192)", "rgb(13, 111, 138)", "rgb(230, 232, 238)",
    "rgb(107, 114, 128)", "rgb(200, 62, 54)", "rgb(28, 138, 94)", "rgb(166, 108, 12)",
    "rgb(47, 108, 205)", "rgb(155, 74, 210)", "rgb(17, 132, 163)", "rgb(248, 250, 252)",
  ];
  const light = {
    mode: "light",
    floor: "rgb(247, 230, 214)",
    foreground: "rgb(31, 39, 51)",
    palette: PALETTE,
  } as const;

  function fgOf(out: string): [number, number, number] {
    const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(out);
    expect(m).not.toBeNull();
    return m!.slice(1).map(Number) as [number, number, number];
  }

  it("folds a pale bright slot onto the floor", () => {
    // 90 is brightBlack, the comment/dim tone every runner leans on — 3.97:1 as painted, and
    // the single most common pale colour across the three agents in the report.
    const [r, g, b] = fgOf(normalizeLiveAgentAnsi("\x1b[90m1.8%/272k", light));
    expect(contrast([r, g, b], [247, 230, 214])).toBeGreaterThanOrEqual(4.5);
  });

  it("turns ANSI white into ink wherever it lands", () => {
    // Slot 7 measures 1.01:1 on the floor — an agent using it for body text writes in invisible
    // ink, and Pi does exactly that (its panel text sampled as the floor colour itself).
    //
    // The "but leaves it white on a dark panel" half of this test is gone with the background
    // policy: on a light surface every panel is re-grounded onto the paper, so there is no dark
    // ground left for white to be correct on. The ink must work on the panel instead.
    const onFloor = fgOf(normalizeLiveAgentAnsi("\x1b[37mtext", light));
    expect(contrast(onFloor, [247, 230, 214])).toBeGreaterThanOrEqual(4.5);

    const out = normalizeLiveAgentAnsi("\x1b[48;2;95;95;95m\x1b[37mtext", light);
    const bg = /\x1b\[48;2;(\d+);(\d+);(\d+)m/.exec(out)!.slice(1).map(Number);
    // `fgOf` matches 38;2 only, so the 48;2 panel beside it cannot be picked up by mistake.
    expect(contrast(fgOf(out), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves a slot that already clears the bar as a palette reference", () => {
    // Slot 4 is blue at 5.16:1. Re-emitting it as truecolor would pin it to today's palette and
    // silently detach it from the theme.
    expect(normalizeLiveAgentAnsi("\x1b[34mpath", light)).toBe("\x1b[34mpath");
  });

  it("needs no palette to keep working", () => {
    // Every existing caller and the whole dark path pass none.
    expect(normalizeLiveAgentAnsi("\x1b[90mx", { mode: "light", floor: "rgb(247, 230, 214)" })).toBe(
      "\x1b[90mx",
    );
  });
});

describe("normalizeLiveAgentAnsi · the whole SGR space", () => {
  // Three runners with three different colour habits showed up in one screenshot: Claude Code
  // leans on truecolor and the 256-cube, Codex and Pi on the 16 slots and on dim. Fixing them
  // case by case is how a fourth runner ends up pale again, so this sweeps the space instead.
  //
  // The contract is one line: whatever an agent emits, the ink Lotus hands xterm clears AA
  // against the ground Lotus hands it alongside.
  const PALETTE = [
    "rgb(24, 28, 38)", "rgb(179, 53, 46)", "rgb(20, 117, 79)", "rgb(142, 92, 10)",
    "rgb(39, 93, 184)", "rgb(139, 63, 192)", "rgb(13, 111, 138)", "rgb(230, 232, 238)",
    "rgb(107, 114, 128)", "rgb(200, 62, 54)", "rgb(28, 138, 94)", "rgb(166, 108, 12)",
    "rgb(47, 108, 205)", "rgb(155, 74, 210)", "rgb(17, 132, 163)", "rgb(248, 250, 252)",
  ];
  const FLOOR: readonly number[] = [247, 230, 214];
  const light = {
    mode: "light",
    floor: "rgb(247, 230, 214)",
    foreground: "rgb(31, 39, 51)",
    palette: PALETTE,
  } as const;

  /**
   * The ground and ink a chunk actually resolves to, following the stream the way xterm does.
   *
   * Modelling DIM here is what makes the sweep bite: xterm renders SGR 2 by halving the
   * foreground's alpha, so a chunk that still carries the attribute resolves to a blend with the
   * ground, not to the ink. An earlier version of this walker ignored code 2 and therefore passed
   * happily with the dim substitution switched off — it was measuring a terminal that does not
   * exist.
   */
  function resolved(chunk: string): { fg: readonly number[]; bg: readonly number[] } {
    const out = normalizeLiveAgentAnsi(chunk, light);
    let fg: readonly number[] = [31, 39, 51];
    let bg: readonly number[] = FLOOR;
    let dim = false;
    for (const m of out.matchAll(/\x1b\[([0-9;]*)m/g)) {
      const p = m[1].split(";").map(Number);
      for (let i = 0; i < p.length; i += 1) {
        if (p[i] === 38 && p[i + 1] === 2) { fg = p.slice(i + 2, i + 5); i += 4; }
        else if (p[i] === 48 && p[i + 1] === 2) { bg = p.slice(i + 2, i + 5); i += 4; }
        else if (p[i] === 49) bg = FLOOR;
        else if (p[i] === 39) fg = [31, 39, 51];
        else if (p[i] === 2) dim = true;
        else if (p[i] === 22 || p[i] === 0) dim = false;
        else if (p[i] >= 31 && p[i] <= 37) fg = parse(PALETTE[p[i] - 30]);
        else if (p[i] >= 90 && p[i] <= 97) fg = parse(PALETTE[p[i] - 90 + 8]);
      }
    }
    // xterm: DomRendererRowFactory / webgl TextureAtlas both multiply the fg alpha by 0.5.
    if (dim) fg = fg.map((c, i) => Math.round((c + bg[i]) / 2));
    return { fg, bg };
  }
  const parse = (css: string) => /(\d+)\D+(\d+)\D+(\d+)/.exec(css)!.slice(1).map(Number);

  const grounds = ["", "\x1b[48;2;55;55;55m", "\x1b[48;2;95;95;95m", "\x1b[48;5;236m", "\x1b[48;5;253m"];
  const inks: string[] = [
    ...Array.from({ length: 7 }, (_, i) => `\x1b[${31 + i}m`),
    ...Array.from({ length: 8 }, (_, i) => `\x1b[${90 + i}m`),
    ...[153, 246, 231, 255, 39, 214, 141, 196, 46, 250].map((n) => `\x1b[38;5;${n}m`),
    "\x1b[38;2;177;185;249m", "\x1b[38;2;255;255;255m", "\x1b[38;2;255;193;7m",
    "\x1b[2m",
  ];

  it("never hands xterm an ink that fails on the ground beside it", () => {
    const failures: string[] = [];
    for (const ground of grounds) {
      for (const ink of inks) {
        const { fg, bg } = resolved(`${ground}${ink}text`);
        const ratio = contrast(fg, bg);
        if (ratio < 4.5) {
          failures.push(
            `${JSON.stringify(ground)} + ${JSON.stringify(ink)} -> fg ${fg} on bg ${bg} = ${ratio.toFixed(2)}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
