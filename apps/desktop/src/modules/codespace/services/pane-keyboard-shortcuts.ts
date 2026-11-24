export type PaneKeyboardShortcutEvent = {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

export function isMacCloseFocusedTerminalPaneShortcut(event: PaneKeyboardShortcutEvent): boolean {
  return event.key.toLowerCase() === "w"
    && Boolean(event.metaKey)
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey;
}

function isEditableElement(element: HTMLElement): boolean {
  const tagName = element.tagName;
  return element.isContentEditable
    || element.contentEditable === "true"
    || element.getAttribute("contenteditable") === "true"
    || tagName === "INPUT"
    || tagName === "TEXTAREA"
    || tagName === "SELECT";
}

function isXtermHelperTextarea(element: HTMLElement): boolean {
  return element.tagName === "TEXTAREA"
    && element.classList.contains("xterm-helper-textarea");
}

export function shouldIgnorePaneCloseShortcutTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (typeof element.tagName !== "string") return false;
  if (isXtermHelperTextarea(element)) return false;
  return isEditableElement(element);
}
