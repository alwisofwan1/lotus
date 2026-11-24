"use client";

import { useCallback, useMemo, useState } from "react";
import {
  rankCommandItems,
  type CommandItem,
  type RankedCommands,
} from "@/modules/workspace-shell/services/command-items";

export interface CommandSheetBinding {
  open: boolean;
  ranked: RankedCommands;
  activeIndex: number;
  query: string;
  /** Bumped when the field should take focus (⌘K from anywhere in the shell). */
  focusSignal: number;
  /** The field's new contents, while the sheet is open. Ignored when it is not. */
  onInput: (value: string) => void;
  onMove: (delta: number) => void;
  onHover: (index: number) => void;
  /** Runs the active row; false when there is nothing runnable, so the key falls through. */
  runActive: () => boolean;
  /** ⇥: changes what the active row runs on; false when it has nothing to change. */
  cycleActive: () => boolean;
  run: (index: number) => void;
  close: () => void;
  /** ⌘K: opens with no query and asks the field for focus. */
  openBrowse: () => void;
}

/**
 * The sheet's state, kept out of the composer.
 *
 * The composer owns the text; this owns whether that text is a message or a query. One field does
 * both jobs, which is why no second input box appears — and the switch between them is **⌘K and
 * nothing else**. A leading `/` was tried and dropped on purpose: a slash is an ordinary character
 * someone will want for slash-commands, paths, or regexes later, and a mode you can enter by
 * accident while typing is a mode that eats a message.
 */
export function useCommandSheet(items: readonly CommandItem[]): CommandSheetBinding {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [focusSignal, setFocusSignal] = useState(0);

  const ranked = useMemo(() => rankCommandItems(items, query), [items, query]);

  // Clamped on READ rather than corrected in an effect: the list changes on every keystroke, and
  // an effect would render one frame pointing at a row that is no longer there.
  const activeIndex = ranked.items.length === 0 ? 0 : Math.min(index, ranked.items.length - 1);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setIndex(0);
  }, []);

  // While the sheet is open the field IS the query. While it is closed this is a no-op, so
  // ordinary typing can never drift into command mode.
  const onInput = useCallback(
    (value: string) => {
      if (!open) return;
      setQuery(value);
      setIndex(0);
    },
    [open],
  );

  const onMove = useCallback(
    (delta: number) => {
      setIndex((current) => {
        const count = ranked.items.length;
        if (count === 0) return 0;
        const from = Math.min(current, count - 1);
        // Wraps, because a list that stops at its ends makes you look at it to know where you are.
        return (from + delta + count) % count;
      });
    },
    [ranked.items.length],
  );

  const run = useCallback(
    (target: number) => {
      const item = ranked.items[target];
      // A CLI this machine does not have is listed so it can be seen, not so it can be started.
      if (!item || item.disabled) return;
      close();
      item.run();
    },
    [close, ranked.items],
  );

  const runActive = useCallback(() => {
    const item = ranked.items[activeIndex];
    if (!item || item.disabled) return false;
    close();
    item.run();
    return true;
  }, [activeIndex, close, ranked.items]);

  const cycleActive = useCallback(() => {
    const cycle = ranked.items[activeIndex]?.cycle;
    cycle?.();
    return !!cycle;
  }, [activeIndex, ranked.items]);

  const openBrowse = useCallback(() => {
    setOpen(true);
    setQuery("");
    setIndex(0);
    setFocusSignal((current) => current + 1);
  }, []);

  return {
    open,
    ranked,
    activeIndex,
    query,
    focusSignal,
    onInput,
    onMove,
    onHover: setIndex,
    runActive,
    cycleActive,
    run,
    close,
    openBrowse,
  };
}
