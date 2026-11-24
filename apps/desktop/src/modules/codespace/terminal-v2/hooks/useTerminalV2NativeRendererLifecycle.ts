"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { UseLegacyTerminalRuntimeOptions } from "@/modules/codespace/hooks/useLegacyTerminalRuntime";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import type { TerminalV2PtyResizeDebouncer } from "../geometry/terminal-v2-geometry-event-adapter";
import {
  createTerminalV2NativeRuntimeWiring,
  type TerminalV2NativeRuntimeWiringHandles,
} from "../runtime/terminal-v2-native-runtime-wiring";

type RefCell<T> = { current: T };

const NATIVE_RESIZE_FIT_SETTLE_MS = 80;
const NATIVE_AGENT_RESIZE_FIT_SETTLE_MS = 320;

export type TerminalV2NativeRendererHandles = TerminalV2NativeRuntimeWiringHandles;

export type UseTerminalV2NativeRendererLifecycleOptions = Pick<
  UseLegacyTerminalRuntimeOptions,
  | "active"
  | "agentCommand"
  | "allowTransparency"
  | "claudeAccount"
  | "cwd"
  | "fontSize"
  | "history"
  | "initialCommand"
  | "location"
  | "onCurrentDirectoryChange"
  | "onExit"
  | "onInlineCommandSubmit"
  | "onRuntimeSessionIdChange"
  | "onTerminalCustomKey"
  | "paneId"
  | "terminalCommand"
  | "terminalTheme"
  | "workspaceId"
> & {
  containerRef: RefObject<HTMLDivElement | null>;
  helperTextareaRef: RefCell<HTMLTextAreaElement | null>;
  lastFittedGeometryRef: RefCell<{ cols: number | null; rows: number | null }>;
  legacyOptions: Partial<UseLegacyTerminalRuntimeOptions>;
  liveResizeActiveRef: RefCell<boolean>;
  nativeSessionLiveRef: RefCell<boolean>;
  notifiedSearchAddonRef: RefCell<object | null>;
  notifyRuntimeStatus: (status: TerminalRuntimeStatus) => void;
  rendererHandlesRef: RefCell<TerminalV2NativeRendererHandles | null>;
  resizeDebouncerRef: RefCell<TerminalV2PtyResizeDebouncer | null>;
  sentInitialCommandKeysRef: RefCell<Set<string>>;
  setHasRendered: (rendered: boolean) => void;
};

export function useTerminalV2NativeRendererLifecycle({
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
  legacyOptions,
  liveResizeActiveRef,
  location,
  nativeSessionLiveRef,
  notifiedSearchAddonRef,
  notifyRuntimeStatus,
  onCurrentDirectoryChange,
  onExit,
  onInlineCommandSubmit,
  onRuntimeSessionIdChange,
  onTerminalCustomKey,
  paneId,
  rendererHandlesRef,
  resizeDebouncerRef,
  sentInitialCommandKeysRef,
  setHasRendered,
  terminalCommand,
  terminalTheme,
  workspaceId,
}: UseTerminalV2NativeRendererLifecycleOptions): void {
  // A theme or font size change restyles the live terminal instead of recreating it: recreating
  // dropped and re-attached every pane's renderer and session on each change, which held a theme
  // switch for close to a second in the Code mode. The renderer is created with whatever is current.
  const terminalThemeRef = useRef(terminalTheme);
  const fontSizeRef = useRef(fontSize);
  const liveRendererRef = useRef<{
    terminal: { options?: { theme?: unknown; fontSize?: number } };
    refit: () => void;
  } | null>(null);
  useEffect(() => {
    terminalThemeRef.current = terminalTheme;
    const options = liveRendererRef.current?.terminal.options;
    if (options && terminalTheme) options.theme = terminalTheme;
  }, [terminalTheme]);
  useEffect(() => {
    fontSizeRef.current = fontSize;
    const live = liveRendererRef.current;
    if (!live?.terminal.options || live.terminal.options.fontSize === fontSize) return;
    live.terminal.options.fontSize = fontSize;
    // A new font size changes how many cells fit; the PTY has to follow.
    live.refit();
  }, [fontSize]);

  useEffect(() => {
    if (active === false) {
      setHasRendered(false);
      return undefined;
    }

    const container = containerRef.current;
    const rendererFactory = legacyOptions.rendererFactory;
    if (!container || !rendererFactory) return undefined;

    let disposed = false;
    let disposeRenderer: (() => void) | undefined;
    let disposeWiring: (() => void) | undefined;
    let lastObservedSize: { width: number; height: number } | null = null;
    let resizeFitTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const clearResizeFitTimer = () => {
      if (resizeFitTimer !== null) clearTimeout(resizeFitTimer);
      resizeFitTimer = null;
    };

    const createdFontSize = fontSizeRef.current;
    void rendererFactory({
      container,
      cwd,
      fontSize: createdFontSize,
      terminalTheme: terminalThemeRef.current,
      allowTransparency: allowTransparency ?? false,
      isDisposed: () => disposed,
      onLinkContextMenu: (payload) => legacyOptions.linkContextAdapter?.openContextMenu(payload, container.getBoundingClientRect()),
    }).then((renderer) => {
      if (disposed) {
        renderer.dispose();
        return;
      }

      disposeRenderer = renderer.dispose;
      const wiring = createTerminalV2NativeRuntimeWiring({
        active,
        agentCommand,
        claudeAccount,
        container,
        cwd,
        disposed: () => disposed,
        history,
        initialCommand,
        lastFittedGeometryRef,
        legacyOptions,
        liveResizeActiveRef,
        location,
        nativeSessionLiveRef,
        notifiedSearchAddonRef,
        notifyRuntimeStatus,
        onCurrentDirectoryChange,
        onExit,
        onInlineCommandSubmit,
        onRuntimeSessionIdChange,
        onTerminalCustomKey,
        paneId,
        renderer,
        resizeDebouncerRef,
        sentInitialCommandKeysRef,
        setHasRendered,
        terminalCommand,
        workspaceId,
      });
      rendererHandlesRef.current = wiring.handles;
      liveRendererRef.current = { terminal: renderer.terminal, refit: () => wiring.resizeBinding.performResizeFit() };
      // The look may have changed while the renderer was being created.
      const options = renderer.terminal?.options;
      if (options && terminalThemeRef.current) options.theme = terminalThemeRef.current;
      if (options && createdFontSize !== fontSizeRef.current) {
        options.fontSize = fontSizeRef.current;
        wiring.resizeBinding.performResizeFit();
      }
      helperTextareaRef.current = wiring.helperTextarea;
      disposeWiring = wiring.dispose;

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (!entry) return;
          const nextSize = { width: entry.contentRect.width, height: entry.contentRect.height };
          if (lastObservedSize?.width === nextSize.width && lastObservedSize.height === nextSize.height) return;
          lastObservedSize = nextSize;
          clearResizeFitTimer();
          if (liveResizeActiveRef.current) return;
          resizeFitTimer = setTimeout(() => {
            resizeFitTimer = null;
            if (disposed) return;
            wiring.resizeBinding.performResizeFit();
          }, agentCommand ? NATIVE_AGENT_RESIZE_FIT_SETTLE_MS : NATIVE_RESIZE_FIT_SETTLE_MS);
        });
        resizeObserver.observe(container);
      }

      wiring.startSession();
    }).catch((error: unknown) => {
      if (disposed) return;
      notifyRuntimeStatus("failed");
      console.error("[terminal-v2] Native renderer failed:", error);
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      clearResizeFitTimer();
      legacyOptions.sessionDetacher?.detach(paneId);
      disposeWiring?.();
      disposeRenderer?.();
      resizeDebouncerRef.current = null;
      rendererHandlesRef.current = null;
      liveRendererRef.current = null;
      helperTextareaRef.current = null;
    };
  }, [
    legacyOptions,
    active,
    agentCommand,
    allowTransparency,
    claudeAccount,
    containerRef,
    cwd,
    helperTextareaRef,
    history,
    initialCommand,
    lastFittedGeometryRef,
    liveResizeActiveRef,
    location,
    nativeSessionLiveRef,
    notifiedSearchAddonRef,
    notifyRuntimeStatus,
    onCurrentDirectoryChange,
    onExit,
    onInlineCommandSubmit,
    onRuntimeSessionIdChange,
    onTerminalCustomKey,
    paneId,
    rendererHandlesRef,
    resizeDebouncerRef,
    sentInitialCommandKeysRef,
    setHasRendered,
    terminalCommand,
    workspaceId,
  ]);
}
