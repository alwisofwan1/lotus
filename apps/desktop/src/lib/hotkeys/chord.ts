/**
 * Keyboard chords — the canonical string form of a key press, shared by every hotkey layer (the
 * canvas registry, the app-level voice hotkeys). Moved out of `codecanvas/services/canvas-hotkeys.ts`
 * unchanged so mode-neutral code can match chords without importing a mode.
 *
 * A *chord* is a canonical lowercase string: modifiers in a fixed order (`mod`, `alt`, `shift`)
 * followed by the key, joined by `+`, for example `"mod+k"`, `"mod+alt+arrowright"`, or `"f"`.
 * A modifier used by itself activates on keyup only when no other key participated.
 */

/** A binding no key press triggers. */
export const UNBOUND_CHORD = "unbound";

/** The subset of a KeyboardEvent the chord logic reads. */
export interface ChordEventLike {
  key: string;
  /** Physical key. Read only for Option+digit, where `key` is a symbol on macOS (⌥1 -> "¡"). */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

function normalizeKey(key: string): string {
  if (key === " ") return "space";
  return key.toLowerCase();
}

export type ModifierOnlyBaseChord = "meta" | "ctrl" | "alt" | "shift";
export type ModifierSide = "left" | "right";
export type ModifierOnlyChord = ModifierOnlyBaseChord | `${ModifierOnlyBaseChord}-${ModifierSide}`;

export interface ModifierKeyEventLike {
  key: string;
  code?: string;
  location?: number;
}

/** Logical modifier token used when physical side information is unavailable. */
export function modifierOnlyChordForKey(key: string): ModifierOnlyBaseChord | null {
  if (key === "Meta" || key === "OS") return "meta";
  if (key === "Control") return "ctrl";
  if (key === "Alt") return "alt";
  if (key === "Shift") return "shift";
  return null;
}

function modifierSideForEvent(event: ModifierKeyEventLike, base: ModifierOnlyBaseChord): ModifierSide | null {
  const expectedCode = base === "meta" ? "Meta" : base === "ctrl" ? "Control" : base === "alt" ? "Alt" : "Shift";
  if (event.code === `${expectedCode}Left`) return "left";
  if (event.code === `${expectedCode}Right`) return "right";
  // KeyboardEvent.location is the production fallback for webviews that omit a standard `code`.
  if (event.location === 1) return "left";
  if (event.location === 2) return "right";
  return null;
}

/** Modifier-only chord with physical side retained whenever the webview reports it. */
export function modifierOnlyChordForEvent(event: ModifierKeyEventLike): ModifierOnlyChord | null {
  const base = modifierOnlyChordForKey(event.key);
  if (!base) return null;
  const side = modifierSideForEvent(event, base);
  return side ? `${base}-${side}` : base;
}

export function modifierOnlyBaseForChord(chord: string): ModifierOnlyBaseChord | null {
  const base = chord.replace(/-(?:left|right)$/, "");
  return base === "meta" || base === "ctrl" || base === "alt" || base === "shift" ? base : null;
}

export function modifierOnlyChordsOverlap(first: string, second: string): boolean {
  const firstBase = modifierOnlyBaseForChord(first);
  const secondBase = modifierOnlyBaseForChord(second);
  if (!firstBase || firstBase !== secondBase) return false;
  return first === firstBase || second === secondBase || first === second;
}

let activeRecordingLeases = 0;

/**
 * Suspend runtime hotkey dispatch while a binding editor owns keyboard input. A reference-counted
 * lease stays safe across Strict Mode effect replay or multiple settings surfaces.
 */
export function acquireHotkeyRecordingLease(): () => void {
  activeRecordingLeases += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRecordingLeases = Math.max(0, activeRecordingLeases - 1);
  };
}

export function isHotkeyRecordingActive(): boolean {
  return activeRecordingLeases > 0;
}

export interface ModifierOnlyHotkeyTracker {
  keyDown: (event: ModifierKeyEventLike) => void;
  keyUp: (event: ModifierKeyEventLike) => ModifierOnlyChord | null;
  reset: () => void;
}

/**
 * Defers a standalone modifier until keyup and cancels it when another key participates. Physical
 * sides stay separate, so Right Command can be a voice key without stealing Left Command. Generic
 * events are reconciled only when exactly one matching modifier is held; ambiguous releases fail
 * closed instead of firing the wrong side.
 */
export function createModifierOnlyHotkeyTracker(): ModifierOnlyHotkeyTracker {
  const held = new Set<ModifierOnlyChord>();
  const sequence = new Set<ModifierOnlyChord>();
  let usedWithAnotherKey = false;

  const reset = () => {
    held.clear();
    sequence.clear();
    usedWithAnotherKey = false;
  };

  return {
    keyDown(event) {
      const modifier = modifierOnlyChordForEvent(event);
      if (modifier) {
        held.add(modifier);
        sequence.add(modifier);
      } else if (held.size > 0) {
        usedWithAnotherKey = true;
      }
    },
    keyUp(event) {
      const reported = modifierOnlyChordForEvent(event);
      if (!reported) return null;
      let released = reported;
      if (!sequence.has(released)) {
        const base = modifierOnlyBaseForChord(reported);
        const candidates = [...held].filter((modifier) => modifierOnlyBaseForChord(modifier) === base);
        if (reported === base && candidates.length === 1) {
          [released] = candidates;
        } else if (base && held.has(base)) {
          released = base;
        } else {
          // A side-specific mismatch is never guessed. Triggering the wrong voice mode is worse than
          // dropping one malformed key sequence, and blur/reset makes the next press recover cleanly.
          reset();
          return null;
        }
      }
      held.delete(released);
      if (held.size > 0) return null;
      const chord = !usedWithAnotherKey && sequence.size === 1
        ? sequence.values().next().value as ModifierOnlyChord
        : null;
      reset();
      return chord;
    },
    reset,
  };
}

/** Turn a keyboard event into its canonical chord string. */
export function normalizeChord(event: ChordEventLike): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  const digit = event.altKey ? /^Digit([0-9])$/.exec(event.code ?? "") : null;
  // ⌥Space (and ⌥⇧Space) types a non-breaking space on macOS, so `key` is U+00A0, not " ".
  const space = event.altKey && event.code === "Space";
  parts.push(digit ? digit[1] : space ? "space" : normalizeKey(event.key));
  return parts.join("+");
}
