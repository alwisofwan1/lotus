"use client";

import { useMemo, useRef } from "react";
import type { TerminalV2Runtime } from "../runtime/terminal-v2-runtime";

export type TerminalV2SessionResizer = {
  resize(paneId: string, cols: number, rows: number): void;
};

export type UseTerminalV2GeometryOptions = {
  runtime: TerminalV2Runtime | null;
};

export type UseTerminalV2GeometryResult = {
  sessionResizer: TerminalV2SessionResizer | undefined;
};

export function useTerminalV2Geometry({
  runtime,
}: UseTerminalV2GeometryOptions): UseTerminalV2GeometryResult {
  const lastGeometryRef = useRef(new Map<string, string>());

  const sessionResizer = useMemo<TerminalV2SessionResizer | undefined>(() => {
    if (!runtime) return undefined;
    return {
      resize(paneId, cols, rows) {
        if (!isValidGeometry(cols, rows)) return;
        const signature = `${cols}x${rows}`;
        if (lastGeometryRef.current.get(paneId) === signature) return;
        lastGeometryRef.current.set(paneId, signature);
        runtime.resizePaneSession(paneId, cols, rows);
      },
    };
  }, [runtime]);

  return { sessionResizer };
}

function isValidGeometry(cols: number, rows: number): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0;
}
