/**
 * canvas-hotkeys — the single source of truth for CodeCanvas keyboard bindings.
 *
 * A *chord* is a canonical lowercase string: modifiers in a fixed order (`mod`, `alt`, `shift`)
 * followed by the key, joined by `+`, for example `"mod+k"`, `"mod+alt+arrowright"`, or `"f"`.
 * A modifier used by itself activates on keyup only when no other key participated. Generic legacy
 * bindings use `meta`, `ctrl`, `alt`, or `shift`; recordings retain physical identity when the
 * platform exposes it, for example `meta-left` or `meta-right`.
 *
 * `mod` is the platform primary modifier: it matches metaKey (⌘ on macOS) OR ctrlKey
 * (Ctrl on Windows/Linux), mirroring the existing `event.metaKey || event.ctrlKey` convention
 * across CanvasPage. A chord may be terminal-safe because it carries `mod`, but command-specific
 * dispatch still protects text-editing shortcuts such as Cmd+Delete from destructive canvas actions.
 */

import {
  modifierOnlyBaseForChord,
  modifierOnlyChordsOverlap,
  normalizeChord,
  UNBOUND_CHORD,
  type ChordEventLike,
} from "@/lib/hotkeys/chord";
import { VOICE_HOTKEY_DEFAULTS, type VoiceHotkeyId } from "@/modules/voice-core/voice-hotkeys";
import { toolForShortcut } from "./canvas-tool";

export {
  acquireHotkeyRecordingLease as acquireCanvasHotkeyRecordingLease,
  createModifierOnlyHotkeyTracker,
  isHotkeyRecordingActive as isCanvasHotkeyRecordingActive,
  modifierOnlyChordForEvent,
  modifierOnlyChordForKey,
  normalizeChord,
  UNBOUND_CHORD,
  type ChordEventLike,
  type ModifierKeyEventLike,
  type ModifierOnlyBaseChord,
  type ModifierOnlyChord,
  type ModifierOnlyHotkeyTracker,
  type ModifierSide,
} from "@/lib/hotkeys/chord";

export type CanvasHotkeyCommandId =
  | "focus-dir-left" | "focus-dir-right" | "focus-dir-up" | "focus-dir-down"
  | "cycle-forward" | "cycle-backward"
  | "focus-slot-1" | "focus-slot-2" | "focus-slot-3" | "focus-slot-4" | "focus-slot-5"
  | "focus-slot-6" | "focus-slot-7" | "focus-slot-8" | "focus-slot-9"
  | "frame-go-1" | "frame-go-2" | "frame-go-3" | "frame-go-4" | "frame-go-5" | "frame-go-6" | "frame-go-7" | "frame-go-8" | "frame-go-9"
  | "frame-move-1" | "frame-move-2" | "frame-move-3" | "frame-move-4" | "frame-move-5" | "frame-move-6" | "frame-move-7" | "frame-move-8" | "frame-move-9"
  | "jump-labels" | "jump-needs-you" | "fleet-briefing" | "dive-into-node" | "exit-layer" | "toggle-focus-mode" | "close-node"
  | "session-next" | "session-prev"
  | "arrange"
  | "palette" | "group" | "settings"
  | "toggle-dock" | "widen-dock"
  | "focus-command-bar"
  | "voice-command" | "voice-dictate"
  | "app-voice-push-to-talk" | "app-voice-live";

export type CanvasHotkeyGroup = "navigation" | "layers" | "voice" | "app-voice" | "general";

export interface CanvasHotkeyCommand {
  id: CanvasHotkeyCommandId;
  /** Human-facing command name shown in the editor. */
  title: string;
  group: CanvasHotkeyGroup;
  /** Default chord (canonical). */
  defaultChord: string;
  /** Reserved bindings can't be remapped in the editor (structural keys). */
  fixed?: boolean;
}

const slotCommands = ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => ({
  id: `focus-slot-${n}` as CanvasHotkeyCommandId,
  title: `Focus node in slot ${n}`,
  group: "navigation" as const,
  defaultChord: `mod+${n}`,
}));

// Frame Switcher (LOT2-124): chip N flies the camera to Frame N; the shifted chord sends the
// current selection into it.
const frameGoCommands = ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => ({
  id: `frame-go-${n}` as CanvasHotkeyCommandId,
  title: `Go to Frame ${n}`,
  group: "navigation" as const,
  defaultChord: `alt+${n}`,
}));
const frameMoveCommands = ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => ({
  id: `frame-move-${n}` as CanvasHotkeyCommandId,
  title: `Move selection into Frame ${n}`,
  group: "navigation" as const,
  defaultChord: `alt+shift+${n}`,
}));

/** The registry: one entry per canvas-layer command. Order drives the editor layout. */
export const CANVAS_HOTKEY_COMMANDS: readonly CanvasHotkeyCommand[] = [
  { id: "focus-dir-left", title: "Focus nearest node — left", group: "navigation", defaultChord: "mod+alt+arrowleft", fixed: true },
  { id: "focus-dir-right", title: "Focus nearest node — right", group: "navigation", defaultChord: "mod+alt+arrowright", fixed: true },
  { id: "focus-dir-up", title: "Focus nearest node — up", group: "navigation", defaultChord: "mod+alt+arrowup", fixed: true },
  { id: "focus-dir-down", title: "Focus nearest node — down", group: "navigation", defaultChord: "mod+alt+arrowdown", fixed: true },
  { id: "cycle-forward", title: "Cycle focus (most-recent)", group: "navigation", defaultChord: "mod+`" },
  { id: "cycle-backward", title: "Cycle focus backward", group: "navigation", defaultChord: "mod+shift+`" },
  ...slotCommands,
  ...frameGoCommands,
  ...frameMoveCommands,
  { id: "jump-labels", title: "Jump labels (type-to-focus)", group: "navigation", defaultChord: "f" },
  // Walks the needs-you queue, oldest ask first (plans/honest-agent-status/ Slice 5). Remappable on
  // purpose — unlike escape or mod+K this chord carries no structural meaning for the canvas, and
  // the lane header advertises whichever chord is actually bound rather than a hardcoded "⌘J".
  // Unbound by default since ⌘J became the window-wide Jump palette (GLOSSARY); a user's own chord stays.
  { id: "jump-needs-you", title: "Jump to the agent that needs you", group: "navigation", defaultChord: UNBOUND_CHORD },
  // Reveal every agent's headline at once, whatever the zoom (plans/agent-headlines/ follow-on).
  // CNVS binds this to plain F; here that key is `jump-labels` (type-to-focus), which the canvas has
  // had far longer, so this takes shift+F rather than stealing it.
  { id: "fleet-briefing", title: "Reveal all agent headlines", group: "navigation", defaultChord: "shift+f" },
  { id: "dive-into-node", title: "Dive into focused node", group: "layers", defaultChord: "enter" },
  { id: "exit-layer", title: "Pop out / exit", group: "layers", defaultChord: "escape", fixed: true },
  { id: "toggle-focus-mode", title: "Toggle focus mode", group: "layers", defaultChord: "mod+." },
  { id: "close-node", title: "Close focused node", group: "layers", defaultChord: "mod+backspace" },
  // Move between the focused node's own conversations without opening anything
  // (`plans/codecanvas-session-widget/`, Slice 04). Remappable: the chord carries no structural
  // meaning, and alt+arrow is free here because the DIRECTIONAL focus commands take mod+alt+arrow.
  { id: "session-prev", title: "Previous session on this node", group: "layers", defaultChord: "alt+arrowup" },
  { id: "session-next", title: "Next session on this node", group: "layers", defaultChord: "alt+arrowdown" },
  { id: "arrange", title: "Auto-arrange canvas", group: "layers", defaultChord: "mod+shift+a" },
  { id: "voice-command", title: "Voice: force Command", group: "voice", defaultChord: "mod+shift+v" },
  { id: "voice-dictate", title: "Voice: force Dictate", group: "voice", defaultChord: "mod+shift+d" },
  // App-level voice keys (Voice Core): listed here so one editor shows every chord and catches
  // conflicts, but stored in the app voice key and handled in every mode, not by the canvas layer.
  { id: "app-voice-push-to-talk", title: "Push-to-Talk", group: "app-voice", defaultChord: VOICE_HOTKEY_DEFAULTS["push-to-talk"] },
  { id: "app-voice-live", title: "Live Voice on / off", group: "app-voice", defaultChord: VOICE_HOTKEY_DEFAULTS["live-voice"] },
  { id: "palette", title: "Command palette", group: "general", defaultChord: "mod+k", fixed: true },
  { id: "group", title: "Group selection", group: "general", defaultChord: "mod+g", fixed: true },
  { id: "settings", title: "Lotus Settings", group: "general", defaultChord: "mod+,", fixed: true },
  // The one Dock button (plans/canvas-dock/, revised 2026-10-16). ⌘B is free on /canvas — AppShell
  // takes it only where its sidebar shows — but it is Bold in a Note, so a text editor keeps it
  // (see TEXT_EDITOR_OWNED_COMMANDS). A focused terminal does not type with ⌘B, so it opens there.
  { id: "toggle-dock", title: "Show or hide the Dock", group: "general", defaultChord: "mod+b" },
  { id: "widen-dock", title: "Widen or narrow the Dock", group: "general", defaultChord: "mod+\\" },
  // Dedicated trigger for the NL command bar (plans/nl-type-to-focus/PLAN.md §2) — remappable, unlike
  // the structural commands above, since the chord is not load-bearing for the rest of the canvas.
  //
  // There was a second entry here, `focus-command-bar-alt` on `space`, and it broke canvas panning:
  // `space` is ReactFlow's `panActivationKeyCode` default, which is what lets a LEFT drag pan whatever
  // tool is active. Claiming it moved focus into the NL input, and from there ReactFlow's `useKeyPress`
  // bails out on `isInputDOMNode`, so Space stopped arming pan entirely. `/` already does this job, so
  // the alternate was deleted rather than rebound. Do not reintroduce a `space` binding — the
  // "reserved keys the canvas must not claim" test in canvas-hotkeys.test.ts guards it.
  { id: "focus-command-bar", title: "Focus command bar", group: "general", defaultChord: "/" },
];

/**
 * Sentinel override meaning "explicitly unbound" — the command keeps its slot in the editor but no
 * keystroke triggers it. Used when a chord is reassigned away from its previous owner.
 */

/** User overrides: command id → chord. Absent keys fall back to the default. */
export type CanvasHotkeyOverrides = Partial<Record<CanvasHotkeyCommandId, string>>;

/** The effective chord for each command, defaults overlaid with overrides. */
export function effectiveBindings(overrides: CanvasHotkeyOverrides): Record<CanvasHotkeyCommandId, string> {
  const out = {} as Record<CanvasHotkeyCommandId, string>;
  for (const cmd of CANVAS_HOTKEY_COMMANDS) {
    out[cmd.id] = overrides[cmd.id] ?? cmd.defaultChord;
  }
  return out;
}

export type CanvasHotkeyPlatform = "mac" | "other";

const KEY_GLYPHS: Record<string, string> = {
  arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓",
  enter: "↵", escape: "Esc", backspace: "⌫", space: "Space", "`": "`",
};

/** Render a canonical chord into display keycap tokens for the given platform. */
/**
 * Which modifier glyphs to print. `mac` when it cannot tell — the glyphs are the denser, more
 * common case here, and guessing `other` would print "Ctrl" on the machine this app is developed on.
 *
 * `HotkeysTab` still carries an identical private copy; it predates this and is left alone rather
 * than refactored from a concurrent branch. Worth collapsing into this one next time that file is
 * open for its own reasons.
 */
export function detectCanvasHotkeyPlatform(): CanvasHotkeyPlatform {
  if (typeof navigator === "undefined") return "mac";
  return /mac|iphone|ipad|ipod/i.test(navigator.platform) ? "mac" : "other";
}

export function formatChord(chord: string, platform: CanvasHotkeyPlatform): string[] {
  const tokens = chord.split("+");
  return tokens.map((token) => {
    if (token === "mod") return platform === "mac" ? "⌘" : "Ctrl";
    const modifierBase = modifierOnlyBaseForChord(token);
    if (modifierBase) {
      const label = modifierBase === "meta"
        ? platform === "mac" ? "⌘" : "Meta"
        : modifierBase === "ctrl"
          ? platform === "mac" ? "⌃" : "Ctrl"
          : modifierBase === "alt"
            ? platform === "mac" ? "⌥" : "Alt"
            : platform === "mac" ? "⇧" : "Shift";
      if (token.endsWith("-left")) return `Left ${label}`;
      if (token.endsWith("-right")) return `Right ${label}`;
      return tokens.length === 1 ? `Any ${label}` : label;
    }
    if (KEY_GLYPHS[token]) return KEY_GLYPHS[token];
    if (/^f(?:[1-9]|1\d|2[0-4])$/.test(token)) return token.toUpperCase();
    return token.length === 1 ? token.toUpperCase() : token;
  });
}

const EDITING_OWNED_COMMANDS = new Set<CanvasHotkeyCommandId>([
  "close-node",
]);

/** Commands whose chord is a formatting key in a text editor (⌘B is Bold), but not in a terminal. */
const TEXT_EDITOR_OWNED_COMMANDS = new Set<CanvasHotkeyCommandId>([
  "toggle-dock",
]);

const GLOBAL_HOTKEY_COMMANDS = new Set<CanvasHotkeyCommandId>([
  "voice-command",
  "voice-dictate",
  "app-voice-push-to-talk",
  "app-voice-live",
]);

/** Registry ids that are app-level voice hotkeys, mapped to their Voice Core id. */
export const APP_VOICE_HOTKEY_IDS: Partial<Record<CanvasHotkeyCommandId, VoiceHotkeyId>> = {
  "app-voice-push-to-talk": "push-to-talk",
  "app-voice-live": "live-voice",
};

/** Commands that intentionally override focused editors and terminals after explicit user binding. */
export function isGlobalCanvasHotkeyCommand(command: CanvasHotkeyCommandId): boolean {
  return GLOBAL_HOTKEY_COMMANDS.has(command);
}

/** Whether a global chord replaces a normal typing/editing key rather than a function/modifier chord. */
export function doesGlobalChordReplaceTyping(chord: string): boolean {
  const parts = chord.split("+");
  const key = parts[parts.length - 1];
  if (modifierOnlyBaseForChord(chord)) return false;
  if (parts.includes("mod") || parts.includes("alt")) return false;
  return !/^f(?:[1-9]|1\d|2[0-4])$/.test(key);
}

/** Structural keys that always reach the canvas regardless of terminal focus. */
const CROSS_LAYER_KEYS = new Set(["escape", "enter"]);

/**
 * A chord is structurally terminal-safe iff a focused terminal would NOT swallow it — i.e. it
 * carries `mod`, or it is a structural cross-layer key (Esc/Enter) the app intercepts before the PTY.
 * Command-specific policy can still mark a structurally-safe chord as canvas-layer-only.
 */
export function isChordTerminalSafe(chord: string): boolean {
  if (chord.startsWith("mod+") || chord === "mod" || modifierOnlyBaseForChord(chord)) return true;
  return CROSS_LAYER_KEYS.has(chord);
}

export function isCommandChordTerminalSafe(command: CanvasHotkeyCommandId, chord: string): boolean {
  if (isGlobalCanvasHotkeyCommand(command)) return true;
  if (EDITING_OWNED_COMMANDS.has(command)) return false;
  return isChordTerminalSafe(chord);
}

/** The command currently bound to `chord`, excluding `selfId`, or null if the chord is free. */
export function findChordConflict(
  chord: string,
  selfId: CanvasHotkeyCommandId,
  overrides: CanvasHotkeyOverrides,
): CanvasHotkeyCommandId | null {
  const bindings = effectiveBindings(overrides);
  for (const cmd of CANVAS_HOTKEY_COMMANDS) {
    if (cmd.id === selfId) continue;
    if (bindings[cmd.id] === chord || modifierOnlyChordsOverlap(bindings[cmd.id], chord)) return cmd.id;
  }
  return null;
}

/**
 * The whiteboard tool a chord would ALSO switch to, or null if it's clear of that collision.
 *
 * `toolForShortcut` (canvas-tool.ts) fires from its own `window` listener, entirely outside this
 * registry, so `findChordConflict` above can never see it — the editor would otherwise happily let
 * someone bind a command onto `r` and have both the command AND the rectangle tool fire on every press.
 * Reading the collision straight out of the real `toolForShortcut` map — never a hand-copied letter
 * list — is what stops the two from silently drifting apart, which is exactly how the original
 * ten-letter collision got missed (plans/nl-type-to-focus/PLAN.md §0/§1).
 *
 * Only a BARE key (no `mod`/`alt`) collides: `mod+r` and `alt+r` never reach the tool listener.
 * `shift+r` does collide — `toolForShortcut` lowercases the key before matching, so Shift+R still
 * arms the rectangle tool.
 */
export function findToolShortcutConflict(chord: string): string | null {
  const parts = chord.split("+");
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (modifiers.includes("mod") || modifiers.includes("alt")) return null;
  return toolForShortcut(key);
}

/** What the keydown target is, for the dispatch gate. */
export interface HotkeyTargetInfo {
  /** Inside an input/textarea/contenteditable/terminal — i.e. something typing into. */
  editable: boolean;
  /** Inside an xterm terminal, which owns keys like Esc itself. */
  terminal: boolean;
  /** Inside a Monaco editor (the Dock's Code app), which owns every chord but the Dock's and every Esc. */
  codeEditor?: boolean;
  /** Monaco has find, suggest, hover, parameter hints or rename open. */
  editorWidgetOpen?: boolean;
}

/**
 * Whether a resolved chord should fire given the focus target. Mod chords fire everywhere (a
 * focused terminal doesn't swallow them). Escape is the cross-layer exit: it leaves any non-terminal
 * control (canvas or a note/input) but is never stolen from a terminal. All other bare keys —
 * including Enter — belong to the focused editable control while typing.
 */
export function shouldDispatchCanvasHotkey(chord: string, target: HotkeyTargetInfo): boolean {
  // Esc in Monaco drops multi-cursor and selection, or closes its widgets: never a canvas layer.
  if (chord === "escape" && target.codeEditor) return false;
  if (chord.startsWith("mod+") || chord === "mod" || modifierOnlyBaseForChord(chord)) return true;
  if (chord === "escape") return !target.terminal;
  return !target.editable;
}

/**
 * Whether a resolved command should fire for this target. Some modifier chords are text-editing
 * primitives in terminals/editors (Cmd+Backspace/Delete), so destructive node commands must stay
 * canvas-only even if their chord is otherwise a valid global modifier chord.
 */
export function shouldDispatchCanvasHotkeyCommand(
  command: CanvasHotkeyCommandId,
  chord: string,
  target: HotkeyTargetInfo,
): boolean {
  if (isGlobalCanvasHotkeyCommand(command)) return true;
  // In Code the editor owns every chord (⌘K is its chord prefix, ⌘G find next, ⌥⌘↑ add cursor, ⌘. quick
  // fix) except the Dock's own: Monaco has no ⌘B Bold, and the Dock must stay closable from the editor.
  if (target.codeEditor && !target.terminal) {
    return command === "toggle-dock" || command === "widen-dock";
  }
  if (EDITING_OWNED_COMMANDS.has(command) && (target.editable || target.terminal)) return false;
  if (TEXT_EDITOR_OWNED_COMMANDS.has(command) && target.editable && !target.terminal) return false;
  return shouldDispatchCanvasHotkey(chord, target);
}

/** Resolve a canonical chord to the command it triggers, or null. */
export function resolveHotkeyCommandFromChord(
  chord: string,
  overrides: CanvasHotkeyOverrides,
): CanvasHotkeyCommandId | null {
  const bindings = effectiveBindings(overrides);
  // Exact physical-side bindings win over generic legacy bindings regardless of registry order.
  for (const cmd of CANVAS_HOTKEY_COMMANDS) {
    if (bindings[cmd.id] !== UNBOUND_CHORD && bindings[cmd.id] === chord) return cmd.id;
  }
  const base = modifierOnlyBaseForChord(chord);
  if (!base || chord === base) return null;
  for (const cmd of CANVAS_HOTKEY_COMMANDS) {
    if (bindings[cmd.id] === base) return cmd.id;
  }
  return null;
}

/** Resolve a keyboard event to the command it triggers, or null. */
export function resolveHotkeyCommand(
  event: ChordEventLike,
  overrides: CanvasHotkeyOverrides,
): CanvasHotkeyCommandId | null {
  return resolveHotkeyCommandFromChord(normalizeChord(event), overrides);
}
