/**
 * Keyboard shortcuts for the shell.
 *
 * Kept as predicates over a KeyboardEvent rather than a table of strings so the platform
 * difference — ⌘ on macOS, Ctrl everywhere else — is answered once, here, instead of at every
 * handler that has to ask.
 */

export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** macOS uses ⌘; Windows and Linux use Ctrl. */
export function hasPrimaryModifier(event: ShortcutEvent, platform: string = navigator.platform): boolean {
  const isMac = /mac|iphone|ipad/i.test(platform);
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function isSplitRightShortcut(event: ShortcutEvent, platform?: string): boolean {
  return (
    event.key.toLowerCase() === "d" &&
    !event.shiftKey &&
    !event.altKey &&
    hasPrimaryModifier(event, platform)
  );
}

export function isSplitDownShortcut(event: ShortcutEvent, platform?: string): boolean {
  return (
    event.key.toLowerCase() === "d" &&
    event.shiftKey &&
    !event.altKey &&
    hasPrimaryModifier(event, platform)
  );
}

/**
 * Close the focused pane.
 *
 * ⌘W on macOS, Ctrl+W elsewhere. The window's own close is ⌘⇧W once a pane owns ⌘W — the same
 * trade every terminal app makes, because closing a pane is the thing you do fifty times a day
 * and closing the window is the thing you do once.
 */
export function isClosePaneShortcut(event: ShortcutEvent, platform?: string): boolean {
  return (
    event.key.toLowerCase() === "w" &&
    !event.shiftKey &&
    !event.altKey &&
    hasPrimaryModifier(event, platform)
  );
}

/**
 * Collapse or restore the rail.
 *
 * ⌘B is what the rest of Lotus already uses for a sidebar, and AppShell binds it globally in the
 * CAPTURE phase. On the routes where its own sidebar is hidden — this shell among them — that
 * binding swallowed the key for a sidebar nobody can see, so the shell has to be allowed to hear
 * it. See `AppShell.tsx`, where the guard lives.
 */
export function isToggleRailShortcut(event: ShortcutEvent, platform?: string): boolean {
  return (
    event.key.toLowerCase() === "b" &&
    !event.shiftKey &&
    !event.altKey &&
    hasPrimaryModifier(event, platform)
  );
}

/** ⌘J opens the Jump palette. Only ⌘ on a Mac: Ctrl+J is a newline in the terminal and in Claude Code. */
export function isJumpPaletteShortcut(event: ShortcutEvent, platform?: string): boolean {
  return event.key.toLowerCase() === "j" && !event.shiftKey && !event.altKey && hasPrimaryModifier(event, platform);
}

/** ⌘⇧J: straight to what has waited longest in Needs you, without opening the palette. */
export function isOldestNeedsYouShortcut(event: ShortcutEvent, platform?: string): boolean {
  return event.key.toLowerCase() === "j" && event.shiftKey && !event.altKey && hasPrimaryModifier(event, platform);
}

/**
 * Opening a pane from the keyboard.
 *
 * The add-pane menu has always PRINTED these — ⌘T, ⌘⇧T, ⌘E, ⌘J — next to each row; none of them
 * existed, and the one that did, ⌘B, belonged to the rail toggle, so pressing what the Browser
 * row advertised collapsed the sidebar instead. Browser moved to ⌘⇧B and the rest are implemented
 * here, because a shortcut printed in the UI that does nothing is worse than no shortcut
 * (`WorkspaceShellPage`, same rule).
 *
 * One function rather than five predicates: these five share a modifier and must stay mutually
 * exclusive, and a table is the only shape where that is readable.
 */
export type PaneShortcutKind = "terminal" | "thread" | "browser" | "editor";

const PANE_SHORTCUTS: { key: string; shift: boolean; kind: PaneShortcutKind }[] = [
  { key: "t", shift: false, kind: "terminal" },
  { key: "t", shift: true, kind: "thread" },
  // ⌘B is the rail, and it got there first. Browser takes the shifted chord.
  { key: "b", shift: true, kind: "browser" },
  { key: "e", shift: false, kind: "editor" },
];

export function paneShortcutKind(event: ShortcutEvent, platform?: string): PaneShortcutKind | null {
  if (event.altKey || !hasPrimaryModifier(event, platform)) return null;
  const key = event.key.toLowerCase();
  const match = PANE_SHORTCUTS.find((candidate) => candidate.key === key && candidate.shift === event.shiftKey);
  return match?.kind ?? null;
}

/**
 * The chord as THIS machine's keyboard writes it.
 *
 * The menu's labels were written as macOS chords in a constant, so Windows and Linux were told to
 * press ⌘. The predicates above already answer the platform question once; this is the same
 * answer, for the eyes.
 */
export function formatShortcut(
  chord: string,
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  const isMac = /mac|iphone|ipad/i.test(platform);
  if (isMac) return chord;
  return chord.replace(/⌘/g, "Ctrl+").replace(/⇧/g, "Shift+");
}

/**
 * Moving focus from pane to pane.
 *
 * The chords are CodeSpace's, taken letter for letter from
 * `codespace/terminal-v2/layout/terminal-v2-layout-keybindings.ts`, so the two surfaces answer the
 * same keys. Plain ⌘Arrow is deliberately left alone: a terminal already spends ⌘← and ⌘→ on
 * line-start and line-end (`codespace/services/terminal-keybindings.ts`).
 */
export type PaneFocusCommand =
  | { kind: "direction"; direction: "left" | "right" | "up" | "down" }
  /** 0-based: ⌘1 is index 0. Every caller indexes an array with it. */
  | { kind: "index"; index: number }
  | { kind: "cycle"; direction: "next" | "previous" };

const ARROW_DIRECTIONS: Record<string, "left" | "right" | "up" | "down"> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

export function paneFocusShortcut(event: ShortcutEvent, platform?: string): PaneFocusCommand | null {
  // Ctrl+Tab, on every platform and before the primary-modifier question. Tab cycling is a Ctrl
  // chord on macOS too: ⌘Tab belongs to the OS app switcher and is not ours to take.
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
    return { kind: "cycle", direction: event.shiftKey ? "previous" : "next" };
  }
  if (!hasPrimaryModifier(event, platform)) return null;
  const direction = ARROW_DIRECTIONS[event.key];
  if (direction && (event.altKey || event.shiftKey)) return { kind: "direction", direction };
  // ⌘1..⌘9 jumps straight to a pane, the way a browser jumps to a tab. ⌘0 names no pane, so the
  // range starts at 1 and the digit is turned into an index here rather than at each caller.
  if (!event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
    return { kind: "index", index: Number(event.key) - 1 };
  }
  return null;
}

/**
 * True when this focus chord is also something an ordinary text field wants.
 *
 * ⌘⇧Arrow extends a selection to the start or end of the line, and the shell keeps a composer at
 * the bottom of every screen. ⌘⌥Arrow, Ctrl+Tab and ⌘1..⌘9 mean nothing in a field, so those are
 * taken everywhere. Paired with `keepsChordForTyping`, which asks the other half of the question:
 * is the cursor actually in such a field right now.
 */
export function isTextSelectionChord(event: ShortcutEvent): boolean {
  return event.shiftKey && !event.altKey && event.key in ARROW_DIRECTIONS;
}
