import { describe, expect, it } from "vitest";
import {
  compositeOver,
  contrastRatio,
  DESIGN_THEME_MODES,
  getDesignTheme,
  type ResolvedThemeMode,
  type TerminalTheme,
} from "@/lib/design-system";

const ANSI_SLOTS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies readonly (keyof TerminalTheme)[];

// The one slot per theme that is meant to sit near the background: `black` on Dark, `white` on
// Light. Programs paint it as a background or as "invisible" text, so it is exempt from the floor.
const BACKGROUND_SLOT: Record<ResolvedThemeMode, (typeof ANSI_SLOTS)[number]> = {
  dark: "black",
  light: "white",
};

/** Lightness rank: contrast against pure black grows with relative luminance. */
const lightness = (color: string) => contrastRatio(color, "#000000");

describe("terminal palette contrast", () => {
  for (const mode of DESIGN_THEME_MODES) {
    const terminal = getDesignTheme(mode).terminal;

    it.each(ANSI_SLOTS.filter((slot) => slot !== BACKGROUND_SLOT[mode]))(
      `${mode}: %s reads at 4.5:1 or better on the terminal background`,
      (slot) => {
        expect(contrastRatio(terminal[slot], terminal.background)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it(`${mode}: foreground reads at 4.5:1 or better on the selection`, () => {
      const selection = compositeOver(terminal.selectionBackground, terminal.background);
      expect(contrastRatio(terminal.foreground, selection)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${mode}: the black slots are darker than the white slots, black darkest`, () => {
      const { black, brightBlack, white, brightWhite } = terminal;
      expect(lightness(black)).toBeLessThan(lightness(brightBlack));
      expect(lightness(brightBlack)).toBeLessThan(Math.min(lightness(white), lightness(brightWhite)));
    });
  }

  // Dark keeps the full ANSI order. Light cannot: its `white` is the near-background slot, so the
  // readable `brightWhite` has to sit below it — but it must stay a light grey, never ink.
  it("dark: white is lighter than brightBlack and brightWhite is the lightest slot", () => {
    const { white, brightWhite } = getDesignTheme("dark").terminal;
    expect(lightness(white)).toBeLessThan(lightness(brightWhite));
  });

  it("light: brightWhite is a grey, not near-black ink", () => {
    const { black, brightWhite, background } = getDesignTheme("light").terminal;
    expect(contrastRatio(brightWhite, background)).toBeLessThan(contrastRatio(black, background) / 2);
  });
});
