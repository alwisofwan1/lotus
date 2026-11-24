"use client";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { TerminalTheme } from "@/lib/design-system";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import {
  type TerminalLinkContextMenuPayload,
} from "@/modules/codespace/services/terminal-addons";
import { useLegacyTerminalRuntime } from "@/modules/codespace/hooks/useLegacyTerminalRuntime";
import type { TerminalShortcutEvent } from "@/modules/codespace/services/terminal-keybindings";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import { TerminalV2LinkContextMenu } from "@/modules/codespace/terminal-v2/components/TerminalV2LinkContextMenu";
import type { TerminalSearchMode } from "@/modules/codespace/services/terminal-search-options";

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

export interface LegacyInteractiveTerminalProps {
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
  claudeAccount?: string;
  /**
   * Agent CLI running in this cell (if any). Used to tag the
   * `terminal:spawned` bus event so listeners like the auto-dismiss hook
   * can decide per-provider behavior without re-deriving from workspace
   * state.
   */
  agentCommand?: string;
  terminalTheme?: TerminalTheme;
  renderAccelerationEligible?: boolean;
  onSearchReady?: (api: TerminalSearchAPI) => void;
  onCurrentDirectoryChange?: (cwd: string) => void;
  onTerminalCustomKey?: (event: TerminalShortcutEvent) => boolean | undefined;
  /** Workspace location metadata retained for compatibility with callers. */
  location?: CodeSpaceStoredWorkspaceLocation | null;
}

export const LegacyInteractiveTerminal = forwardRef<InteractiveTerminalHandle, LegacyInteractiveTerminalProps>(function LegacyInteractiveTerminal({
  workspaceId,
  paneId,
  cwd,
  fontSize = 11,
  active = true,
  history = [],
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
  renderAccelerationEligible,
  onSearchReady,
  onCurrentDirectoryChange,
  onTerminalCustomKey,
  location,
}, ref) {
  type InlineSuggestionOverlay = {
    text: string;
    left: number;
    top: number;
  };

  const inlineSuggestionOverlayRef = useRef<InlineSuggestionOverlay | null>(null);
  const inlineSuggestionTextRef = useRef("");
  const suggestionRemainderChangeRef = useRef<((remainder: string) => void) | null>(null);
  const suggestionLayoutChangeRef = useRef<(() => void) | null>(null);

  const [contextMenu, setContextMenu] = useState<TerminalLinkContextMenuPayload | null>(null);
  const [inlineSuggestionOverlay, setInlineSuggestionOverlay] = useState<InlineSuggestionOverlay | null>(null);

  const syncInlineSuggestionOverlay = useCallback((nextOverlay: InlineSuggestionOverlay | null) => {
    const currentOverlay = inlineSuggestionOverlayRef.current;
    const unchanged = currentOverlay?.text === nextOverlay?.text
      && currentOverlay?.left === nextOverlay?.left
      && currentOverlay?.top === nextOverlay?.top;

    if (unchanged) {
      return;
    }

    inlineSuggestionOverlayRef.current = nextOverlay;
    setInlineSuggestionOverlay(nextOverlay);
  }, []);

  const {
    containerRef,
    helperTextareaRef: runtimeHelperTextareaRef,
    revealState,
    write,
    focus,
    fit,
    fitViewport,
  } = useLegacyTerminalRuntime({
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
    renderAccelerationEligible,
    onSearchReady,
    onCurrentDirectoryChange,
    onTerminalCustomKey,
    location,
    onSuggestionRemainderChange: (remainder) => suggestionRemainderChangeRef.current?.(remainder),
    onSuggestionLayoutChange: () => suggestionLayoutChangeRef.current?.(),
    onLinkContextMenu: setContextMenu,
  });

  const renderInlineSuggestion = useCallback(() => {
    const activeSuggestionRemainder = inlineSuggestionTextRef.current;
    if (!activeSuggestionRemainder) {
      syncInlineSuggestionOverlay(null);
      return;
    }

    const container = containerRef.current;
    const helperTextarea = runtimeHelperTextareaRef.current;

    if (!container || !helperTextarea) {
      syncInlineSuggestionOverlay(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const helperRect = helperTextarea.getBoundingClientRect();

    syncInlineSuggestionOverlay({
      text: activeSuggestionRemainder,
      left: Math.max(0, helperRect.left - containerRect.left),
      top: Math.max(0, helperRect.top - containerRect.top),
    });
  }, [containerRef, runtimeHelperTextareaRef, syncInlineSuggestionOverlay]);

  const handleSuggestionRemainderChange = useCallback((remainder: string) => {
    inlineSuggestionTextRef.current = remainder;
    renderInlineSuggestion();
  }, [renderInlineSuggestion]);

  useEffect(() => {
    suggestionRemainderChangeRef.current = handleSuggestionRemainderChange;
    suggestionLayoutChangeRef.current = renderInlineSuggestion;
  }, [handleSuggestionRemainderChange, renderInlineSuggestion]);

  useImperativeHandle(ref, () => ({
    write,
    focus,
    fit,
    fitViewport,
  }), [fit, fitViewport, focus, write]);

  return (
    <div className={`codespace-interactive-terminal ${className ?? ""}`} style={{ height: "100%", width: "100%", position: "relative" }}>
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
      <TerminalV2LinkContextMenu
        contextMenu={contextMenu}
        cwd={cwd}
        onClose={(reason) => {
          setContextMenu(null);
          if (reason !== "outside") focus();
        }}
      />
    </div>
  );
});
