"use client";

import { useCallback, useEffect, useState } from "react";
import { subscribeAgentStopped, type AgentStoppedSubscriber } from "@/modules/codecanvas/services/agent-stopped-event";

/**
 * Which panes' last turn died on a usage limit, with the CLI's words for it. A turn that ends
 * normally clears its pane, and so does `clear` (the pane moved to another account).
 */
export function usePaneUsageLimits(subscribe: AgentStoppedSubscriber = subscribeAgentStopped) {
  const [limits, setLimits] = useState<ReadonlyMap<string, string>>(() => new Map());
  const set = useCallback((paneId: string, limit: string | null) => {
    setLimits((prev) => {
      if ((prev.get(paneId) ?? null) === limit) return prev;
      const next = new Map(prev);
      if (limit) next.set(paneId, limit);
      else next.delete(paneId);
      return next;
    });
  }, []);
  useEffect(() => subscribe((paneId, _sessionId, limit) => set(paneId, limit ?? null)), [subscribe, set]);
  const clear = useCallback((paneId: string) => set(paneId, null), [set]);
  return { limits, clear };
}
