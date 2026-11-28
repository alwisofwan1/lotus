/**
 * Shortcut labels as THIS machine's keyboard writes them.
 *
 * Labels across the app are authored once, in macOS glyphs (`"⌘K"`, `"⇧⌘G"`, `"⌘↵"`), because
 * that is the dense, familiar form. On macOS they print unchanged. Everywhere else they become the
 * Windows convention — named modifiers in Ctrl, Alt, Shift order, joined by `+` — so nobody on
 * Windows is told to press a key their keyboard does not have.
 *
 * For a canonical chord string (`"mod+shift+k"`, the hotkey registry's form) use the canvas
 * registry's `formatChord` instead; this one is for hand-written labels.
 */

import { isMacPlatform, readPlatformString } from "@/lib/platform";

type ModifierName = "Ctrl" | "Alt" | "Shift";

/** ⌘ and ⌃ both become Ctrl: on Windows the primary modifier IS Ctrl. */
const MODIFIER_GLYPHS: Record<string, ModifierName> = { "⌘": "Ctrl", "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift" };
const MODIFIER_ORDER: readonly ModifierName[] = ["Ctrl", "Alt", "Shift"];
const MODIFIER_RUN = /([⌘⌃⌥⇧]+)(\s*)/g;

const KEY_GLYPHS: Record<string, string> = {
  "⌫": "Backspace",
  "⌦": "Delete",
  "↵": "Enter",
  "⏎": "Enter",
  "↩": "Enter",
  "⎋": "Esc",
  "⇥": "Tab",
};
const KEY_GLYPH_PATTERN = new RegExp(`[${Object.keys(KEY_GLYPHS).join("")}]`, "g");

/**
 * Whether a modifier run stands on its own rather than leading a key: "Hold ⌘ to select",
 * "⌘-click", "(⌘)". A key after a modifier is a capital, a digit, a symbol or a key glyph;
 * running prose after it is a lowercase word.
 */
function isStandaloneModifier(space: string, rest: string): boolean {
  if (rest === "" || /^[\s).,;:]/.test(rest)) return true;
  if (/^-[a-z]/i.test(rest)) return true;
  return space.length > 0 && /^[a-z]{2,}/.test(rest);
}

function modifierRunLabel(match: string, run: string, space: string, offset: number, whole: string): string {
  const held = new Set<ModifierName>();
  for (const glyph of run) held.add(MODIFIER_GLYPHS[glyph]);
  const names = MODIFIER_ORDER.filter((name) => held.has(name)).join("+");
  const rest = whole.slice(offset + match.length);
  return isStandaloneModifier(space, rest) ? `${names}${space}` : `${names}+`;
}

/** `"⇧⌘G"` → `"Ctrl+Shift+G"` off macOS; unchanged on macOS. Works inside running text. */
export function formatShortcut(chord: string, platform: string = readPlatformString()): string {
  if (isMacPlatform(platform)) return chord;
  return chord
    .replace(MODIFIER_RUN, modifierRunLabel)
    .replace(KEY_GLYPH_PATTERN, (glyph) => KEY_GLYPHS[glyph]);
}

/** The `aria-keyshortcuts` value for a glyph label: `"⌘L"` → `"Meta+L"` / `"Control+L"`. */
export function ariaKeyShortcuts(chord: string, platform: string = readPlatformString()): string {
  const mac = isMacPlatform(platform);
  const aria: Record<ModifierName | "Meta", string> = { Ctrl: "Control", Alt: "Alt", Shift: "Shift", Meta: "Meta" };
  const parts: string[] = [];
  let rest = chord.trim();
  while (rest && MODIFIER_GLYPHS[rest[0]]) {
    const glyph = rest[0];
    const name = glyph === "⌘" && mac ? "Meta" : MODIFIER_GLYPHS[glyph];
    if (!parts.includes(aria[name])) parts.push(aria[name]);
    rest = rest.slice(1).trim();
  }
  const key = rest.replace(KEY_GLYPH_PATTERN, (glyph) => KEY_GLYPHS[glyph]);
  return [...parts, key === "Esc" ? "Escape" : key].join("+");
}
