/**
 * Where the keyboard cursor goes when a pane takes focus.
 *
 * The shell holds `focusedCellId`, which until now was only a colour: nothing ever moved the real
 * cursor, so picking a pane from the rail highlighted it while typing still went to the pane
 * before. CodeSpace solves this by holding a ref to each terminal and calling `.focus()`
 * (`TerminalV2TerminalPane`); the shell cannot, because its panes are four different components
 * from three modules, and only one of them exposes a focus method at all.
 *
 * So the question is asked of the DOM instead: given a pane's element, which descendant should
 * receive the cursor. That works the same for a terminal, a conversation and an editor without any
 * of them having to know the shell exists — and it is a pure function over a fragment of HTML,
 * which is the whole reason it lives here rather than inside a component.
 */

/** xterm types through this hidden textarea; it is the only element whose keys reach the PTY. */
const XTERM_HELPER = ".xterm-helper-textarea";

/**
 * The fields you can type into, named one by one rather than by ruling others out.
 *
 * An allow-list because the things that must NOT be picked cannot be recognised by how they look: a
 * conversation pane keeps a file picker beside its composer, hidden by a CSS class rather than by
 * the `hidden` attribute, and jsdom — where this is tested — computes no layout at all. Saying what
 * counts is honest in both places; saying what is visible is honest in neither.
 */
const TYPING_FIELDS = [
  "textarea",
  "input[type='text']",
  "input[type='search']",
  "input:not([type])",
  "[contenteditable='true']",
].join(",");

export function paneFocusTarget(pane: HTMLElement | null): HTMLElement | null {
  if (!pane) return null;

  const helper = pane.querySelector<HTMLElement>(XTERM_HELPER);
  if (helper) return helper;

  for (const field of pane.querySelectorAll<HTMLElement>(TYPING_FIELDS)) {
    // A disabled field cannot take the cursor at all: focusing it is a silent no-op, and the cursor
    // would be left in the pane the user just moved AWAY from.
    if (field.hasAttribute("disabled") || field.getAttribute("aria-hidden") === "true") continue;
    return field;
  }

  /*
    The pane itself, when it has no field of its own — a browser pane runs its page in a native
    webview, outside this DOM entirely. Moving the cursor here still matters: it takes focus OFF the
    terminal the user came from, so the next thing they type cannot land on an agent they thought
    they had left. The caller makes the element focusable.
  */
  return pane;
}

/**
 * True when a chord belongs to the field the cursor is already in, and the shell should not take it.
 *
 * Only asked about chords that mean something in an ordinary field — ⌘⇧Arrow extends a selection to
 * the start or end of the line, and this shell has a composer at the bottom of every screen. A
 * terminal is carved back out, because xterm types through a textarea and the blunt "is this a
 * field" test would disable the focus keys exactly where they are used most. CodeSpace carves out
 * the same element for ⌘W (`shouldIgnorePaneCloseShortcutTarget`).
 */
export function keepsChordForTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  if (element.classList?.contains("xterm-helper-textarea")) return false;
  const tag = element.tagName.toLowerCase();
  return tag === "textarea" || tag === "input" || element.isContentEditable === true
    || element.getAttribute("contenteditable") === "true";
}
