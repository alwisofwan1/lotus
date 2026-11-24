// Keep JetBrains Mono as the primary terminal face so normal text and ANSI
// block art use the same metrics as Terax. Nerd Fonts are fallbacks only for
// private-use prompt icons.

const NERD_FONT_CANDIDATES = [
  "JetBrainsMono Nerd Font",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMonoNL Nerd Font",
  "FiraCode Nerd Font",
  "FiraCode Nerd Font Mono",
  "MesloLGS NF",
  "MesloLGM Nerd Font",
  "Hack Nerd Font",
  "Hack Nerd Font Mono",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaMono Nerd Font",
  "Iosevka Nerd Font",
  "Iosevka Term Nerd Font",
  "SauceCodePro Nerd Font",
  "Hasklug Nerd Font",
];

const PRIMARY_FONT = '"JetBrains Mono"';
const FALLBACK_CHAIN = [
  '"Fira Code"',
  '"Cascadia Code"',
  "SFMono-Regular",
  "Menlo",
  "Monaco",
  '"Atkinson Hyperlegible Mono Variable"',
  "monospace",
];

let detected: string | null = null;

export function detectMonoFontFamily(): string {
  if (detected) return detected;
  if (typeof document === "undefined" || !document.fonts) {
    detected = [PRIMARY_FONT, ...FALLBACK_CHAIN].join(", ");
    return detected;
  }

  const fallbackFonts: string[] = [];
  for (const f of NERD_FONT_CANDIDATES) {
    try {
      if (document.fonts.check(`12px "${f}"`)) {
        fallbackFonts.push(`"${f}"`);
      }
    } catch {
      // document.fonts.check() can throw on some browsers with unusual input.
    }
  }
  detected = [PRIMARY_FONT, ...fallbackFonts, ...FALLBACK_CHAIN].join(", ");
  return detected;
}
