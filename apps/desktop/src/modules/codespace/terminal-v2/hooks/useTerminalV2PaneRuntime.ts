"use client";

import { useCallback, useMemo } from "react";
import type { UseLegacyTerminalRuntimeOptions } from "@/modules/codespace/hooks/useLegacyTerminalRuntime";
import {
  resolveTerminalV2CommitFitEvent,
  resolveTerminalV2InitialGeometryEvent,
  resolveTerminalV2ResizeEvent,
} from "../geometry/terminal-v2-geometry-event-adapter";
import { processTerminalV2InputEvent } from "../input/terminal-v2-input-event-adapter";
import { processTerminalV2OutputEvent } from "../output/terminal-v2-output-event-adapter";
import { TerminalV2OutputRing } from "../output/terminal-v2-output-ring";
import { createTerminalV2WriteScheduler } from "../output/terminal-v2-write-scheduler-adapter";
import { resolveTerminalV2RevealPolicy } from "../rendering/terminal-v2-reveal-policy";
import { createTerminalV2PaneRuntimeAdapter } from "../runtime/terminal-v2-pane-runtime-adapter";
import { useTerminalV2FocusSearch } from "./useTerminalV2FocusSearch";
import { useTerminalV2Geometry } from "./useTerminalV2Geometry";
import { useTerminalV2Input } from "./useTerminalV2Input";
import { useTerminalV2Links } from "./useTerminalV2Links";
import { useTerminalV2RendererBinding } from "./useTerminalV2RendererBinding";
import { useTerminalV2Session } from "./useTerminalV2Session";
import { useTerminalV2Suggestions } from "./useTerminalV2Suggestions";
import { useTerminalV2XtermEvents } from "./useTerminalV2XtermEvents";
import { useTerminalV2XtermRenderer } from "./useTerminalV2XtermRenderer";

/*
  Hoisted out of the `legacyOptions` memo below, and it has to stay hoisted.

  `useTerminalV2NativeRuntime` re-derives its `stableLegacyOptions` from exactly three fields —
  `hiddenOutputBufferFactory`, `paneRuntimeFactory`, `revealPolicy` — and hands the result to the
  effect that builds the native terminal. While these two were object/function literals inside the
  memo, each recompute of that memo minted new identities for them, so "stable" was stable only for
  as long as its parent never recomputed. When the parent did recompute on every render, the effect
  tore the terminal down and rebuilt it every render: the renderer probe showed
  `SLOT unregister wanted=true` / `SLOT register wanted=true` for all six panes at ~6Hz with 240
  consecutive runs reporting `changed=legacyOptions`, and the webview pinned a core at ~100%.

  Neither value closes over anything, so module scope is their natural home.
*/
const HIDDEN_OUTPUT_BUFFER_FACTORY = () => new TerminalV2OutputRing();
const REVEAL_POLICY = { resolve: resolveTerminalV2RevealPolicy };

export type UseTerminalV2PaneRuntimeOptions = UseLegacyTerminalRuntimeOptions;

export type UseTerminalV2PaneRuntimeResult = {
  legacyOptions: Partial<UseLegacyTerminalRuntimeOptions>;
  focus: () => void;
};

const TERMINAL_V2_GEOMETRY_EVENT_ADAPTER = {
  resolveResizeEvent: resolveTerminalV2ResizeEvent,
  resolveInitialGeometryEvent: resolveTerminalV2InitialGeometryEvent,
  resolveCommitFitEvent: resolveTerminalV2CommitFitEvent,
};

export function useTerminalV2PaneRuntime(
  options: UseTerminalV2PaneRuntimeOptions,
): UseTerminalV2PaneRuntimeResult {
  const session = useTerminalV2Session({ paneId: options.paneId });
  const geometry = useTerminalV2Geometry({ runtime: session.runtime });
  const input = useTerminalV2Input({ runtime: session.runtime });
  const focusSearch = useTerminalV2FocusSearch({ onSearchReady: options.onSearchReady });
  const suggestions = useTerminalV2Suggestions({
    onSuggestionRemainderChange: options.onSuggestionRemainderChange,
    onSuggestionLayoutChange: options.onSuggestionLayoutChange,
  });
  const links = useTerminalV2Links({ onLinkContextMenu: options.onLinkContextMenu });
  const rendererFactory = useTerminalV2XtermRenderer();
  const rendererEventAdapter = useTerminalV2XtermEvents();
  const rendererBinding = useTerminalV2RendererBinding({
    runtime: session.runtime,
    paneId: options.paneId,
    active: options.active,
    focused: options.focused,
    liveResizeActive: options.liveResizeActive,
    agentCommand: options.agentCommand,
    onRendererHandlesReady: options.onRendererHandlesReady,
  });
  const focusRendererHandlesReady = focusSearch.onRendererHandlesReady;
  const rendererBindingHandlesReady = rendererBinding.onRendererHandlesReady;
  const focusSearchReady = focusSearch.onSearchReady;
  const focusTerminal = focusSearch.focus;

  const onRendererHandlesReady = useCallback<NonNullable<UseLegacyTerminalRuntimeOptions["onRendererHandlesReady"]>>((handles) => {
    const cleanupFns = [
      rendererBindingHandlesReady(handles),
      focusRendererHandlesReady(handles),
    ];
    return () => cleanupFns.forEach((cleanup) => cleanup());
  }, [focusRendererHandlesReady, rendererBindingHandlesReady]);

  const runtime = session.runtime;
  const rendererStandbyBacklog = useMemo(() => (runtime ? {
    isActive: (paneId: string) => runtime.isPaneRendererServedByPooledSlot(paneId),
    append: (paneId: string, data: string) => runtime.appendRendererStandbyBacklog(paneId, data),
    clear: (paneId: string) => runtime.clearRendererStandbyBacklog(paneId),
  } : undefined), [runtime]);
  const paneInputPipeline = useMemo(() => (runtime ? {
    register: (paneId: string, handleInput: (data: string) => void) => (
      runtime.registerPaneInputHandler(paneId, handleInput)
    ),
  } : undefined), [runtime]);

  const legacyOptions = useMemo<Partial<UseLegacyTerminalRuntimeOptions>>(() => ({
    hiddenOutputBufferFactory: HIDDEN_OUTPUT_BUFFER_FACTORY,
    onRendererHandlesReady,
    onSearchReady: focusSearchReady,
    sessionStarter: session.sessionStarter,
    sessionDetacher: session.sessionDetacher,
    sessionResizer: geometry.sessionResizer,
    sessionWriter: input.sessionWriter,
    revealPolicy: REVEAL_POLICY,
    suggestionAdapter: suggestions.suggestionAdapter,
    linkContextAdapter: links.linkContextAdapter,
    rendererFactory,
    rendererEventAdapter,
    inputEventProcessor: processTerminalV2InputEvent,
    outputEventProcessor: processTerminalV2OutputEvent,
    geometryEventAdapter: TERMINAL_V2_GEOMETRY_EVENT_ADAPTER,
    paneRuntimeFactory: createTerminalV2PaneRuntimeAdapter,
    writeSchedulerFactory: createTerminalV2WriteScheduler,
    ...(rendererStandbyBacklog ? { rendererStandbyBacklog } : {}),
    ...(paneInputPipeline ? { paneInputPipeline } : {}),
  }), [
    focusSearchReady,
    paneInputPipeline,
    rendererStandbyBacklog,
    geometry.sessionResizer,
    input.sessionWriter,
    links.linkContextAdapter,
    onRendererHandlesReady,
    rendererEventAdapter,
    rendererFactory,
    session.sessionDetacher,
    session.sessionStarter,
    suggestions.suggestionAdapter,
  ]);

  return {
    legacyOptions,
    focus: focusTerminal,
  };
}
