"use client";

import { useEffect, useMemo } from "react";
import { useTerminalV2Runtime } from "../runtime/TerminalV2RuntimeProvider";
import type { TerminalV2Runtime } from "../runtime/terminal-v2-runtime";
import type { TerminalV2SessionStarter } from "../runtime/terminal-v2-session-starter";

export type UseTerminalV2SessionOptions = {
  paneId: string;
  mirrorOutputToRenderer?: boolean;
};

export type UseTerminalV2SessionResult = {
  runtime: TerminalV2Runtime | null;
  sessionStarter: TerminalV2SessionStarter | undefined;
  sessionDetacher: { detach(paneId: string): void } | undefined;
};

export function useTerminalV2Session({
  paneId,
  mirrorOutputToRenderer = true,
}: UseTerminalV2SessionOptions): UseTerminalV2SessionResult {
  const runtimeContext = useTerminalV2Runtime();
  const runtime = runtimeContext.runtime;

  useEffect(() => {
    if (!runtime || !mirrorOutputToRenderer) return undefined;
    return runtime.subscribePaneOutput(paneId, (data) => {
      runtime.writeRendererPaneOutput(paneId, data);
    });
  }, [mirrorOutputToRenderer, paneId, runtime]);

  return useMemo(() => ({
    runtime,
    sessionStarter: runtime?.sessionStarter,
    sessionDetacher: runtime ? { detach: (nextPaneId: string) => runtime.detachPaneSession(nextPaneId) } : undefined,
  }), [runtime]);
}
