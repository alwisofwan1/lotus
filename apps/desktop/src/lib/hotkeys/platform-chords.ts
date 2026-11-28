/**
 * Which chords belong to the platform, and which the app may take.
 *
 * On macOS the app's shortcuts live on ⌘, a key no terminal and no text field spends on anything,
 * so "a `mod` chord fires everywhere" was a safe rule. On Windows and Linux the same `mod` is Ctrl,
 * and Ctrl is exactly what a terminal turns into control characters (Ctrl+K kill-line, Ctrl+B
 * back-char, Ctrl+\ SIGQUIT) and what a text field uses for editing (Ctrl+Z, Ctrl+Y, Ctrl+Shift+V).
 * Every app-level listener that claims a `mod` chord asks `surfaceOwnsChord` first, so the focused
 * surface keeps what Windows users expect it to keep.
 *
 * The rule is Windows Terminal's and VS Code's: plain Ctrl+letter belongs to the terminal, and the
 * app's own commands live on Ctrl+Shift, Ctrl+digit, Ctrl+punctuation or Ctrl+Alt+arrow.
 *
 * macOS answers `false` everywhere, by construction: nothing in this file changes a Mac.
 */

import { isMacPlatform, readPlatformString } from "@/lib/platform";

/** The subset of a KeyboardEvent the platform-chord logic reads. */
export interface PlatformChordEventLike {
  key: string;
  /** Physical key, used only to recognise a letter on a non-Latin layout. */
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Where the keyboard is when a chord arrives. */
export type KeyboardSurface = "terminal" | "text" | "none";

/**
 * The Latin letter a chord names, or null. `key` first, so Dvorak and AZERTY users get the letter
 * printed on their key; `code` as the fallback, so Ctrl+C still means copy on a Cyrillic layout,
 * where `key` is "с".
 */
export function chordLetter(event: Pick<PlatformChordEventLike, "key" | "code">): string | null {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  const physical = /^Key([A-Z])$/.exec(event.code ?? "");
  return physical ? physical[1].toLowerCase() : null;
}

/** ⌘ on macOS, Ctrl everywhere else — and never both, so ⌘ and Ctrl chords stay distinct. */
export function hasPrimaryModifier(
  event: Pick<PlatformChordEventLike, "ctrlKey" | "metaKey">,
  platform: string = readPlatformString(),
): boolean {
  return isMacPlatform(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Ctrl without ⌘/Win and without Alt. Ctrl+Alt is excluded on purpose: on most European Windows
 * layouts AltGr arrives as Ctrl+Alt, and AltGr+Q is how a German keyboard types "@".
 */
function isPlainCtrl(event: PlatformChordEventLike): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * Non-letter keys xterm turns into a control character under Ctrl: Ctrl+[ is ESC, Ctrl+\ is FS
 * (SIGQUIT), Ctrl+] GS, Ctrl+Space and Ctrl+@ NUL, Ctrl+_ US (readline undo). Digits also map to
 * control characters in xterm, but nothing uses them, and Ctrl+1..9 is how panes are reached —
 * so digits stay with the app.
 */
const TERMINAL_CONTROL_KEYS = new Set(["[", "\\", "]", " ", "@", "_"]);

/** The clipboard pair a terminal answers on Ctrl+Shift, because plain Ctrl+C is SIGINT. */
const TERMINAL_CLIPBOARD_LETTERS = new Set(["c", "v"]);

/**
 * A chord a focused terminal owns on Windows and Linux: every plain Ctrl+letter (a control
 * character the shell or the agent CLI reads), the Ctrl punctuation that also encodes one, and
 * Ctrl+Shift+C / Ctrl+Shift+V (copy and paste). Ctrl+Shift+<other letter> stays with the app —
 * xterm sends nothing for it.
 */
export function isTerminalOwnedChord(
  event: PlatformChordEventLike,
  platform: string = readPlatformString(),
): boolean {
  if (isMacPlatform(platform) || !isPlainCtrl(event)) return false;
  const letter = chordLetter(event);
  if (letter) return !event.shiftKey || TERMINAL_CLIPBOARD_LETTERS.has(letter);
  return TERMINAL_CONTROL_KEYS.has(event.key);
}

/**
 * Ctrl+Y, the Windows redo, which every app there answers alongside Ctrl+Shift+Z. On macOS ⌘Y is
 * not redo (it is History in browsers), so this is false there.
 */
export function isRedoAliasChord(
  event: PlatformChordEventLike,
  platform: string = readPlatformString(),
): boolean {
  return !isMacPlatform(platform) && isPlainCtrl(event) && !event.shiftKey && chordLetter(event) === "y";
}

/** Ctrl+letter edits every Windows text field answers to. */
const TEXT_EDITING_LETTERS = new Set(["a", "c", "v", "x", "z", "y"]);
/** Shifted: Ctrl+Shift+Z is redo, Ctrl+Shift+V paste as plain text. */
const TEXT_EDITING_SHIFTED_LETTERS = new Set(["z", "v"]);
/** Ctrl+Backspace/Delete delete a word; Ctrl+arrows (with Shift: select) move by word. */
const TEXT_EDITING_KEYS = new Set(["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End"]);

/** A chord a focused text field owns on Windows and Linux: the standard editing set. */
export function isTextEditingOwnedChord(
  event: PlatformChordEventLike,
  platform: string = readPlatformString(),
): boolean {
  if (isMacPlatform(platform) || !isPlainCtrl(event)) return false;
  const letter = chordLetter(event);
  if (letter) {
    return event.shiftKey ? TEXT_EDITING_SHIFTED_LETTERS.has(letter) : TEXT_EDITING_LETTERS.has(letter);
  }
  return TEXT_EDITING_KEYS.has(event.key);
}

/**
 * Whether the focused surface keeps this chord instead of an app shortcut. App listeners ask this
 * before claiming a `mod` chord; on macOS it is always false.
 */
export function surfaceOwnsChord(
  event: PlatformChordEventLike,
  surface: KeyboardSurface,
  platform: string = readPlatformString(),
): boolean {
  if (surface === "terminal") return isTerminalOwnedChord(event, platform);
  if (surface === "text") return isTextEditingOwnedChord(event, platform);
  return false;
}

const TEXT_SURFACE_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

/**
 * What kind of surface an event target is. A terminal first: xterm's input is itself a textarea,
 * and it must read as a terminal, not a text field.
 */
export function keyboardSurfaceOf(target: EventTarget | null): KeyboardSurface {
  if (typeof Element === "undefined" || !(target instanceof Element)) return "none";
  if (target.closest(".xterm")) return "terminal";
  if (target instanceof HTMLElement && target.isContentEditable) return "text";
  return target.closest(TEXT_SURFACE_SELECTOR) ? "text" : "none";
}

/** `surfaceOwnsChord` for a live event, reading the surface from its target. */
export function focusedSurfaceOwnsChord(
  event: PlatformChordEventLike & { target: EventTarget | null },
  platform: string = readPlatformString(),
): boolean {
  return surfaceOwnsChord(event, keyboardSurfaceOf(event.target), platform);
}
