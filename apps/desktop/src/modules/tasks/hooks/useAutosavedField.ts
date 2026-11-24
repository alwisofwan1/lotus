"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { utf8Length } from "@/modules/tasks/services/task-draft";

/**
 * One text field of a stored task, saved a moment after typing stops.
 *
 * Three rules, each closing a way to lose words:
 *
 * - **Typing wins over an outside change.** An agent can write to the same task while someone is
 *   mid-sentence (`tasks://changed`). While anything is held, a new stored value is NOT laid over
 *   the editor; the typing is saved on top of it. With nothing held, the stored value replaces
 *   what is shown — that is `resetKey`, the editor's cue to take new text in.
 * - **The store's cap is its bytes.** Past it, nothing is sent and the refusal is said; the typing
 *   stays held so it can be cut down rather than retyped.
 * - **Leaving saves.** Unmounting — another task, closing the tracker — writes what is held.
 */
export interface AutosavedField {
  /** Bumped when the stored value must replace what the editor shows. */
  resetKey: number;
  onChange: (text: string) => void;
  /** Why the last attempt was not sent, or `null`. */
  refusal: string | null;
}

export function useAutosavedField({
  value,
  save,
  cap,
  delay = 800,
}: {
  /** The stored text, as the editor should show it. */
  value: string;
  save: (text: string) => void;
  /** The store's limit, in UTF-8 bytes. */
  cap: number;
  delay?: number;
}): AutosavedField {
  const [resetKey, setResetKey] = useState(0);
  const [refusal, setRefusal] = useState<string | null>(null);
  const held = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKnown = useRef(value.trim());
  const saveRef = useRef(save);
  saveRef.current = save;

  // A new stored value: taken in only when nothing is being typed over it.
  useEffect(() => {
    if (held.current !== null) return;
    const next = value.trim();
    if (next === lastKnown.current) return;
    lastKnown.current = next;
    setResetKey((key) => key + 1);
  }, [value]);

  const send = useCallback(() => {
    timer.current = null;
    const text = held.current;
    if (text === null) return;
    if (utf8Length(text) > cap) {
      setRefusal(`This is at most ${cap} bytes — dashes and accents count as more than one. Nothing was saved.`);
      return;
    }
    held.current = null;
    setRefusal(null);
    const next = text.trim();
    if (next === lastKnown.current) return;
    lastKnown.current = next;
    saveRef.current(text);
  }, [cap]);

  const onChange = useCallback(
    (text: string) => {
      held.current = text;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(send, delay);
    },
    [delay, send],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      // Leaving the page writes what was held — unless it is over the cap, which the store refuses.
      if (held.current !== null && utf8Length(held.current) <= cap && held.current.trim() !== lastKnown.current) {
        saveRef.current(held.current);
      }
    },
    [cap],
  );

  return { resetKey, onChange, refusal };
}
