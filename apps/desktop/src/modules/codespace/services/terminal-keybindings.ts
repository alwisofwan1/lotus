export interface TerminalShortcutEvent {
  type?: string;
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  preventDefault?: () => void;
}

// Kitty-keyboard-protocol encoding of Shift+Enter. Claude-family CLIs accept it raw (no CSI-u
// negotiation needed) and treat it as "insert newline"; plain shells never see it because agent
// PTYs run the CLI as the direct child.
export const KITTY_SHIFT_ENTER_SEQUENCE = "\u001b[13;2u";

// Meta+Enter. Newline-insert in zsh (self-insert-unmeta), a no-op in bash's emacs keymap, and the
// Alt+Enter path Claude Code already accepts — the safe choice when the PTY child is a shell.
export const META_ENTER_SEQUENCE = "\u001b\r";

export interface TerminalNewlineOptions {
  /** Sequence to write for a plain Shift+Enter; return null to leave the key to xterm (feature off). */
  shiftEnterSequence?: () => string | null;
  /**
   * Phase-2 seam: once xterm ≥6.1 encodes Shift+Enter itself under an active kitty keyboard
   * protocol, report true here so the handler passes the key through instead of double-encoding.
   */
  isKittyKeyboardActive?: () => boolean;
}

export function isShiftEnterNewlineEvent(event: TerminalShortcutEvent): boolean {
  return (
    (event.type === undefined || event.type === "keydown") &&
    event.key === "Enter" &&
    event.shiftKey === true &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing &&
    event.keyCode !== 229
  );
}

export function getTerminalShortcutSequence(event: TerminalShortcutEvent): string | null {
  if (event.altKey && event.key === "Backspace") {
    return "\u0017";
  }

  if (event.altKey && event.key === "Delete") {
    return "\u001bd";
  }

  if (event.altKey && event.key === "ArrowLeft") {
    return "\u001bb";
  }

  if (event.altKey && event.key === "ArrowRight") {
    return "\u001bf";
  }

  if (event.metaKey && event.key === "Backspace") {
    return "\u0015";
  }

  if (event.metaKey && event.key === "Delete") {
    return "\u000b";
  }

  if (event.metaKey && event.key === "ArrowLeft") {
    return "\u0001";
  }

  if (event.metaKey && event.key === "ArrowRight") {
    return "\u0005";
  }

  return null;
}

export function handleTerminalCustomKeyEvent(
  event: TerminalShortcutEvent,
  writeSequence: (data: string) => void,
  handleCustomShortcut?: (event: TerminalShortcutEvent) => boolean | undefined,
  newlineOptions?: TerminalNewlineOptions,
): boolean {
  if (event.type && event.type !== "keydown") {
    return true;
  }

  const customResult = handleCustomShortcut?.(event);
  if (customResult !== undefined) return customResult;

  if (newlineOptions?.shiftEnterSequence && isShiftEnterNewlineEvent(event)) {
    if (newlineOptions.isKittyKeyboardActive?.()) {
      return true;
    }
    const newlineSequence = newlineOptions.shiftEnterSequence();
    if (newlineSequence !== null) {
      event.preventDefault?.();
      writeSequence(newlineSequence);
      return false;
    }
  }

  const sequence = getTerminalShortcutSequence(event);
  if (!sequence) {
    return true;
  }

  writeSequence(sequence);
  return false;
}
