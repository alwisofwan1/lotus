"use client";
import { useEffect, useRef } from "react";
import type { ChatThread } from "@/modules/chat/runtime/chat-runtime-client";
import { chatPaneThreads } from "@/modules/codespace/state/thread-activity-registry";
import { chatTurnEnds } from "@/modules/workspace-shell/services/chat-turn-ends";
import { useCodeAgentDoneAlerts } from "@/modules/workspace-shell/hooks/useCodeAgentDoneAlerts";

/**
 * Agent-Done Alerts for Chat threads: a chat that finishes a turn, or starts waiting on the user,
 * while nobody is looking at it is announced the way Code panes are — the same Voice / Sound / Off
 * setting, quiet time and Live Voice hold. Fed by the shell's always-on rail listing, so it works
 * from any mode. A thread open in a Code pane is left to Code mode, which already alerts for it.
 */
export function useChatAgentDoneAlerts(threads: readonly ChatThread[], activeId: string | null, chatShown: boolean) {
  const alert = useCodeAgentDoneAlerts({ nameFor: (id) => threads.find((t) => t.id === id)?.title ?? undefined });
  const before = useRef(new Map<string, ChatThread>());

  useEffect(() => {
    const ends = chatTurnEnds(before.current, threads);
    before.current = new Map(threads.map((t) => [t.id, t]));
    const inPanes = new Set(chatPaneThreads.values());
    for (const { threadId, waiting } of ends) {
      if (inPanes.has(threadId)) continue;
      const seen = chatShown && threadId === activeId && document.hasFocus();
      // A finished turn was asked for; a second question in the same turn keeps the quiet time.
      alert(threadId, { seen, fresh: !waiting });
    }
  }, [threads, activeId, chatShown, alert]);
}
