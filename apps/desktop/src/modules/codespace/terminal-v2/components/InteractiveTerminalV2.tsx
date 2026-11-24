"use client";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { TerminalTheme } from "@/lib/design-system";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import { activateDetectedLink, type TerminalLinkContextMenuPayload } from "@/modules/codespace/services/terminal-addons";
import { TerminalV2RendererDiagnostics } from "@/modules/codespace/terminal-v2/components/TerminalV2RendererDiagnostics";
import { TerminalV2LinkContextMenu } from "@/modules/codespace/terminal-v2/components/TerminalV2LinkContextMenu";
import type { FileTreeMenuCloseReason } from "@/modules/codespace/components/workbench/FileTreeContextMenu";
import {
  useTerminalV2RendererDiagnostics,
  useTerminalV2RendererDiagnosticsEnabled,
  useTerminalV2RuntimeDiagnostics,
} from "@/modules/codespace/terminal-v2/hooks/useTerminalV2RendererDiagnostics";
import { useTerminalV2NativeRuntime } from "@/modules/codespace/terminal-v2/hooks/useTerminalV2NativeRuntime";
import { useTerminalV2LegacyBridgeFallbackRuntime } from "@/modules/codespace/terminal-v2/hooks/useTerminalV2LegacyBridgeFallbackRuntime";
import { useTerminalV2InlineSuggestionOverlay } from "@/modules/codespace/terminal-v2/hooks/useTerminalV2InlineSuggestionOverlay";
import { useTerminalV2PooledRendererEvents } from "@/modules/codespace/terminal-v2/hooks/useTerminalV2PooledRendererEvents";
import { useOptionalTerminalV2Runtime } from "@/modules/codespace/terminal-v2/runtime/TerminalV2RuntimeProvider";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import {
  handleTerminalCustomKeyEvent,
  type TerminalShortcutEvent,
} from "@/modules/codespace/services/terminal-keybindings";
import { resolveTerminalShiftEnterSequence } from "@/modules/codespace/services/terminal-shift-enter";
import type { TerminalSearchMode } from "@/modules/codespace/services/terminal-search-options";
import { resolveTerminalV2NativeRuntimePolicy } from "./terminal-v2-native-runtime-policy";

export interface TerminalSearchAPI {
  findNext: (query: string, mode?: TerminalSearchMode) => boolean;
  findPrevious: (query: string) => boolean;
  clearSearch: () => void;
}

export interface InteractiveTerminalHandle {
  write: (data: string) => void;
  focus: () => void;
  fit: () => void;
  fitViewport: () => void;
}

const EMPTY_TERMINAL_HISTORY: string[] = [];

interface InteractiveTerminalProps {
  workspaceId: string;
  paneId: string;
  cwd: string;
  fontSize?: number;
  active?: boolean;
  history?: string[];
  className?: string;
  onExit?: (code: number) => void;
  onRuntimeSessionIdChange?: (sessionId: string | null) => void;
  onRuntimeStatusChange?: (status: TerminalRuntimeStatus) => void;
  onInlineCommandSubmit?: (command: string) => void;
  initialCommand?: string;
  terminalCommand?: string[];
  /** Lotus Claude account the PTY runs on (issues/07). */
  claudeAccount?: string;
  /**
   * Agent CLI running in this cell (if any). Used to tag the
   * `terminal:spawned` bus event so listeners like the auto-dismiss hook
   * can decide per-provider behavior without re-deriving from workspace
   * state.
   */
  agentCommand?: string;
  terminalTheme?: TerminalTheme;
  focused?: boolean;
  renderAccelerationEligible?: boolean;
  liveResizeActive?: boolean;
  onSearchReady?: (api: TerminalSearchAPI) => void;
  onCurrentDirectoryChange?: (cwd: string) => void;
  onTerminalCustomKey?: (event: TerminalShortcutEvent) => boolean | undefined;
  /** Workspace location metadata retained for compatibility with callers. */
  location?: CodeSpaceStoredWorkspaceLocation | null;
}

type RuntimeRefSnapshot = {
  containerRef: { current: HTMLDivElement | null } | null;
  helperTextareaRef: { current: HTMLTextAreaElement | null } | null;
};

export const InteractiveTerminalV2 = forwardRef<InteractiveTerminalHandle, InteractiveTerminalProps>(function InteractiveTerminalV2({
  workspaceId,
  paneId,
  cwd,
  fontSize = 11,
  active = true,
  history = EMPTY_TERMINAL_HISTORY,
  className,
  onExit,
  onRuntimeSessionIdChange,
  onRuntimeStatusChange,
  onInlineCommandSubmit,
  initialCommand,
  terminalCommand,
  claudeAccount,
  agentCommand,
  terminalTheme,
  focused = active,
  renderAccelerationEligible,
  liveResizeActive,
  onSearchReady,
  onCurrentDirectoryChange,
  onTerminalCustomKey,
  location,
}, ref) {
  const runtimePolicyRef = useRef(resolveTerminalV2NativeRuntimePolicy({
    rolloutMode: "default-on-all-environments",
  }));
  const useSelectedTerminalRuntime = runtimePolicyRef.current.kind === "native"
    ? useTerminalV2NativeRuntime
    : useTerminalV2LegacyBridgeFallbackRuntime;
  const pooledRendererHostRef = useRef<HTMLDivElement>(null);
  const selectedRuntimeRefsRef = useRef<RuntimeRefSnapshot>({
    containerRef: null,
    helperTextareaRef: null,
  });
  const [contextMenu, setContextMenu] = useState<TerminalLinkContextMenuPayload | null>(null);
  const runtimeContext = useOptionalTerminalV2Runtime();
  const rendererDiagnosticsEnabled = useTerminalV2RendererDiagnosticsEnabled();
  const rendererDiagnosticsSnapshot = useTerminalV2RendererDiagnostics({
    enabled: rendererDiagnosticsEnabled,
    runtime: runtimeContext?.runtime,
    refreshMs: 500,
  });
  const runtimeDiagnosticsSnapshot = useTerminalV2RuntimeDiagnostics({
    enabled: rendererDiagnosticsEnabled,
    runtime: runtimeContext?.runtime,
    refreshMs: 500,
  });
  const getContainer = useCallback(
    () => selectedRuntimeRefsRef.current.containerRef?.current ?? null,
    [],
  );
  const getFallbackHelperTextarea = useCallback(
    () => selectedRuntimeRefsRef.current.helperTextareaRef?.current ?? null,
    [],
  );
  const {
    inlineSuggestionOverlay,
    handleRuntimeSuggestionRemainderChange,
    handleRuntimeSuggestionLayoutChange,
  } = useTerminalV2InlineSuggestionOverlay({
    paneId,
    runtime: runtimeContext?.runtime,
    getContainer,
    getFallbackHelperTextarea,
  });

  // Shell editing keys (Cmd+Backspace, Cmd+Delete, Option+arrows, …) are not encoded by xterm on
  // macOS, so every terminal surface has to translate them itself. The pane owner's handler still
  // runs first — dynamic-layout shortcuts stay authoritative — and only unclaimed events fall
  // through to the shared table. Both renderer paths (native xterm and pooled slots) route here.
  const writeRef = useRef<(data: string) => void>(() => undefined);
  const onTerminalCustomKeyRef = useRef(onTerminalCustomKey);
  onTerminalCustomKeyRef.current = onTerminalCustomKey;
  // Shift+Enter inserts a newline instead of submitting; the bytes depend on what the pane runs.
  const shiftEnterSequenceRef = useRef(resolveTerminalShiftEnterSequence(agentCommand));
  shiftEnterSequenceRef.current = resolveTerminalShiftEnterSequence(agentCommand);
  const handleTerminalKey = useCallback((event: TerminalShortcutEvent) => {
    try {
      return handleTerminalCustomKeyEvent(
        event,
        (sequence) => writeRef.current(sequence),
        (candidate) => onTerminalCustomKeyRef.current?.(candidate),
        { shiftEnterSequence: () => shiftEnterSequenceRef.current },
      );
    } catch (error) {
      // This runs inside xterm's keydown path: a throw here would kill every subsequent keystroke
      // in the pane, so report it and hand the key back to xterm rather than losing the terminal.
      console.error("[terminal-v2] custom key handler failed:", error);
      return true;
    }
  }, []);

  const handleRuntimeLinkContextMenu = useCallback((payload: TerminalLinkContextMenuPayload) => {
    // Left-click opens the link directly (consistent with the legacy runtime and agent terminal);
    // right-click still opens the context menu.
    if (payload.trigger === "activate") {
      void activateDetectedLink(payload.link, cwd);
      return;
    }
    setContextMenu(payload);
  }, [cwd]);

  const {
    containerRef,
    helperTextareaRef: runtimeHelperTextareaRef,
    revealState,
    write,
    focus,
    fit,
    fitViewport,
  } = useSelectedTerminalRuntime({
    workspaceId,
    paneId,
    cwd,
    fontSize,
    active,
    history,
    onExit,
    onRuntimeSessionIdChange,
    onRuntimeStatusChange,
    onInlineCommandSubmit,
    initialCommand,
    terminalCommand,
    claudeAccount,
    agentCommand,
    terminalTheme,
    focused,
    renderAccelerationEligible,
    liveResizeActive,
    onSearchReady,
    onCurrentDirectoryChange,
    onTerminalCustomKey: handleTerminalKey,
    location,
    onSuggestionRemainderChange: handleRuntimeSuggestionRemainderChange,
    onSuggestionLayoutChange: handleRuntimeSuggestionLayoutChange,
    onLinkContextMenu: handleRuntimeLinkContextMenu,
  });
  selectedRuntimeRefsRef.current.containerRef = containerRef;
  selectedRuntimeRefsRef.current.helperTextareaRef = runtimeHelperTextareaRef;
  writeRef.current = write;

  useEffect(() => {
    const runtime = runtimeContext?.runtime;
    const paneContainer = containerRef.current;
    if (!runtime || !paneContainer) return;
    return runtime.registerPooledRendererPaneContainer(paneId, paneContainer);
  }, [containerRef, paneId, runtimeContext?.runtime]);

  useTerminalV2PooledRendererEvents({
    rootRef: pooledRendererHostRef,
    onLinkContextMenu: handleRuntimeLinkContextMenu,
    onTerminalCustomKey: handleTerminalKey,
  });

  const focusVisibleRenderer = useCallback(() => {
    if (runtimeContext?.runtime?.focusPaneRenderer(paneId)) return;
    focus();
  }, [focus, paneId, runtimeContext?.runtime]);
  const closeContextMenu = useCallback((reason: FileTreeMenuCloseReason) => {
    setContextMenu(null);
    // A click elsewhere already moved focus where the user wanted it.
    if (reason !== "outside") focusVisibleRenderer();
  }, [focusVisibleRenderer]);

  useImperativeHandle(ref, () => ({
    write,
    focus: focusVisibleRenderer,
    fit,
    fitViewport,
  }), [fit, fitViewport, focusVisibleRenderer, write]);

  return (
    <div
      ref={pooledRendererHostRef}
      className={`codespace-interactive-terminal ${className ?? ""}`}
      data-terminal-v2-runtime-policy={runtimePolicyRef.current.kind}
      data-terminal-v2-pooled-renderer={runtimeContext?.pooledRendererEnabled ? "enabled" : "disabled"}
      style={{ height: "100%", width: "100%", position: "relative" }}
    >
      <div
        ref={containerRef}
        className="codespace-terminal-host"
        style={{ height: "100%", width: "100%" }}
      />
      {revealState === "warming" ? (
        <div
          aria-hidden="true"
          className="codespace-terminal-reveal-mask"
          data-terminal-reveal-state={revealState}
        />
      ) : null}
      {inlineSuggestionOverlay ? (
        <div
          className="terminal-inline-suggestion"
          style={{
            left: `${inlineSuggestionOverlay.left}px`,
            top: `${inlineSuggestionOverlay.top}px`,
            position: "absolute",
          }}
        >
          {inlineSuggestionOverlay.text}
        </div>
      ) : null}
      <TerminalV2RendererDiagnostics
        enabled={rendererDiagnosticsEnabled}
        snapshot={rendererDiagnosticsSnapshot}
        runtimeSnapshot={runtimeDiagnosticsSnapshot}
      />
      <TerminalV2LinkContextMenu
        contextMenu={contextMenu}
        cwd={cwd}
        onClose={closeContextMenu}
      />
    </div>
  );
});
