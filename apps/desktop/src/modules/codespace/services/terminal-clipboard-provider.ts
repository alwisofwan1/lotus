import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

/**
 * Who answers when a program in the terminal asks for the clipboard (OSC 52).
 *
 * xterm's clipboard addon defaults to `BrowserClipboardProvider`, whose write is literally
 * `navigator.clipboard.writeText(text)`. That call needs a user gesture, and an escape sequence
 * arriving from a PTY is not one — WKWebView answers `NotAllowedError`. Worse, the OSC handler
 * runs INSIDE `terminal.write(data)`, so the rejection escaped up through the write pump and
 * surfaced as a runtime error over the whole app (seen 2026-09-20 while selecting text in a
 * Claude Code pane; Claude emits OSC 52 to copy the selection).
 *
 * So the provider is supplied explicitly:
 *
 * - **Write** goes to the Tauri clipboard plugin, which is a native call and needs no gesture, so
 *   "select in the TUI, paste anywhere" actually works. The browser API is tried first for the
 *   non-Tauri case (dev in a plain browser), and a refusal there is not an error worth showing.
 * - **Read is refused.** OSC 52 can ask the terminal to REPORT the clipboard, which would let any
 *   program that reaches a PTY — including one running over SSH — read whatever was last copied.
 *   Returning nothing is what a terminal should do unless someone deliberately turns it on.
 *
 * Nothing here throws. A clipboard that will not cooperate must not be able to interrupt terminal
 * output; the text simply does not get copied.
 */

export interface TerminalClipboardProvider {
  readText(): string;
  writeText(selection: string, text: string): Promise<void>;
}

interface TerminalClipboardProviderOptions {
  /** Injectable for tests; production uses the real Tauri bridge. */
  invoke?: typeof tauriInvoke;
  inTauri?: () => boolean;
  browserWrite?: (text: string) => Promise<void>;
  onRefused?: (reason: unknown) => void;
}

/** `plugin:clipboard-manager|write_text` takes a flat `{ text, label? }` — verified against
 *  tauri-plugin-clipboard-manager 2.3.2, the version this app pins. */
const WRITE_TEXT_COMMAND = "plugin:clipboard-manager|write_text";

export function createTerminalClipboardProvider({
  invoke = tauriInvoke,
  inTauri = isTauri,
  browserWrite = (text) => navigator.clipboard.writeText(text),
  onRefused,
}: TerminalClipboardProviderOptions = {}): TerminalClipboardProvider {
  return {
    readText() {
      // See the note above: answering this is an exfiltration path, not a feature.
      return "";
    },

    async writeText(_selection: string, text: string): Promise<void> {
      if (inTauri()) {
        try {
          await invoke(WRITE_TEXT_COMMAND, { text });
          return;
        } catch (error) {
          onRefused?.(error);
          // Fall through: a browser that happens to allow it is better than nothing.
        }
      }

      try {
        await browserWrite(text);
      } catch (error) {
        // The end of the line. A refused clipboard is a copy that did not happen, not a fault
        // the terminal's output path should carry.
        onRefused?.(error);
      }
    },
  };
}
