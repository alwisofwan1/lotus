"use client";

import { useContext, useMemo, type SyntheticEvent } from "react";
import { useSettledElementSize } from "@/modules/workspace-shell/hooks/useSettledElementSize";
import { usePaneRevealVeil } from "@/modules/workspace-shell/hooks/usePaneRevealVeil";
import { InteractiveTerminalV2 } from "@/modules/codespace/terminal-v2/components/InteractiveTerminalV2";
import { LegacyInteractiveTerminal } from "@/modules/codespace/components/LegacyInteractiveTerminal";
import { resolveTerminalV2SurfacePolicy } from "@/modules/codespace/terminal-v2/components/terminal-v2-surface-policy";
import { useOptionalTerminalV2Runtime } from "@/modules/codespace/terminal-v2/runtime/TerminalV2RuntimeProvider";
import { useTerminalPreferences } from "@/modules/codespace/hooks/useTerminalPreferences";
import { resolveCodeSpaceTerminalRenderTheme } from "@/modules/codespace/services/codespace-terminal-render-theme";
import { useTheme } from "@/contexts/ThemeContext";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import { ChatCell } from "@/modules/codespace/components/ChatCell";
import { codeBrowserSlot } from "@/modules/codespace/services/webview-registry";
import type { BrowserAnnotationPayload } from "@/lib/tauri/browser-preview";
import { BrowserSurface } from "@/modules/chat/ui/ChatPreview";
import { addressOf } from "@/modules/chat/domain/preview";
import { BrowserLinkChip } from "@/modules/workspace-shell/components/BrowserLinkChip";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import type { ChatCellData, GridCell, WorkbenchCellData, Workspace } from "@/modules/codespace/components/types";
import { paneFileDropAttributes } from "@/modules/workspace-shell/services/pane-file-drop";
import { PaneHeaderSlot } from "@/modules/workspace-shell/components/PaneCard";
import { SshLinkStrip, holdsInput, useLinkStrip } from "@/modules/workspace-shell/components/SshLinkStrip";
import "@/styles/pane-veil.css";

interface PaneBodyProps {
  workspace: Workspace;
  cell: GridCell;
  focused: boolean;
  /** On screen now: the pane's workspace is shown and focus mode is not hiding it. */
  active: boolean;
  /** The terminal keeps its renderer; true for a hidden workspace too (see `isPaneAttached`). */
  attached: boolean;
  /** Focus mode has maximised this pane. */
  maximized: boolean;
  onRuntimeSessionIdChange: (paneId: string, sessionId: string | null) => void;
  onRuntimeStatusChange: (paneId: string, status: TerminalRuntimeStatus) => void;
  /** The agent's process exited on its own (Ctrl+C, /exit): the pane goes back to a shell. */
  onAgentExit?: (paneId: string) => void;
  onBrowserUrlChange: (paneId: string, url: string) => void;
  /** An element picked on a Browser pane's page. */
  onBrowserPick?: (paneId: string, payload: BrowserAnnotationPayload) => void;
  /** A Browser pane's agent: who its picks go to, and the chip that shows and changes it. */
  browserLink?: Parameters<typeof BrowserLinkChip>[0];
  onUpdateWorkbenchCell: (
    paneId: string,
    updater: (cell: WorkbenchCellData) => WorkbenchCellData,
  ) => void;
  /** New Chat (beta, 07d): the thread a chat pane runs. */
  onChatThreadChange?: (paneId: string, thread: NonNullable<ChatCellData["thread"]>) => void;
  onClosePane?: (paneId: string) => void;
}

/**
 * The real content of a pane, inside the shell's own card.
 *
 * Deliberately NOT `GridCellRenderer`: that component brings CodeSpace's pane chrome with it —
 * its own header, its own split buttons — and the shell already draws a header. What is reused
 * here is one level lower: the surfaces themselves, which have no chrome of their own.
 *
 * So a terminal in this shell is the same `InteractiveTerminalV2`, on the same PTY session, as a
 * terminal in CodeSpace. Nothing is re-implemented; only the frame around it changed.
 */
export function PaneBody({
  workspace,
  cell,
  focused,
  active,
  attached,
  maximized,
  onRuntimeSessionIdChange,
  onRuntimeStatusChange,
  onAgentExit,
  onBrowserUrlChange,
  onBrowserPick,
  browserLink,
  onUpdateWorkbenchCell,
  onChatThreadChange,
  onClosePane,
}: PaneBodyProps) {
  const [surfaceRef, surface] = useSettledElementSize<HTMLDivElement>();
  const headerSlot = useContext(PaneHeaderSlot);
  const terminalRuntime = useOptionalTerminalV2Runtime();
  const { terminalFontSize } = useTerminalPreferences();
  const { theme, themeId } = useTheme();
  // Keyed on the theme id, like CodeSpace does: rebuilding this objecton every render would hand xterm
  // a new theme on every paint.
  const termTheme = useMemo(
    () => resolveCodeSpaceTerminalRenderTheme(theme),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themeId],
  );
  const terminalPolicy = resolveTerminalV2SurfacePolicy({
    featureEnabled: terminalRuntime?.featureEnabled ?? false,
    runtimeActive: terminalRuntime?.active ?? false,
  });
  const rendererRuntime = terminalRuntime?.runtime ?? null;
  const subscribeOutput = useMemo(
    () => (rendererRuntime && cell.type === "terminal"
      ? (paneId: string, listener: (data: string) => void) => rendererRuntime.subscribePaneOutput(paneId, listener)
      : null),
    [rendererRuntime, cell.type],
  );
  const veilPhase = usePaneRevealVeil({
    paneId: cell.id,
    attached,
    maximized,
    subscribeOutput,
    restartKey: cell.type === "terminal" ? cell.claudeAccount ?? null : null,
    // No session yet: just launched, or restored at app start (workspace-metadata clears the id);
    // both boot a fresh agent, so both get the focus-mode sheen until it prints.
    boot: cell.type === "terminal" && !cell.runtimeSessionId,
  });
  // A remote pane's link to its machine (plans/ssh-pane-durability, phase 3).
  const link = useLinkStrip(
    cell.type === "terminal" ? cell.runtimeSessionId : null,
    cell.type === "terminal" && cell.terminalCommand?.[0] === "ssh",
  );
  const linkHeld = holdsInput(link.state);
  // React's capture handlers run at the root, before xterm's own textarea listeners see the key.
  const holdInput = veilPhase === "restart" || linkHeld
    ? (event: SyntheticEvent) => {
      event.preventDefault();
      event.stopPropagation();
    }
    : undefined;

  if (cell.type === "chat") {
    return (
      <ChatCell
        cell={cell}
        workspaceId={workspace.id}
        onThreadChange={onChatThreadChange && ((thread) => onChatThreadChange(cell.id, thread))}
        onClose={onClosePane && (() => onClosePane(cell.id))}
        headerSlot={headerSlot}
        focused={focused}
      />
    );
  }

  if (cell.type === "browser") {
    return (
      // Chat's Preview browser (plans/code-browser-redesign): its bar in the pane header, pinned
      // because several stay on screen, ⌘⇧C only on the focused one.
      <BrowserSurface
        slot={codeBrowserSlot(cell.id)}
        url={addressOf(cell.url)}
        root={cell.cwd}
        detected={null}
        onNavigate={(url) => onBrowserUrlChange(cell.id, url)}
        onPick={(payload) => onBrowserPick?.(cell.id, payload)}
        active={active}
        pinned
        barSlot={headerSlot}
        barExtra={browserLink ? <BrowserLinkChip {...browserLink} /> : null}
        shortcut={focused}
      />
    );
  }

  if (cell.type === "workbench") {
    return (
      <WorkbenchCell
        cell={cell}
        location={workspace.location ?? null}
        enabled={active}
        onCellChange={(updater) => onUpdateWorkbenchCell(cell.id, updater)}
      />
    );
  }

  // Which terminal implementation is live is a POLICY, not a preference: terminal-v2 needs both
  // its feature flag and an active runtime, and picking it blindly is how a pane ends up with no
  // session starter at all ("Terminal V2 session starter unavailable"). CodeSpace asks the same
  // question through its own selector; this is the surface-only half of that decision.
  const TerminalSurface = terminalPolicy.useV2 ? InteractiveTerminalV2 : LegacyInteractiveTerminal;

  /**
   * The terminal waits for a real box before it mounts.
   *
   * Not merely a non-zero box: a SETTLED one. The first measurement arrives while the layout is
   * still landing, and xterm fits its character grid once, at mount. Fitting to a box that is
   * about to change leaves the text and the cursor on a stale grid until something forces a
   * refit — which is exactly why dragging the sidebar made the terminal snap into place.
   *
   * It also spares the PTY a burst of resizes at startup, each of which makes an agent CLI
   * repaint its whole banner.
   */
  return (
    /*
      The surface is also the file-drop target, and it is marked BEFORE the terminal mounts.
      A native drop is resolved by hit-testing the DOM (`useTerminalFileDrop`), so a pane whose
      marker appeared only once xterm had settled would silently refuse every drop during the
      seconds a workspace takes to come up — exactly when someone is most likely to drag a file in.
    */
    <div
      className="ws-pane-surface"
      ref={surfaceRef}
      onKeyDownCapture={holdInput}
      onKeyPressCapture={holdInput}
      onBeforeInputCapture={holdInput}
      onPasteCapture={holdInput}
      data-link-held={linkHeld ? "true" : undefined}
      {...paneFileDropAttributes(cell, workspace)}
    >
      {surface ? (
        <TerminalSurface
          workspaceId={workspace.id}
          paneId={cell.id}
          cwd={cell.cwd}
          active={attached}
          focused={focused}
          fontSize={terminalFontSize}
          terminalTheme={termTheme}
          // The WebGL gate. Without it xterm stays on its DOM renderer, which is what "berat dan
          // lambat" looks like — measured the same way CodeSpace decides it: the focused pane of an
          // active surface is the one that gets the accelerated renderer.
          renderAccelerationEligible={active && focused}
          className="h-full"
          initialCommand={cell.agentCommand}
          agentCommand={cell.agentCommand}
          claudeAccount={cell.claudeAccount}
          terminalCommand={cell.terminalCommand}
          location={workspace.location ?? null}
              onRuntimeSessionIdChange={(sessionId) => onRuntimeSessionIdChange(cell.id, sessionId)}
              onRuntimeStatusChange={(status) => onRuntimeStatusChange(cell.id, status)}
              // Only the PTY's own end marker calls this; closing or restarting a pane aborts the
              // session first, so its marker never arrives here (terminal-v2-session-manager).
              onExit={(code) => {
                link.onExit(code);
                if (cell.agentCommand) onAgentExit?.(cell.id);
              }}
            />
      ) : null}
      {cell.type === "terminal" ? (
        <SshLinkStrip state={link.state} sessionId={cell.runtimeSessionId} />
      ) : null}
      {/*
        Covers the repaint focus mode on/off triggers (see `pane-reveal-veil`). Painted in the
        terminal's own background, so it reads as the terminal waking up rather than a black flash,
        with the CodeCanvas sheen crossing it while the agent redraws underneath.
      */}
      {veilPhase !== "off" ? (
        <span
          className="ws-pane-veil"
          data-phase={veilPhase}
          style={{ background: termTheme.background }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
