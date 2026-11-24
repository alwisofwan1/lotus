"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  subscribeTerminalSessionStatus,
  writeTerminalSession,
  type TerminalRuntimeStatus,
} from "@/modules/codespace/services/terminal-session-registry";

export interface TerminalRunRequest {
  paneId: string;
  command: string;
}

export interface TerminalDispatchDeps {
  subscribeStatus: (paneId: string, cb: (status: TerminalRuntimeStatus) => void) => () => void;
  write: (paneId: string, data: string) => void;
}

const DEFAULT_DEPS: TerminalDispatchDeps = {
  subscribeStatus: subscribeTerminalSessionStatus,
  write: writeTerminalSession,
};

export interface UseCanvasTerminalDispatchResult {
  /** Queue a command to type into a freshly spawned terminal once its PTY is live. */
  schedule: (request: TerminalRunRequest) => void;
}

/**
 * Auto-runs a command in a dispatched Canvas Terminal Node: it waits for the PTY
 * to reach "live" (the runtime opens the session asynchronously), then writes the
 * command exactly once and unsubscribes.
 */
export function useCanvasTerminalDispatch(deps: TerminalDispatchDeps = DEFAULT_DEPS): UseCanvasTerminalDispatchResult {
  const queueRef = useRef<TerminalRunRequest[]>([]);
  const unsubsRef = useRef<Set<() => void>>(new Set());
  const [tick, setTick] = useState(0);

  useEffect(() => () => { unsubsRef.current.forEach((u) => u()); unsubsRef.current.clear(); }, []);

  const schedule = useCallback((request: TerminalRunRequest) => {
    queueRef.current.push(request);
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    const request = queueRef.current.shift();
    if (!request) return;
    let written = false;
    const unsub = deps.subscribeStatus(request.paneId, (status) => {
      if (written || status !== "live") return;
      written = true;
      deps.write(request.paneId, request.command);
      unsub();
      unsubsRef.current.delete(unsub);
    });
    unsubsRef.current.add(unsub);
  }, [tick, deps]);

  return { schedule };
}
