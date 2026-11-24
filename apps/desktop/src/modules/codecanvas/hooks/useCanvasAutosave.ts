import { useCallback, useEffect, useRef, useState } from "react";
import type { Node, Edge } from "@xyflow/react";

export type CanvasAutosaveStatus = "idle" | "dirty" | "saving" | "saved" | "failed";

export interface CanvasAutosaveState {
  status: CanvasAutosaveStatus;
  error: string | null;
}

type SaveFn = (nodes: Node[], edges: Edge[]) => void | Promise<void>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Debounced autosave. Receives a ref to the current save function so it never
 * captures stale closures — callers update saveFnRef.current each render.
 */
export function useCanvasAutosave(
  saveFnRef: { current: SaveFn | null },
  delayMs = 800,
): { schedule: SaveFn; cancel: () => void; state: CanvasAutosaveState } {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runSeqRef = useRef(0);
  const [state, setState] = useState<CanvasAutosaveState>({ status: "idle", error: null });

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const schedule = useCallback<SaveFn>(
    (nodes, edges) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const seq = runSeqRef.current + 1;
      runSeqRef.current = seq;
      setState({ status: "dirty", error: null });
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const save = saveFnRef.current;
        if (!save) return;
        setState({ status: "saving", error: null });
        void Promise.resolve(save(nodes, edges))
          .then(() => { if (runSeqRef.current === seq) setState({ status: "saved", error: null }); })
          .catch((error: unknown) => { if (runSeqRef.current === seq) setState({ status: "failed", error: errorMessage(error) }); });
      }, delayMs);
    },
    [saveFnRef, delayMs],
  );

  return { schedule, cancel, state };
}
