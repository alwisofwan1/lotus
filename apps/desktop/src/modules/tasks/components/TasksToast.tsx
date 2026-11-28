"use client";

import { useEffect, useRef } from "react";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

/**
 * One short-lived line at the foot of Tasks, with one action (mockup `SOURCES 08`: "TKT-1000 moved
 * to trash in Notion · Undo ⌘Z"). ⌘Z runs the action while it is up — unless the focus is in a
 * field (⌘Z is that field's own undo) or a dialog is open. It leaves by itself after `ms`.
 */
export function TasksToast({
  label,
  message,
  action,
  onAction,
  onDismiss,
  ms = 10_000,
}: {
  label: string;
  message: string;
  action: string;
  onAction: () => void;
  onDismiss: () => void;
  ms?: number;
}) {
  const shortcut = useFormatShortcut();
  // Read through a ref: a caller's inline callback is new every render, and as a dependency it
  // restarted the timer each time, so a busy screen never let the toast leave.
  const latest = useRef({ onAction, onDismiss });
  latest.current = { onAction, onDismiss };
  useEffect(() => {
    const timer = setTimeout(() => latest.current.onDismiss(), ms);
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z" || event.shiftKey) return;
      // Something else already answered it, or a dialog is up: ⌘Z there is not about this toast.
      if (event.defaultPrevented || document.querySelector("[aria-modal='true']")) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      latest.current.onAction();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [ms]);

  return (
    <div className="tk-toast" role="status" aria-label={label}>
      <span className="tk-toast-text">{message}</span>
      <button type="button" className="tk-toast-action" onClick={onAction}>
        {action}
        <kbd className="tk-toast-key">{shortcut("⌘Z")}</kbd>
      </button>
    </div>
  );
}
