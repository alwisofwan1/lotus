"use client";
import { useCallback, useMemo, useState } from "react";
import {
  selectToastStackView,
  upsertCompletionToast,
  type CompletionToast,
  type ToastStackView,
} from "../services/agent-completion-toast";

export interface UseAgentCompletionToastsOptions {
  /** Full cards to show before the rest fold into a pile. Defaults to {@link DEFAULT_MAX_VISIBLE_TOASTS}. */
  maxVisible?: number;
}

export interface AgentCompletionToastsApi {
  /** Raw list, oldest→newest. */
  toasts: CompletionToast[];
  /** Derived split into visible cards + collapsed pile. */
  view: ToastStackView;
  /** Add a toast; a re-firing agent replaces its own (latest-wins). */
  push: (toast: CompletionToast) => void;
  /** Remove one toast by id (dismiss / auto-expire). */
  dismiss: (id: string) => void;
  /** Remove everything (e.g. "View all" on the pile). */
  clear: () => void;
}

/**
 * Holds the live toast queue. Deliberately dumb: it owns list state and de-dupe only — auto-dismiss
 * timers live in each card (so hover can pause them), and the completion signal is pushed in from
 * {@link useAgentDoneCallouts}. Kept separate from that hook so toasts show regardless of voice.
 */
export function useAgentCompletionToasts(options: UseAgentCompletionToastsOptions = {}): AgentCompletionToastsApi {
  const { maxVisible } = options;
  const [toasts, setToasts] = useState<CompletionToast[]>([]);

  const push = useCallback((toast: CompletionToast) => {
    setToasts((prev) => upsertCompletionToast(prev, toast));
  }, []);
  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const clear = useCallback(() => setToasts([]), []);

  const view = useMemo(() => selectToastStackView(toasts, maxVisible), [toasts, maxVisible]);

  return { toasts, view, push, dismiss, clear };
}
