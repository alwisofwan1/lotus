import type { GridCell } from "@/modules/codespace/components/types";

/**
 * Where a message typed in the one composer actually goes.
 *
 * Pure on purpose: "what would happen if I pressed Enter now" is a question the tests can ask
 * without a PTY, a session or a window.
 */

export type ComposerRoute =
  | { kind: "terminal"; paneId: string; runtimeSessionId: string }
  | { kind: "thread"; paneId: string; sessionId: string }
  | { kind: "blocked"; reason: string };

export function routeComposerMessage(pane: GridCell | null): ComposerRoute {
  if (!pane) return { kind: "blocked", reason: "Pick a pane first — there is nowhere to send this." };

  if (pane.type === "terminal") {
    // A terminal with no live session has nothing listening: saying so beats swallowing the text.
    if (!pane.runtimeSessionId) {
      return { kind: "blocked", reason: "This terminal has no live session yet." };
    }
    return { kind: "terminal", paneId: pane.id, runtimeSessionId: pane.runtimeSessionId };
  }

  if (pane.type === "chat") {
    // New Chat (beta, 07d): the pane registers its send under its own id, which it has before
    // its thread does — the first message can come from here too.
    if (pane.thread) return { kind: "thread", paneId: pane.id, sessionId: pane.id };
    // A pane pointing at a session that no longer exists has nothing to send to. Same rule as a
    // terminal without a live session: say so rather than swallow the text.
    if (!pane.sessionId) {
      return { kind: "blocked", reason: "This pane has no conversation yet." };
    }
    // The thread's own composer still owns the model picker and the attachments; this path only
    // carries plain text, and it delivers it by CALLING that composer's send (M3), so the two
    // cannot drift apart.
    return { kind: "thread", paneId: pane.id, sessionId: pane.sessionId };
  }

  return { kind: "blocked", reason: "This pane does not take text." };
}

/**
 * What to write to a PTY for one submitted message.
 *
 * Two writes, not one. A TUI's line editor treats text and its newline arriving together as a
 * paste and leaves it sitting in the input box unsent — measured on this machine, recorded in
 * memory `tui-prompt-needs-handover-and-split-enter`. Sending the newline separately is what
 * makes an agent CLI actually accept the line.
 */
export function ptyWritesForMessage(text: string): string[] {
  const trimmed = text.replace(/\r?\n$/, "");
  if (!trimmed) return [];
  return [trimmed, "\r"];
}

/**
 * What to write to put text, unsent, in an agent CLI's prompt (a **Held Prompt**, ADR-0064): the
 * first of `ptyWritesForMessage`'s two writes, never the carriage return. Line breaks become spaces:
 * a newline reaching a line editor can submit the line. `continues` = a Held Prompt already waits
 * there: a space keeps the two from running together.
 */
export function ptyWritesForHeldPrompt(text: string, continues = false): string[] {
  const [line] = ptyWritesForMessage(text.replace(/\s*\r?\n\s*/g, " ").trim());
  if (!line) return [];
  return [continues ? ` ${line}` : line];
}

/**
 * What to write to clear a Held Prompt from an agent CLI's prompt: Ctrl+U, once per line it may take.
 *
 * Measured 2026-10-25 by driving both CLIs in a PTY: `codex` clears its whole prompt on one Ctrl+U;
 * `claude` clears only the screen line the cursor is on, so a prompt that wrapped needs one per
 * line. Ctrl+U on an empty prompt does nothing in either, so the count is generous on purpose —
 * it assumes a pane as narrow as 20 columns.
 */
export function ptyWritesToClearHeldPrompt(text: string, typedInPane = 0): string[] {
  const lines = Math.ceil((text.length + typedInPane) / 20) + 1;
  return ["\u0015".repeat(lines)];
}
