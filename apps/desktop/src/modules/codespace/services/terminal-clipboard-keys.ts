/**
 * Copy and paste keys for a terminal on Windows and Linux.
 *
 * On macOS ⌘C and ⌘V never reach xterm as control characters, so the browser's own copy and paste
 * run and nothing here applies. Off macOS xterm owns every Ctrl+letter and encodes it
 * (xterm 6 `Keyboard.ts`, then `CoreBrowserTerminal._keyDown` cancels the event):
 *
 * - Ctrl+V became `^V` on the PTY, and the browser never fired a paste — text could not be pasted.
 * - Ctrl+C with a selection was SIGINT; the selection was never copied.
 * - Ctrl+Shift+C did nothing at all.
 *
 * This applies the convention of Windows Terminal and VS Code: Ctrl+C copies when there is a
 * selection and is SIGINT otherwise; Ctrl+Shift+C copies; Ctrl+V and Ctrl+Shift+V paste.
 *
 * Paste is done by NOT handling it: returning `false` without `preventDefault` makes xterm skip
 * the key, so the browser's native paste fires on xterm's textarea. Every paste pipeline that
 * already exists — xterm's bracketed paste, the live-agent node's explicit bracket wrap, the canvas
 * image intake — keeps working exactly as it does for ⌘V on a Mac.
 */

import { chordLetter } from "@/lib/hotkeys/platform-chords";
import { isMacPlatform, readPlatformString } from "@/lib/platform";
import { createTerminalClipboardProvider } from "./terminal-clipboard-provider";

/** The part of an xterm `Terminal` this needs. All optional: test doubles and pooled slots vary. */
export interface TerminalSelectionLike {
  hasSelection?(): boolean;
  getSelection?(): string;
  clearSelection?(): void;
}

export interface TerminalClipboardKeyEvent {
  type?: string;
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * `copy` — copy the selection. `paste` — let the browser paste. `swallow` — Ctrl+Shift+C with
 * nothing selected: consumed, so it neither reaches the PTY nor opens WebView2's element picker.
 */
export type TerminalClipboardKeyIntent = "copy" | "paste" | "swallow";

export function resolveTerminalClipboardKeyIntent(
  event: TerminalClipboardKeyEvent,
  hasSelection: boolean,
  platform: string = readPlatformString(),
): TerminalClipboardKeyIntent | null {
  if (isMacPlatform(platform)) return null;
  if (event.type !== undefined && event.type !== "keydown") return null;
  if (!event.ctrlKey || event.metaKey || event.altKey) return null;
  const letter = chordLetter({ key: event.key, code: event.code });
  if (letter === "v") return "paste";
  if (letter !== "c") return null;
  if (event.shiftKey) return hasSelection ? "copy" : "swallow";
  // Plain Ctrl+C with nothing selected stays SIGINT: null hands it on to xterm.
  return hasSelection ? "copy" : null;
}

type CustomKeyHandler = (event: KeyboardEvent) => boolean;

export interface TerminalClipboardKeyOptions {
  /** Injectable for tests; production reads the webview's platform. */
  platform?: string;
  /** Injectable for tests; production writes through the Tauri clipboard plugin. */
  writeText?: (text: string) => Promise<void> | void;
}

let sharedProvider: ReturnType<typeof createTerminalClipboardProvider> | null = null;

/** Native clipboard write — the same provider OSC 52 uses, so it needs no gesture and never throws. */
function writeSelectionToClipboard(text: string): Promise<void> {
  sharedProvider ??= createTerminalClipboardProvider();
  return sharedProvider.writeText("c", text);
}

/**
 * Wrap an xterm custom key handler so the clipboard keys are answered first. Install it at the
 * point where the terminal is attached, since copy needs the terminal's own selection.
 */
export function withTerminalClipboardKeys(
  terminal: TerminalSelectionLike,
  next: CustomKeyHandler,
  options: TerminalClipboardKeyOptions = {},
): CustomKeyHandler {
  const writeText = options.writeText ?? writeSelectionToClipboard;
  return (event) => {
    const intent = resolveTerminalClipboardKeyIntent(event, terminal.hasSelection?.() ?? false, options.platform);
    if (intent === null) return next(event);
    // Returning false without preventDefault: xterm skips the key and the browser pastes.
    if (intent === "paste") return false;
    event.preventDefault();
    if (intent === "copy") {
      const text = terminal.getSelection?.() ?? "";
      if (text) void writeText(text);
      // Windows Terminal clears after copying, so the next Ctrl+C is SIGINT again, not a re-copy.
      terminal.clearSelection?.();
    }
    return false;
  };
}
