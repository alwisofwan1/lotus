export function isEditableCanvasKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], .xterm-helper-textarea"));
}

/** True when the target sits inside an xterm terminal, which legitimately owns keys like Esc. */
export function isTerminalKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(".xterm, .xterm-helper-textarea"));
}

/**
 * The element to focus when diving into a node: the terminal input first, then any editable control.
 * Returns null when a node has no focusable content (e.g. a browser node's native webview).
 */
export function findNodeFocusTarget(root: HTMLElement): HTMLElement | null {
  const term = root.querySelector<HTMLElement>(".xterm-helper-textarea");
  if (term) return term;
  return root.querySelector<HTMLElement>(
    "textarea, input:not([type='hidden']), [contenteditable='true']",
  );
}

export function shouldPreventCanvasDeleteNavigation(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey"> & { target: EventTarget | null }): boolean {
  if (event.key !== "Backspace" && event.key !== "Delete") return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return !isEditableCanvasKeyTarget(event.target);
}

/**
 * Put the keyboard inside one canvas node's primary input, and say whether it landed.
 *
 * Extracted from an inline `querySelector(...) ?? document.body` in `CanvasPage`, which had two
 * faults. It fell back to searching the WHOLE document, so a missed id focused whichever terminal
 * happened to be first — possibly a veiled one belonging to another agent. And it never checked the
 * result: `.focus()` is a no-op on an element the browser will not focus (a veiled node is
 * `visibility: hidden`, and hidden elements are not focusable), which silently left the keyboard on
 * whatever button was clicked. A button swallows keystrokes, so the operator types and nothing
 * happens.
 *
 * Returns `false` rather than throwing or guessing, so the caller can decide what to do about it —
 * which is the only way it can avoid leaving the keyboard somewhere useless.
 */
export function focusCanvasNodeInput(nodeId: string, doc: Document = document): boolean {
  const root = doc.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${cssEscapeCanvasId(nodeId)}"]`,
  );
  // No document-wide fallback on purpose: focusing "some other node's input" is worse than focusing
  // nothing, because it sends the next keystroke to an agent the operator did not choose.
  if (!root) return false;
  const target = findNodeFocusTarget(root);
  if (!target) return false;
  target.focus();
  // Verified, not assumed. This is the line that tells a caller the browser refused.
  return doc.activeElement === target;
}

/** True when the target sits inside a Monaco editor (the Dock's Code app). */
export function isCodeEditorKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(".monaco-editor"));
}

const EDITOR_WIDGET_OPEN =
  ".find-widget.visible, .suggest-widget.visible, .parameter-hints-widget.visible, .rename-box.visible, .monaco-hover:not(.hidden)";

/**
 * Whether Monaco has a widget open (find, suggest, hover, parameter hints, rename) under `root`.
 * Esc belongs to that widget; the canvas and the Dock leave it alone until nothing is open.
 */
export function isEditorWidgetOpen(root: ParentNode = document): boolean {
  return root.querySelector(EDITOR_WIDGET_OPEN) !== null;
}

/** `CSS.escape` where available, else a conservative escape for the id selector above. */
function cssEscapeCanvasId(id: string): string {
  const escape = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS?.escape;
  return escape ? escape(id) : id.replace(/["\\]/g, "\\$&");
}

