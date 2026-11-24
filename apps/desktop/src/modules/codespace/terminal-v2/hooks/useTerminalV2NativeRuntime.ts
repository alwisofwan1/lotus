"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type {
  TerminalRevealState,
  UseLegacyTerminalRuntimeOptions,
} from "@/modules/codespace/hooks/useLegacyTerminalRuntime";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import {
  resolveTerminalV2CommitFitEvent,
  resolveTerminalV2InitialGeometryEvent,
  resolveTerminalV2ResizeEvent,
  type TerminalV2PtyResizeDebouncer,
} from "../geometry/terminal-v2-geometry-event-adapter";
import { createTerminalV2NativeStatusNotifier } from "../runtime/terminal-v2-native-status";
import { useTerminalV2NativeRendererLifecycle, type TerminalV2NativeRendererHandles } from "./useTerminalV2NativeRendererLifecycle";
import { useTerminalV2PaneRuntime } from "./useTerminalV2PaneRuntime";

export type UseTerminalV2NativeRuntimeOptions = UseLegacyTerminalRuntimeOptions;

export type UseTerminalV2NativeRuntimeResult = {
  containerRef: RefObject<HTMLDivElement | null>;
  helperTextareaRef: RefObject<HTMLTextAreaElement | null>;
  revealState: TerminalRevealState;
  write(data: string): void;
  focus(): void;
  fit(): void;
  fitViewport(): void;
};

export function useTerminalV2NativeRuntime(
  options: UseTerminalV2NativeRuntimeOptions,
): UseTerminalV2NativeRuntimeResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const helperTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rendererHandlesRef = useRef<TerminalV2NativeRendererHandles | null>(null);
  const resizeDebouncerRef = useRef<TerminalV2PtyResizeDebouncer | null>(null);
  const lastFittedGeometryRef = useRef<{ cols: number | null; rows: number | null }>({ cols: null, rows: null });
  const sentInitialCommandKeysRef = useRef<Set<string>>(new Set());
  const notifiedSearchAddonRef = useRef<object | null>(null);
  const lastRuntimeStatusRef = useRef<TerminalRuntimeStatus | null>(null);
  const nativeSessionLiveRef = useRef(false);
  const liveResizeActive = options.liveResizeActive ?? false;
  const liveResizeActiveRef = useRef(liveResizeActive);
  const previousLiveResizeActiveRef = useRef(liveResizeActive);
  const [hasRendered, setHasRendered] = useState(false);
  const paneRuntime = useTerminalV2PaneRuntime(options);
  const legacyOptions = paneRuntime.legacyOptions;
  const legacyOptionsRef = useRef(legacyOptions);
  const {
    active,
    agentCommand,
    allowTransparency,
    claudeAccount,
    cwd,
    fontSize,
    history,
    initialCommand,
    location,
    onCurrentDirectoryChange,
    onExit,
    onInlineCommandSubmit,
    onTerminalCustomKey,
    onRuntimeSessionIdChange,
    onRuntimeStatusChange,
    paneId,
    terminalCommand,
    terminalTheme,
    workspaceId,
  } = options;

  const onCurrentDirectoryChangeRef = useRef(onCurrentDirectoryChange);
  const onExitRef = useRef(onExit);
  const onInlineCommandSubmitRef = useRef(onInlineCommandSubmit);
  const onRuntimeSessionIdChangeRef = useRef(onRuntimeSessionIdChange);
  const onRuntimeStatusChangeRef = useRef(onRuntimeStatusChange);
  const onTerminalCustomKeyRef = useRef(onTerminalCustomKey);

  useEffect(() => {
    legacyOptionsRef.current = legacyOptions;
    onCurrentDirectoryChangeRef.current = onCurrentDirectoryChange;
    onExitRef.current = onExit;
    onInlineCommandSubmitRef.current = onInlineCommandSubmit;
    onRuntimeSessionIdChangeRef.current = onRuntimeSessionIdChange;
    onRuntimeStatusChangeRef.current = onRuntimeStatusChange;
    onTerminalCustomKeyRef.current = onTerminalCustomKey;
  }, [
    legacyOptions,
    onCurrentDirectoryChange,
    onExit,
    onInlineCommandSubmit,
    onRuntimeSessionIdChange,
    onRuntimeStatusChange,
    onTerminalCustomKey,
  ]);

  const stableLegacyOptions = useMemo<Partial<UseLegacyTerminalRuntimeOptions>>(() => ({
    rendererFactory: (request) => {
      const factory = legacyOptionsRef.current.rendererFactory;
      if (!factory) return Promise.reject(new Error("Terminal V2 renderer factory unavailable"));
      return factory(request);
    },
    onRendererHandlesReady: (handles) => legacyOptionsRef.current.onRendererHandlesReady?.(handles),
    onSearchReady: (api) => legacyOptionsRef.current.onSearchReady?.(api),
    sessionStarter: {
      start: (request) => {
        const starter = legacyOptionsRef.current.sessionStarter;
        if (!starter) return Promise.reject(new Error("Terminal V2 session starter unavailable"));
        return starter.start(request);
      },
    },
    sessionResizer: {
      resize: (nextPaneId, cols, rows) => legacyOptionsRef.current.sessionResizer?.resize(nextPaneId, cols, rows),
    },
    sessionDetacher: {
      detach: (nextPaneId) => legacyOptionsRef.current.sessionDetacher?.detach(nextPaneId),
    },
    sessionWriter: {
      write: (nextPaneId, data, metadata) => {
        if (metadata === undefined) {
          legacyOptionsRef.current.sessionWriter?.write(nextPaneId, data);
          return;
        }
        legacyOptionsRef.current.sessionWriter?.write(nextPaneId, data, metadata);
      },
    },
    suggestionAdapter: {
      remainderChanged: (remainder) => legacyOptionsRef.current.suggestionAdapter?.remainderChanged(remainder),
      layoutChanged: () => legacyOptionsRef.current.suggestionAdapter?.layoutChanged(),
    },
    linkContextAdapter: {
      openContextMenu: (payload, containerRect) => legacyOptionsRef.current.linkContextAdapter?.openContextMenu(payload, containerRect),
    },
    rendererEventAdapter: (request) => legacyOptionsRef.current.rendererEventAdapter?.(request) ?? { dispose: () => undefined },
    inputEventProcessor: (request) => legacyOptionsRef.current.inputEventProcessor?.(request) ?? {
      nextInput: request.currentInput,
      suggestionRemainder: "",
      submittedPrompt: "",
      writeRequest: { data: request.data, metadata: { origin: "human", intent: "unknown", submitted: false } },
      cwdProbeCommand: null,
    },
    outputEventProcessor: (request) => legacyOptionsRef.current.outputEventProcessor?.(request) ?? {
      visibleData: request.data,
      cwdUpdates: [],
      osc133Events: [],
      exitCode: null,
      outputRoute: "visible",
      nextTrustPromptSeen: false,
      autoTrustResponse: null,
      rememberTrustedCwd: false,
      resizeAfterTrust: false,
      scheduleSuggestionLayout: false,
    },
    geometryEventAdapter: {
      resolveResizeEvent: (request) => legacyOptionsRef.current.geometryEventAdapter?.resolveResizeEvent(request) ?? resolveTerminalV2ResizeEvent(request),
      resolveInitialGeometryEvent: (geometry) => legacyOptionsRef.current.geometryEventAdapter?.resolveInitialGeometryEvent(geometry) ?? resolveTerminalV2InitialGeometryEvent(geometry),
      resolveCommitFitEvent: (request) => legacyOptionsRef.current.geometryEventAdapter?.resolveCommitFitEvent(request) ?? resolveTerminalV2CommitFitEvent(request),
    },
    paneRuntimeFactory: legacyOptions.paneRuntimeFactory,
    hiddenOutputBufferFactory: legacyOptions.hiddenOutputBufferFactory,
    revealPolicy: legacyOptions.revealPolicy,
    paneInputPipeline: {
      register: (nextPaneId, handleInput) => (
        legacyOptionsRef.current.paneInputPipeline?.register(nextPaneId, handleInput) ?? (() => undefined)
      ),
    },
    rendererStandbyBacklog: {
      isActive: (nextPaneId) => legacyOptionsRef.current.rendererStandbyBacklog?.isActive(nextPaneId) ?? false,
      append: (nextPaneId, data) => legacyOptionsRef.current.rendererStandbyBacklog?.append(nextPaneId, data),
      clear: (nextPaneId) => legacyOptionsRef.current.rendererStandbyBacklog?.clear(nextPaneId),
    },
    writeSchedulerFactory: (request) => legacyOptionsRef.current.writeSchedulerFactory?.(request) ?? {
      push: () => undefined,
      flush: () => undefined,
      dispose: () => undefined,
      hasPending: () => false,
    },
  }), [legacyOptions.hiddenOutputBufferFactory, legacyOptions.paneRuntimeFactory, legacyOptions.revealPolicy]);

  useLayoutEffect(() => {
    liveResizeActiveRef.current = liveResizeActive;
  }, [liveResizeActive]);

  const revealState: TerminalRevealState = active === false ? "hidden" : hasRendered ? "settled" : "warming";

  const notifyRuntimeStatus = useCallback((status: TerminalRuntimeStatus) => {
    const notifier = createTerminalV2NativeStatusNotifier({
      initialStatus: lastRuntimeStatusRef.current,
      onStatusChange: onRuntimeStatusChangeRef.current,
    });
    if (notifier.notify(status)) {
      lastRuntimeStatusRef.current = notifier.getLastStatus();
    }
  }, []);

  const handleCurrentDirectoryChange = useCallback((nextCwd: string) => {
    onCurrentDirectoryChangeRef.current?.(nextCwd);
  }, []);

  const handleExit = useCallback((code: number) => {
    onExitRef.current?.(code);
  }, []);

  const handleInlineCommandSubmit = useCallback((command: string) => {
    onInlineCommandSubmitRef.current?.(command);
  }, []);

  const handleRuntimeSessionIdChange = useCallback((sessionId: string | null) => {
    onRuntimeSessionIdChangeRef.current?.(sessionId);
  }, []);

  const handleTerminalCustomKey = useCallback((event: Parameters<NonNullable<typeof onTerminalCustomKey>>[0]) => (
    onTerminalCustomKeyRef.current?.(event)
  ), []);

  useTerminalV2NativeRendererLifecycle({
    active,
    agentCommand,
    allowTransparency,
    claudeAccount,
    containerRef,
    cwd,
    fontSize,
    helperTextareaRef,
    history,
    initialCommand,
    lastFittedGeometryRef,
    legacyOptions: stableLegacyOptions,
    liveResizeActiveRef,
    location,
    nativeSessionLiveRef,
    notifiedSearchAddonRef,
    notifyRuntimeStatus,
    onCurrentDirectoryChange: handleCurrentDirectoryChange,
    onExit: handleExit,
    onInlineCommandSubmit: handleInlineCommandSubmit,
    onRuntimeSessionIdChange: handleRuntimeSessionIdChange,
    onTerminalCustomKey: handleTerminalCustomKey,
    paneId,
    rendererHandlesRef,
    resizeDebouncerRef,
    sentInitialCommandKeysRef,
    setHasRendered,
    terminalCommand,
    terminalTheme,
    workspaceId,
  });

  const write = useCallback((data: string) => {
    stableLegacyOptions.sessionWriter?.write(paneId, data);
  }, [paneId, stableLegacyOptions.sessionWriter]);

  const focus = useCallback(() => {
    rendererHandlesRef.current?.terminal.focus?.();
    paneRuntime.focus();
  }, [paneRuntime]);

  const fit = useCallback(() => {
    const handles = rendererHandlesRef.current;
    if (!handles) return;
    const decision = (stableLegacyOptions.geometryEventAdapter?.resolveCommitFitEvent ?? resolveTerminalV2CommitFitEvent)({
      active: active !== false,
    });
    if (decision.kind !== "fit-and-flush") return;
    handles.fitAddon.fit();
    const cols = handles.terminal.cols;
    const rows = handles.terminal.rows;
    if (Number.isFinite(cols)) lastFittedGeometryRef.current.cols = cols!;
    if (Number.isFinite(rows)) lastFittedGeometryRef.current.rows = rows!;
    if (Number.isFinite(cols) && Number.isFinite(rows)) {
      resizeDebouncerRef.current?.cancel();
      stableLegacyOptions.sessionResizer?.resize(paneId, cols!, rows!);
    }
  }, [active, paneId, stableLegacyOptions.geometryEventAdapter, stableLegacyOptions.sessionResizer]);

  const fitViewport = useCallback(() => {
    rendererHandlesRef.current?.fitAddon.fit();
  }, []);

  useEffect(() => {
    const wasLiveResizing = previousLiveResizeActiveRef.current;
    previousLiveResizeActiveRef.current = liveResizeActive;
    if (!wasLiveResizing || liveResizeActive) return;
    fit();
  }, [fit, liveResizeActive]);

  return { containerRef, helperTextareaRef, revealState, write, focus, fit, fitViewport };
}
