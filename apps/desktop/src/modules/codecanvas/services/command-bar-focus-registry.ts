/**
 * Command-bar focus bridge (plans/nl-type-to-focus). The NL bar owns its `inputRef` privately,
 * but the hotkey dispatcher that decides "/" and Space mean "focus the command bar" lives in
 * CanvasPage — several components away, with no ref of its own. Bridge the two with a module
 * singleton, mirroring `noteSelectionRegistry`: register returns its own unregister, and that
 * unregister only clears the slot if it is still the one it installed (guards an unmount racing
 * a remount — the same race the note registry guards against). Unlike the note registry there is
 * only ever one command bar mounted per canvas, so this is a single slot rather than a Map keyed
 * by id.
 */

let current: (() => void) | null = null;

export const commandBarFocusRegistry = {
  register(focus: () => void): () => void {
    current = focus;
    return () => {
      // Only clear if still the same handler (guards against an unmount racing a remount).
      if (current === focus) current = null;
    };
  },
  /**
   * Focus the command bar if one is mounted and focusable. Returns whether it did — a hotkey
   * handler needs to know nothing happened so it does not swallow ("/" / Space) a key that had
   * no effect. Success is measured by whether `document.activeElement` actually moved rather than
   * trusting the registrant to report its own outcome: a registrant that has nothing focusable
   * right now (unmounted input, or a disabled control) can just call `.focus()` and let it no-op —
   * a disabled or absent target cannot take real DOM focus, so the before/after comparison already
   * tells the truth without the registrant tracking a boolean of its own.
   */
  focus(): boolean {
    if (!current) return false;
    const before = typeof document !== "undefined" ? document.activeElement : null;
    current();
    const after = typeof document !== "undefined" ? document.activeElement : null;
    return after !== before;
  },
};
