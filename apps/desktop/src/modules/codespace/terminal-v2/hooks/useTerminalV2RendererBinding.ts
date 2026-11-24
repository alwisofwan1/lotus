"use client";

import { useCallback, useEffect } from "react";
import { createTerminalV2LegacyXtermSlot } from "../rendering/terminal-v2-legacy-xterm-slot";
import type {
  TerminalV2FitAddonLike,
  TerminalV2XtermLike,
} from "../rendering/terminal-v2-xterm-renderer-host";
import type { TerminalV2Runtime } from "../runtime/terminal-v2-runtime";

export type TerminalV2RendererHandles = {
  terminal: TerminalV2XtermLike;
  fitAddon: TerminalV2FitAddonLike;
};

export type UseTerminalV2RendererBindingOptions = {
  runtime: TerminalV2Runtime | null;
  paneId: string;
  active?: boolean;
  focused?: boolean;
  liveResizeActive?: boolean;
  agentCommand?: string;
  onRendererHandlesReady?: (handles: TerminalV2RendererHandles) => void | (() => void);
};

export type UseTerminalV2RendererBindingResult = {
  onRendererHandlesReady: (handles: TerminalV2RendererHandles) => () => void;
};

export function useTerminalV2RendererBinding({
  runtime,
  paneId,
  active = true,
  focused = active,
  liveResizeActive = false,
  agentCommand,
  onRendererHandlesReady,
}: UseTerminalV2RendererBindingOptions): UseTerminalV2RendererBindingResult {
  useEffect(() => {
    const visible = active !== false;
    const rendererFocused = visible && focused !== false;
    runtime?.updateRendererPane({
      paneId,
      visible,
      focused: rendererFocused,
      agentActive: Boolean(agentCommand),
      liveResizeActive,
    });
    if (visible && !rendererFocused) {
      runtime?.blurPaneRenderer(paneId);
    }
  }, [active, agentCommand, focused, liveResizeActive, paneId, runtime]);

  useEffect(() => () => {
    runtime?.updateRendererPane({ paneId, visible: false });
  }, [paneId, runtime]);

  const handleRendererHandlesReady = useCallback((handles: TerminalV2RendererHandles) => {
    const cleanupFns: Array<() => void> = [];
    const callerCleanup = onRendererHandlesReady?.(handles);
    if (callerCleanup) cleanupFns.push(callerCleanup);

    const unregister = runtime?.registerLegacyRendererSlot(
      paneId,
      createTerminalV2LegacyXtermSlot({
        paneId,
        terminal: handles.terminal,
        fitAddon: handles.fitAddon,
      }),
    );
    if (unregister) cleanupFns.push(unregister);

    return () => cleanupFns.forEach((cleanup) => cleanup());
  }, [onRendererHandlesReady, paneId, runtime]);

  return { onRendererHandlesReady: handleRendererHandlesReady };
}
