import {
  AA_CONTRAST,
  contrastRatio,
  deEmphasise,
  foldBackground,
  foldForeground,
  type Rgb,
} from "./theme/adaptive-ink-fold";

const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const SURFACE_SHADOW_RGB = [55, 48, 47] as const;

/** The 6 levels each channel of the xterm-256 colour cube can take. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

/**
 * How the terminal will actually paint an xterm-256 slot.
 *
 * Slots 0-15 return undefined on purpose — an index alone carries no colour. When the caller
 * hands over the 16-slot palette they are folded too, in the branch below; without it there is
 * nothing to fold. (This comment used to claim those slots were already safe because
 * `canvas-terminal-theme.ts` had solved them. Measured: ten of its light entries are under AA.)
 */
function ansi256ToRgb(index: number | undefined): Rgb | undefined {
  // `undefined` is the real case, not paranoia: a truncated `\x1b[38;5m` matches the SGR pattern
  // and carries no index. Without this the arithmetic below yields NaN channels and the chunk is
  // re-emitted as `38;2;NaN;NaN;NaN` — a sequence the terminal cannot parse, produced from input
  // the normaliser was only ever supposed to pass through.
  //
  // A non-integer cannot reach here: normalizeSgrParams bails on any non-finite param, and
  // parseInt yields either an integer or NaN.
  if (index === undefined || index < 16 || index > 255) return undefined;
  if (index >= 232) {
    const grey = 8 + (index - 232) * 10;
    return [grey, grey, grey];
  }
  const n = index - 16;
  return [CUBE_LEVELS[Math.floor(n / 36)], CUBE_LEVELS[Math.floor(n / 6) % 6], CUBE_LEVELS[n % 6]];
}

function parseFloor(floor: string): Rgb | undefined {
  const m = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(floor);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/**
 * A 16-slot background is in effect whose colour only the xterm palette knows.
 *
 * Distinct from `undefined` (= the terminal floor) because the two demand opposite behaviour:
 * on the floor the fold is correct, and here it would be a guess at a colour this module cannot
 * see, so the fold stands down and leaves the agent's own pairing alone.
 */
const UNKNOWN_BACKGROUND = Symbol("unknown-background");

/**
 * SGR is a state machine, and the background half of it has to survive across chunks: a PTY
 * splits wherever it likes, so the sequence that sets a background and the text painted on it
 * routinely arrive in different reads.
 *
 * The caller owns one of these per pane. Omit it and each call starts clean — correct for a
 * self-contained chunk, and what the tests use.
 */
export interface AnsiFoldState {
  background?: Rgb | typeof UNKNOWN_BACKGROUND;
  /** True while a dim run has been replaced by an explicit ink that SGR 22 must undo. */
  dimSubstituted?: boolean;
}

/** The terminal ground this chunk is being painted onto. */
export interface LiveAgentAnsiSurface {
  /** Light grounds need the fold; dark grounds are already what the agent assumed. */
  mode: "dark" | "light";
  /** Opaque floor from `resolveTerminalFloor()`, e.g. `"rgb(247, 230, 214)"`. */
  floor: string;
  /**
   * The terminal's own default foreground, from `resolveCanvasTerminalTheme()`.
   *
   * Needed only for dim: SGR 2 usually arrives with no colour of its own, so the ink it is
   * quietening IS this value. Omit it and dim is left to xterm, which is the old behaviour.
   */
  foreground?: string;
  /**
   * The 16 ANSI slots in palette order, as xterm would paint them.
   *
   * WHY THE STREAM AND NOT THE PALETTE FILE
   * Ten of `canvas-terminal-theme.ts`'s light entries sit under AA on Garden of Dawn's floor —
   * `brightBlack` 3.97, `brightCyan` 3.55, `brightGreen` 3.56, `brightYellow` 3.61, and ANSI
   * `white` at 1.01. Deepening them there cannot work, because a palette is background-BLIND:
   * white has to stay white on a dark panel and become ink on the floor, and only the stream
   * knows which is behind the glyph. Same lesson as the echo-bar regression.
   *
   * Omit it and slots 0-15 pass through untouched, which is the old behaviour.
   */
  palette?: readonly string[];
}

function isNearBlack(r: number, g: number, b: number): boolean {
  return r <= 8 && g <= 8 && b <= 8;
}

function pushSurfaceShadow(out: number[]) {
  out.push(38, 2, ...SURFACE_SHADOW_RGB);
}

function pushFolded(out: number[], rgb: Rgb, floor: Rgb) {
  const [r, g, b] = foldForeground(rgb, floor);
  out.push(38, 2, r, g, b);
}

function normalizeSgrParams(
  raw: string,
  floor?: Rgb,
  state?: AnsiFoldState,
  defaultFg?: Rgb,
  palette?: readonly string[],
): string {
  if (raw.trim() === "") {
    // An empty parameter list is `\x1b[m`, a full reset — the background goes with it.
    if (state) state.background = undefined;
    return raw;
  }
  const params = raw.split(";").map((part) => Number.parseInt(part || "0", 10));
  if (params.some((value) => !Number.isFinite(value))) return raw;

  // What the fold must solve against: whatever is painted behind the glyph. `undefined` means the
  // terminal floor; UNKNOWN_BACKGROUND means a 16-slot background whose colour lives in the xterm
  // palette and is not knowable here — the fold stands down rather than guessing.
  const ground = (): Rgb | undefined => {
    const bg = state?.background;
    if (bg === UNKNOWN_BACKGROUND) return undefined;
    return bg ?? floor;
  };

  const next: number[] = [];
  for (let i = 0; i < params.length; i += 1) {
    const code = params[i];

    if (code === 30) {
      pushSurfaceShadow(next);
      continue;
    }

    // ── DIM ──
    // xterm renders SGR 2 by halving the foreground's ALPHA, so it cannot be corrected by
    // choosing a better colour — whatever we send gets halved. The attribute has to go, and an
    // explicit quiet-but-legible ink take its place. See deEmphasise for the measurements.
    if (code === 2 && defaultFg) {
      const behind = ground();
      if (behind) {
        const [r, g, b] = deEmphasise(defaultFg, behind);
        next.push(38, 2, r, g, b);
        if (state) state.dimSubstituted = true;
        continue;
      }
    }

    // Having taken the attribute away, we owe the stream a way back to normal intensity —
    // otherwise the quiet ink outlives its run and every following line inherits it.
    if (code === 22 && state?.dimSubstituted) {
      state.dimSubstituted = false;
      next.push(22, 39);
      continue;
    }

    // A full reset clears the background along with everything else.
    if (code === 0 && state) {
      state.background = undefined;
      state.dimSubstituted = false;
    }
    // Explicit default background.
    if (code === 49 && state) state.background = undefined;
    // A 16-slot background: its colour is the xterm palette's to decide, not ours.
    if (state && ((code >= 41 && code <= 47) || (code >= 101 && code <= 107))) {
      state.background = UNKNOWN_BACKGROUND;
    }

    if (code === 40 || code === 100) {
      // Reset to default, so the ground becomes the floor again — matching the emitted `49`.
      if (state) state.background = undefined;
      next.push(49);
      continue;
    }

    // ── 16-SLOT FOREGROUNDS ──
    // 30-37 are the normal slots, 90-97 the bright ones. Folded against the ground like any
    // other colour, but only when we were handed the palette — otherwise the colour xterm will
    // paint is unknown and folding would be a guess.
    if (palette && ((code >= 31 && code <= 37) || (code >= 90 && code <= 97))) {
      const slot = code >= 90 ? code - 90 + 8 : code - 30;
      const painted = palette[slot];
      const behind = ground();
      if (painted && behind) {
        const rgb = parseFloor(painted);
        // A slot that already clears the bar stays a PALETTE REFERENCE rather than being
        // re-emitted as truecolor: pinning it to today's numbers would quietly detach the cell
        // from the theme, so a later palette change would stop reaching it.
        if (rgb && contrastRatio(rgb, behind) < AA_CONTRAST) {
          pushFolded(next, rgb, behind);
          continue;
        }
      }
    }

    if (code === 38 && params[i + 1] === 5 && params[i + 2] === 0) {
      pushSurfaceShadow(next);
      i += 2;
      continue;
    }

    // An indexed foreground the xterm palette cannot reach. `theme.extendedAnsi` could, but one
    // palette would serve backgrounds too and paint dark blocks behind text — so it is folded
    // here and re-emitted as truecolor instead.
    if (code === 38 && params[i + 1] === 5 && floor) {
      const painted = ansi256ToRgb(params[i + 2]);
      const behind = ground();
      if (painted && behind) {
        pushFolded(next, painted, behind);
        i += 2;
        continue;
      }
    }

    if (code === 38 && params[i + 1] === 2) {
      const rgb: Rgb = [params[i + 2], params[i + 3], params[i + 4]];
      const behind = floor ? ground() : undefined;
      if (isNearBlack(...rgb)) pushSurfaceShadow(next);
      else if (behind) pushFolded(next, rgb, behind);
      else next.push(code, params[i + 1], ...rgb);
      i += 4;
      continue;
    }

    if (code === 48 && params[i + 1] === 5 && params[i + 2] === 0) {
      if (state) state.background = undefined; // emitted as 49, so the ground is the floor
      next.push(49);
      i += 2;
      continue;
    }

    // An indexed background, re-grounded onto the paper. Re-emitted as truecolor because a cube
    // slot cannot express the panel. The fold also has to KNOW the result, since a glyph on a
    // panel is not sitting on the floor — that was the echo-bar regression.
    if (code === 48 && params[i + 1] === 5) {
      const painted = ansi256ToRgb(params[i + 2]);
      if (painted && floor) {
        const panel = foldBackground(painted, floor);
        if (state) state.background = panel;
        next.push(48, 2, ...panel);
        i += 2;
        continue;
      }
      if (state) state.background = painted ?? UNKNOWN_BACKGROUND;
      next.push(code, params[i + 1], params[i + 2]);
      i += 2;
      continue;
    }

    if (code === 48 && params[i + 1] === 2) {
      const bg: Rgb = [params[i + 2], params[i + 3], params[i + 4]];
      if (isNearBlack(...bg)) {
        // Reset to the terminal's own ground, so the floor is what is behind the glyph.
        if (state) state.background = undefined;
        next.push(49);
      } else {
        const panel = floor ? foldBackground(bg, floor) : bg;
        if (state) state.background = panel;
        next.push(code, params[i + 1], ...panel);
      }
      i += 4;
      continue;
    }

    next.push(code);
  }

  return next.join(";");
}

/**
 * Claude Code's banner uses near-black ANSI cells that look correct on a solid black
 * terminal but become harsh blocks on Canvas' transparent live-agent surface. Keep
 * legitimate colour ANSI intact while translating only near-black foreground/background
 * cells into Canvas-friendly surface tones.
 *
 * On a LIGHT surface it does a second job: an agent that believes it is running on black paints
 * foregrounds far too pale to read on paper, in xterm-256 slots the terminal palette has no say
 * over. Pass the surface and those foregrounds are folded onto its floor. Omit it — as every
 * caller did before this existed — and behaviour is exactly what it always was.
 *
 * Backgrounds are never folded, on either path.
 */
export function normalizeLiveAgentAnsi(
  chunk: string,
  surface?: LiveAgentAnsiSurface,
  state: AnsiFoldState = {},
): string {
  const light = surface?.mode === "light";
  const floor = light ? parseFloor(surface.floor) : undefined;
  const defaultFg = light && surface.foreground ? parseFloor(surface.foreground) : undefined;
  const palette = light ? surface.palette : undefined;
  return chunk.replace(
    ANSI_SGR_PATTERN,
    (_match, params: string) =>
      `\x1b[${normalizeSgrParams(params, floor, state, defaultFg, palette)}m`,
  );
}
