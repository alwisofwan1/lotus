"use client";

import { ManagedHostBanner } from "@/modules/managed-host/ManagedHostBanner";
import { sshKey } from "@/modules/workspace-shell/services/sign-in-pane";
import { RemoteFolderPicker, remoteWorkspaceLabel } from "@/modules/workspace-shell/components/RemoteFolderPicker";
import type { PresetRemote } from "@/modules/codespace/components/types";
import type { TaskSpawner } from "@/modules/tasks/services/task-spawner";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  AddPaneMenu,
  PaneCard,
  SplitHandle,
  UnifiedComposer,
  WorkspaceRail,
  type MenuAnchor,
  type PaneKind,
  type RailPane,
  type RailWorkspace,
  type ShellModeStatus,
} from "@/modules/workspace-shell";
import { PaneBody } from "@/modules/workspace-shell/components/PaneBody";
import { PickChip } from "@/modules/chat/ui/ChatPreview";
import { usePickCapture } from "@/modules/chat/ui/usePickCapture";
import { addPick, addressOf, type Pick } from "@/modules/chat/domain/preview";
import { codeBrowserSlot } from "@/modules/codespace/services/webview-registry";
import { browserOwner, shortAddress, withBrowserPicks, type LinkAgent } from "@/modules/workspace-shell/services/browser-link";
import type { BrowserAnnotationPayload } from "@/lib/tauri/browser-preview";
import { RailEmptyState } from "@/modules/workspace-shell/components/RailEmptyState";
import { beginPaneDrag } from "@/modules/workspace-shell/services/pane-drag";
import { RailPaneMenu, regroupOptions, type RailPaneAction, type RegroupAction } from "@/modules/workspace-shell/components/RailPaneMenu";
import {
  cellTypeForPaneKind,
  livePaneCount,
  paneCountLabel,
  toRailWorkspaces,
  railPaneForCell,
} from "@/modules/workspace-shell/services/cell-mapping";
import { orderRailWorkspaces, togglePinned, toggleOpen, withOpen } from "@/modules/workspace-shell/services/rail-order";
import type { JumpWorkspace } from "@/modules/workspace-shell/services/jump-items";
import { touchRecent } from "@/modules/workspace-shell/services/jump-recent";
import { cycleAccount, loadShellAgents, withClaudeAccounts, type ShellAgent } from "@/modules/workspace-shell/services/agent-catalog";
import { buildCommandItems } from "@/modules/workspace-shell/services/command-items";
import { startSquadPreset } from "@/modules/workspace-shell/services/preset-start";
import type { SquadPreset } from "@/modules/workspace-shell/services/pane-presets";
import { balancedPaneLayout, splitDirectionForPane } from "@/modules/workspace-shell/services/pane-arrangement";
import { useCommandSheet } from "@/modules/workspace-shell/hooks/useCommandSheet";
import { useElementSize } from "@/modules/workspace-shell/hooks/useElementSize";
import { railMotionProps, useRailMotion, useRailPresence } from "@/modules/workspace-shell/hooks/useRailPresence";
import { clampSplitSize, computeSplitMax } from "@/modules/workspace-shell/services/split-sizing";
import { WorkspaceGrid } from "@/modules/workspace-shell/components/WorkspaceGrid";
import { SplitTree } from "@/modules/workspace-shell/components/SplitTree";
import { reconcileLayoutWithPanes } from "@/modules/workspace-shell/services/layout-reconcile";
import { screenViewOf } from "@/modules/workspace-shell/services/screen-view";
import { rememberedFocusCellId } from "@/modules/codespace/services/workspace-focus-memory";
import { addPaneToFrame, anchorFramesAt, createFrame, deleteFrame, frameOfPane, isSplit, migrateFrames, placeNewPanes, reconcileFrames, recolorFrame, renameFrame, restoreFrame, setFrameLayout, takePaneOut, type DeletedFrame, type ScreenTarget } from "@/modules/workspace-shell/services/code-frames";
import { TasksToast } from "@/modules/tasks/components/TasksToast";
import { FRAME_COLORS, type CodeFrame } from "@/modules/codespace/components/types";
import { codeModeStatusLabel } from "@/modules/workspace-shell/services/mode-status";
import { usePaneActivities } from "@/modules/workspace-shell/hooks/usePaneActivities";
import { usePaneUnread } from "@/modules/workspace-shell/hooks/usePaneUnread";
import { useCodeAgentDoneAlerts } from "@/modules/workspace-shell/hooks/useCodeAgentDoneAlerts";
import { usePaneAutoTitles } from "@/modules/workspace-shell/hooks/usePaneAutoTitles";
import {
  needsYouPaneIds,
  paneKindReportsActivity,
  workingPaneCount,
} from "@/modules/workspace-shell/services/pane-activity";
import { isPaneAttached, isPaneVisible } from "@/modules/workspace-shell/services/pane-visibility";
import {
  isClosePaneShortcut,
  isSplitDownShortcut,
  isSplitRightShortcut,
  paneShortcutKind,
} from "@/modules/workspace-shell/services/shortcuts";
import { resizeTerminalV2LayoutSplit, swapTerminalV2LayoutPanes, type TerminalV2LayoutDirection } from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";
import type { ShellLayoutPreferences } from "@/modules/workspace-shell/services/layout-preferences";
import { useCodeSpaceWorkspaces } from "@/modules/codespace/hooks/useCodeSpaceWorkspaces";
import { providerFromAgentCommand } from "@/modules/codespace/services/terminal-provider-detection";
import { PaneAccountChip, PaneLimitStrip } from "../components/PaneAccountChip";
import { usePaneUsageLimits } from "../hooks/usePaneUsageLimits";
import { PaneTitleControl, hasPaneConversation, regeneratePaneConversationTitle, renamePane } from "../components/PaneTitleControl";
import { Clock } from "lucide-react";
import { AgentNameControl } from "../components/AgentNameControl";
import { agentRenameErrorText } from "@/modules/codespace/services/agent-rename";
import { usePaneCloseGuard } from "@/modules/workspace-shell/hooks/usePaneCloseGuard";
import { routeFileLink } from "@/modules/workspace-shell/services/file-link-routing";
import {
  onEditorSplit,
  onFileLinkOpen,
  requestWorkbenchOpen,
  type FileLinkOpenResult,
} from "@/modules/codespace/services/workbench-open";
import { onSelectionSend, type SelectionSendResult } from "@/modules/codespace/services/selection-send";
import { routeSelectionToThread } from "@/modules/workspace-shell/services/selection-routing";
import type { FileLink } from "@/lib/file-link";
import { CellBusProvider } from "@/modules/codespace/services/bridge/cell-bus-context";
import { ShellFleetBridges } from "@/modules/workspace-shell/containers/ShellFleetBridges";
import { useOptionalTerminalV2Runtime } from "@/modules/codespace/terminal-v2/runtime/TerminalV2RuntimeProvider";
import { ConfigureLayoutView, markPresetOpened } from "@/modules/codespace/components/ConfigureLayoutView";
import { CodeEmptyState } from "@/modules/workspace-shell/components/CodeEmptyState";
import type { BrowserCellData, GridCell, Workspace } from "@/modules/codespace/components/types";
import { listAccounts, writeToSession } from "@/lib/tauri-api";
import { ptyWritesForMessage, routeComposerMessage, type ComposerRoute } from "@/modules/workspace-shell/services/composer-routing";
import type { CodeVoiceSendOutcome } from "@/modules/workspace-shell/services/code-voice-adapter";
import { HELD_PROMPT_UNREACHABLE, useHeldPrompt } from "@/modules/workspace-shell/hooks/useHeldPrompt";
import type { VoiceTurnTarget } from "@/modules/voice-core/voice-adapter";
import { getVoiceInputSettings } from "@/modules/codecanvas/hooks/useVoiceInputSettings";
import { useCodeVoice } from "@/modules/workspace-shell/hooks/useCodeVoice";
import { useCodeLiveVoice } from "@/modules/workspace-shell/hooks/useCodeLiveVoice";
import type { CodeVoicePane } from "@/modules/workspace-shell/services/code-voice-adapter";
import { createPaneOutputTail } from "@/modules/workspace-shell/services/pane-output-tail";
import { codecanvasMemorySearch, codecanvasMemoryWrite } from "@/lib/tauri/codecanvas";
import { localProjectIdForRoot } from "@/modules/codecanvas/services/codecanvas-project-repository";
import { paneTitleSeed } from "@/modules/workspace-shell/services/pane-title";
import { useThreadComposerRegistry } from "@/modules/codespace/state/thread-composer-registry";
import { useTerminalFileDrop } from "@/modules/codespace/hooks/useTerminalFileDrop";
import { TerminalFileDropOverlay } from "@/modules/codespace/components/TerminalFileDropOverlay";
import { listChatThreads } from "@/modules/chat/runtime/chat-runtime-client";
import { codeChatPaneKey, importedChatPanes } from "@/modules/workspace-shell/services/imported-chat-panes";
import { shellTerminalDropCells } from "@/modules/workspace-shell/services/pane-file-drop";
import { isTextSelectionChord, paneFocusShortcut } from "@/modules/workspace-shell/services/shortcuts";
import { nextFocusedPaneId } from "@/modules/workspace-shell/services/pane-focus-move";
import { keepsChordForTyping, paneFocusTarget } from "@/modules/workspace-shell/services/pane-focus-target";

const RAIL_DEFAULT = 300;
const RAIL_MIN = 232;
const PANE_MIN = 320;
/** The seam between rail and working area — `--ws-seam` in the stylesheet. */
const RAIL_OVERLAY_SEAM = 10;

interface CodeModeProps {
  railVisible: boolean;
  /** Reported up for the chrome's status pill; see `ShellModeStatus`. */
  onStatusChange?: (status: ShellModeStatus | null) => void;
  layout: ShellLayoutPreferences;
  onLayoutChange: (patch: Partial<ShellLayoutPreferences>) => void;
  /** False while another mode is showing: the surface stays mounted but goes quiet. */
  active: boolean;
  /**
   * The workspaces this mode holds, reported up so Tasks can call them projects.
   *
   * Reported rather than read twice: this hook is the snapshot's writer and may be mounted once
   * per window.
   */
  onProjectsChange?: (projects: { id: string; name: string }[]) => void;
  /**
   * The one thing the tracker needs from this mode: a way to open a pane.
   *
   * Reported up for the same reason `onProjectsChange` is — the grid is owned here and read
   * elsewhere. Delegation needs exactly this and nothing else about the mode, so this is what
   * crosses the boundary rather than the surface itself.
   */
  onSpawnerChange?: (spawner: TaskSpawner | null) => void;
  /**
   * What every pane is doing, reported up so the tracker's `Active` count is an observation
   * rather than a claim. Same reason as `onProjectsChange`: this mode owns the panes.
   */
  onActivitiesChange?: (activities: ReadonlyMap<string, PaneActivityState>) => void;
  /** The window's nav rows for this mode's rail — Tasks, today. */
  navSlot?: React.ReactNode;
  /** A section's sidebar content for this mode's rail, in place of its list. See `WorkspaceRail`. */
  sectionSlot?: React.ReactNode;
  /**
   * The user asked to SEE this mode's working area — they picked a pane, opened a folder, or
   * started a new one.
   *
   * The rail stays live under a panel on purpose (that is how you get back out), which means every
   * one of those actions can be taken while the grid is covered. Without this the click landed:
   * the folder opened, the pane took focus, the rail moved its highlight — and the window went on
   * drawing the tracker, so nothing appeared to happen. The mode cannot close the panel itself; it
   * does not own it, so it says what the user asked for and lets the window answer.
   */
  onRevealWork?: () => void;
  /**
   * A panel covering this mode's WORKING AREA — the grid — while leaving the rail alone.
   *
   * That boundary is the whole behaviour: `bb` opens Tasks over the main area and keeps its
   * sidebar usable, which is how you get back out. Covering the rail too would trap you in the
   * panel you opened from it.
   */
  columnOverlay?: React.ReactNode;
  /**
   * False while another ROUTE is drawing the window — CodeCanvas, the launcher, settings.
   *
   * Deliberately not the same signal as `active`. `active` answers "is this the mode showing",
   * and a pane must stay attached to the renderer even when the window is elsewhere, because
   * that is what keeps the terminals alive across a trip to Canvas. `shown` answers "is this
   * shell what the window is drawing", and it governs the KEYBOARD: window listeners stay
   * installed on a parked shell, so without it ⌘T pressed on the Canvas would open a terminal
   * nobody asked for, in a surface nobody can see.
   */
  shown?: boolean;
}

/**
 * Code mode: the shell's own layout, filled with CodeSpace's real state.
 *
 * The state engine is reused whole — `useCodeSpaceWorkspaces` owns the workspaces, hydrates the
 * saved snapshot, persists changes and reaps orphaned PTY sessions. Only the presentation is the
 * shell's. That split is what makes this the same CodeSpace rather than a second one.
 *
 * It also means this hook may be mounted EXACTLY ONCE per window: it is the snapshot's writer,
 * and a second writer would race the first and overwrite real workspaces with its own view.
 */
/** A pane a Browser pane can send picks to: a terminal running an agent, or a chat pane. */
function isLinkAgent(cell: GridCell): boolean {
  return cell.type === "chat" || (cell.type === "terminal" && Boolean(railPaneForCell(cell).runner));
}

/** `chat_attachment_save_pasted` keeps pictures under a UUID-named folder only. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function CodeMode({
  railVisible,
  layout,
  onLayoutChange,
  active,
  shown = true,
  onStatusChange,
  onProjectsChange,
  navSlot,
  sectionSlot,
  onSpawnerChange,
  onActivitiesChange,
  columnOverlay,
  onRevealWork,
}: CodeModeProps) {
  // The mode is showing AND the window is drawing this shell: only then does it answer keys.
  const keyboardLive = active && shown;
  const {
    workspaces,
    activeWorkspaceId,
    focusedCellId,
    setFocusedCellId,
    setWorkspaceZoom,
    updateCellTitle,
    handleSelectWorkspace,
    addPane,
    addChatPane,
    addCellPane,
    removePane,
    splitPaneV,
    splitPaneH,
    resizePaneColumn,
    resizePaneRow,
    updateWorkspacePaneLayout,
    renameWorkspace,
    // Used by the fleet identity sync: what a pane is REALLY running, read from its own output.
    updateTerminalAgentIdentity,
    renameTerminalAgent,
    updateCellRuntimeSessionId,
    updateCellRuntimeStatus,
    updateBrowserCellUrl,
    updateChatPaneThread,
    updateBrowserCellLink,
    updateWorkbenchCell,
    moveTerminalToAccount,
    relaunchTerminal,
    fallBackToShell,
    // The launch wizard comes with the state engine — the shell shows it, it is not rebuilt.
    view,
    wizardActive,
    launchWorkspace,
    handleOpenLayoutWizard,
    handleCancelWizard,
    createSshWorkspace,
  } = useCodeSpaceWorkspaces();
  const [remotePickerOpen, setRemotePickerOpen] = useState(false);
  // The wizard awaits the picker: the chosen machine goes back into the form, not straight to a workspace.
  const remotePickRef = useRef<((pick: { remote: PresetRemote; cwd: string } | null) => void) | null>(null);
  const settleRemotePick = (pick: { remote: PresetRemote; cwd: string } | null) => {
    remotePickRef.current?.(pick);
    remotePickRef.current = null;
    setRemotePickerOpen(false);
  };
  const { requestClosePane, closeForAgent, dialog: unsavedCloseDialog } = usePaneCloseGuard({ workspaces, removePane });

  /*
    07f: a CodeChat pane from before 07d moves to the thread its session was imported into.
    Re-checked when such panes change, not on every status change. (`workspacesRef` is set
    further down.)
  */
  const codeChatPanes = useMemo(() => codeChatPaneKey(workspaces), [workspaces]);
  useEffect(() => {
    if (!codeChatPanes) return;
    let live = true;
    listChatThreads().then(
      (threads) => {
        if (!live) return;
        for (const pane of importedChatPanes(workspacesRef.current, threads)) updateChatPaneThread(pane.workspaceId, pane.cellId, pane.thread);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [codeChatPanes, updateChatPaneThread]);

  /**
   * Focus mode is a MODE, not a pane — and it belongs to the FOLDER it was taken in.
   *
   * Which pane it shows is derived from `focusedCellId`, so picking another pane in the rail
   * moves focus mode with it. Holding a separate "maximised pane" id is what left the screen
   * showing one pane while the rail, the composer and the header all pointed at another.
   *
   * It used to be one boolean for the whole window. Every folder's panes are rendered here, so
   * maximising in one folder and then opening another drew that second folder with one pane
   * filling the frame and the rest collapsed to zero width — a view nobody had asked for, in a
   * folder where nothing had been maximised. Reading it per workspace is what makes the zoom stay
   * where it was taken; `setWorkspaceZoom` is where it is written.
   */
  const isWorkspaceZoomed = (candidate: Workspace | null | undefined) =>
    (candidate?.paneLayout?.mode ?? "grid") === "focus";

  /**
   * Ask the terminal runtime to wake up.
   *
   * `TerminalV2RuntimeProvider` lives in `AppShell` but only activates for the `/terminal`
   * route, so a terminal mounted here came up with no session starter and failed with
   * "Terminal V2 session starter unavailable" — in the native window, not just the browser.
   * Requesting activation is what that API is for; doing it here keeps AppShell's routing
   * rules untouched.
   */
  const terminalRuntime = useOptionalTerminalV2Runtime();
  useEffect(() => {
    if (active) terminalRuntime?.requestActivation();
  }, [active, terminalRuntime]);

  /**
   * Splitting is a keyboard action now, not two buttons in every pane header.
   *
   * A header that carries a control for everything a pane can do is a header that competes with
   * the pane; ⌘D / ⌘⇧D (Ctrl on Windows and Linux) are what a terminal user already reaches for,
   * and the header keeps only what has no shortcut: focus and close.
   */
  /*
    The pane openers are function declarations, so they are a new value on every render. Keeping
    the latest one in a ref lets the listener below be registered once per focus change instead of
    once per render, without ever firing a stale opener — the failure the file already works
    around with a lint disable where the command rows are built.
  */
  const addPaneOfKindRef = useRef(addPaneOfKind);
  useEffect(() => {
    addPaneOfKindRef.current = addPaneOfKind;
  });

  useEffect(() => {
    if (!keyboardLive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!activeWorkspaceId) return;

      /*
        Opening a pane from the keyboard — ⌘T, ⌘⇧T, ⌘⇧B, ⌘E, ⌘J.

        Handled BEFORE the focused-pane guard below, because a workspace with no panes has no
        focused pane and that is exactly when you need to open the first one. Browser sits on
        ⌘⇧B rather than the ⌘B its menu row used to print: ⌘B is the rail, and the row was
        advertising a chord that collapsed the sidebar.
      */
      const paneKind = paneShortcutKind(event);
      if (paneKind) {
        event.preventDefault();
        addPaneOfKindRef.current(paneKind);
        return;
      }

      if (!focusedCellId) return;
      if (isSplitDownShortcut(event)) {
        event.preventDefault();
        splitNextPanesRef.current = activeWorkspaceId;
        splitDirectionRef.current = "vertical";
        splitPaneH(activeWorkspaceId, focusedCellId);
        return;
      }
      if (isSplitRightShortcut(event)) {
        event.preventDefault();
        splitNextPanesRef.current = activeWorkspaceId;
        splitDirectionRef.current = "horizontal";
        splitPaneV(activeWorkspaceId, focusedCellId);
        return;
      }
      if (isClosePaneShortcut(event)) {
        event.preventDefault();
        // Leaving focus mode with the pane is deliberate: the maximised pane is gone, so staying
        // in a mode that shows only it would leave an empty grid.
        // The focused pane is the one focus mode is showing, so closing it leaves the mode.
        const workspaceId = activeWorkspaceId;
        requestClosePane(workspaceId, focusedCellId, () => setWorkspaceZoom(workspaceId, null));
        return;
      }
      // Esc leaves focus mode, which is the only way out that does not need the mouse.
      if (event.key === "Escape" && activeWorkspaceId) setWorkspaceZoom(activeWorkspaceId, null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeWorkspaceId, focusedCellId, keyboardLive, requestClosePane, setWorkspaceZoom, splitPaneH, splitPaneV]);
  /** `loose`: the rail's "+" — what the menu opens stands alone instead of beside the screen. */
  /** The pane menu opened by right-clicking a pane's header: the rail row's menu, minus rename. */
  const [headerMenu, setHeaderMenu] = useState<{ paneId: string; workspaceId: string; x: number; y: number } | null>(null);
  // ADR-0068 decision 11: a renamed agent is told its new name once it is at rest. Pane id → the last name.
  const [renameNotices, setRenameNotices] = useState<Record<string, string>>({});
  const [addMenu, setAddMenu] = useState<{ workspace: RailWorkspace; anchor: MenuAnchor; loose?: boolean } | null>(null);
  /** The workspace whose next new panes stay loose (set as the rail's add menu creates them). */
  const looseNextPanesRef = useRef<string | null>(null);
  /** The workspace whose next new panes may split with the loose pane on screen: only what you asked
   *  for (⌘D, ⌘K, the add menu). A pane an agent, a squad or the phone opens never joins one uninvited. */
  const splitNextPanesRef = useRef<string | null>(null);
  /** ⌘D / ⌘⇧D: the side the next new pane goes, read once by the Frame placement below. */
  const splitDirectionRef = useRef<TerminalV2LayoutDirection | null>(null);
  /** The pane focused before the newest pane took focus: a new pane splits beside it. */
  const focusBeforeRef = useRef<string | null>(null);
  /** New pane id → the agent pane that spawned it, read once by the Frame placement below (#319). */
  const spawnerOfNewPaneRef = useRef(new Map<string, string>());
  /**
   * An empty Frame opened from the rail. Any other Frame is opened by focusing one of its panes;
   * an empty one has none, so this holds it, and only while focus stays where it was when opened.
   */
  const [openedEmptyFrame, setOpenedEmptyFrame] = useState<{ workspaceId: string; frameId: string; focus: string | null } | null>(null);
  const openFrameIdFor = (workspaceId: string) =>
    openedEmptyFrame?.workspaceId === workspaceId && workspaceId === activeWorkspaceId && openedEmptyFrame.focus === focusedCellId
      ? openedEmptyFrame.frameId
      : null;
  /** The Frame just deleted, while its Undo is on offer. */
  const [deletedFrame, setDeletedFrame] = useState<{ workspaceId: string; message: string; deleted: DeletedFrame } | null>(null);
  const dismissDeletedFrame = useCallback(() => setDeletedFrame(null), []);

  /**
   * What this machine can launch, asked once when Code mode wakes up.
   *
   * Read from `detect_installed_clis` rather than from a list in this file: see `agent-catalog.ts`
   * for why there is no fourth copy of that catalog here.
   */
  const [agents, setAgents] = useState<ShellAgent[]>([]);
  // ⌘K's Claude row launches on this account (⇥ cycles it); null = the default for new work.
  const [launchAccount, setLaunchAccount] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.all([loadShellAgents(), listAccounts().catch(() => [])]).then(([found, accounts]) => {
      if (!cancelled) setAgents(withClaudeAccounts(found, accounts));
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  /**
   * The jump the chrome's pill performs, behind a ref.
   *
   * Everything it needs changes on every render — the workspace list, and `handleSelectWorkspace`,
   * which `useCodeSpaceWorkspaces` rebuilds as an inline arrow each time. A callback that listed
   * them as dependencies would take a new identity on every paint, and since it is REPORTED UP to
   * the chrome, the chrome would set state, re-render this mode, and be handed another one.
   *
   * That is not hypothetical: the first version of this did exactly that and the browser filled
   * with "Maximum update depth exceeded" — 189 of them on one page load, caught live on
   * 2026-09-21. The ref is what keeps the reported callback stable while the work it does stays
   * current.
   */
  const jumpToPaneRef = useRef<(paneId: string) => void>(() => {});
  useEffect(() => {
    jumpToPaneRef.current = (paneId: string) => {
      const owner = workspaces.find((candidate) =>
        candidate.cells.some((cell) => cell.id === paneId),
      );
      if (!owner) return;
      if (owner.id !== activeWorkspaceId) handleSelectWorkspace(owner.id);
      moveFocusToPane(paneId);
    };
  });

  const [bodyRef, body] = useElementSize<HTMLDivElement>();
  const [gridRef, grid] = useElementSize<HTMLDivElement>();

  /**
   * Give every workspace a split tree, and keep its Frames true.
   *
   * The tree is what makes each pane resizable on its own, and CodeSpace gets one from its layout
   * bridge — a component this shell does not render. Without it a workspace falls back to the
   * uniform row/column grid, where one drag moves a whole row. Seeding it from the panes that
   * already exist is enough: from then on the engine's split and close actions maintain it.
   *
   * Frames are kept here for the same reason: panes are born on many paths (add menu, ⌘D, ⌘K, a
   * squad, an agent's spawn), and this is the one place that sees them all. A pane id not seen
   * before joins what was on screen (`placeNewPanes`): its Frame, or — only for a pane you asked
   * for (`splitNextPanesRef`) — a new split with the loose pane there. A layout effect, so the new pane never paints alone for a frame before it joins.
   */
  const frameDirection = (targetFrame: CodeFrame | undefined) =>
    splitDirectionForPane(targetFrame?.layout?.root ?? null, targetFrame?.layout?.activePaneId ?? null, {
      width: grid.width,
      height: grid.height,
    });
  const knownPaneIdsRef = useRef(new Map<string, Set<string>>());
  const screenTargetRef = useRef(new Map<string, ScreenTarget>());
  useLayoutEffect(() => {
    workspaces.forEach((candidate, index) => {
      const paneIds = candidate.cells.map((paneCell) => paneCell.id);
      const current = candidate.paneLayout;
      const tree = paneIds.length ? reconcileLayoutWithPanes(current?.terminalV2Layout, paneIds) : current?.terminalV2Layout;
      const base = { ...current, mode: current?.mode ?? "grid", focusCellId: current?.focusCellId ?? null, terminalV2Layout: tree };
      // The one-time move to Frames, then keep them true to the panes that exist (closed panes leave).
      const migrated = migrateFrames(base, paneIds, {
        name: candidate.label?.trim() || candidate.cwd.split("/").filter(Boolean).pop() || "Frame",
        color: FRAME_COLORS[index % FRAME_COLORS.length],
        now: Date.now(),
        newId: () => `frame-${crypto.randomUUID()}`,
      });
      let frames = migrated.frames && reconcileFrames(migrated.frames, paneIds);
      const known = knownPaneIdsRef.current.get(candidate.id);
      if (known && frames && paneIds.some((paneId) => !known.has(paneId))) {
        const loose = looseNextPanesRef.current === candidate.id;
        if (loose) looseNextPanesRef.current = null;
        const asked = splitNextPanesRef.current === candidate.id;
        if (asked) splitNextPanesRef.current = null;
        const direction = asked ? splitDirectionRef.current : null;
        if (asked) splitDirectionRef.current = null;
        const target = loose ? null : screenTargetRef.current.get(candidate.id) ?? null;
        // A group on screen takes any new pane, as before; a split beside a loose pane only when asked.
        const spawners = spawnerOfNewPaneRef.current;
        frames = placeNewPanes(
          candidate.id === activeWorkspaceId ? anchorFramesAt(frames, focusBeforeRef.current) : frames,
          known,
          paneIds,
          target && "paneId" in target && !asked ? null : target,
          direction ? () => direction : frameDirection,
          { now: Date.now(), newId: () => `frame-${crypto.randomUUID()}` },
          (paneId) => spawners.get(paneId),
        );
        paneIds.forEach((paneId) => spawners.delete(paneId));
      }
      knownPaneIdsRef.current.set(candidate.id, new Set(paneIds));
      if (tree !== current?.terminalV2Layout || migrated !== base || frames !== migrated.frames) {
        // Not recorded this round: the screen is about to change with the write.
        updateWorkspacePaneLayout(candidate.id, { ...migrated, frames });
        return;
      }
      // Only the active workspace has a Frame "on screen"; a pane born elsewhere stays loose.
      const screen = candidate.id === activeWorkspaceId
        ? screenViewOf(candidate, { focusedPaneId: focusedCellId, openFrameId: openFrameIdFor(candidate.id) })
        : null;
      screenTargetRef.current.set(
        candidate.id,
        screen?.kind === "frame" ? { frameId: screen.frameId } : screen?.kind === "pane" ? { paneId: screen.paneId } : null,
      );
    });
    // Recorded after placement: a split moves focus to the new pane in the same render.
    focusBeforeRef.current = focusedCellId;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- grid is read, not reacted to; openFrameIdFor is derived from the deps listed
  }, [updateWorkspacePaneLayout, workspaces, activeWorkspaceId, focusedCellId, openedEmptyFrame]);

  const railMax = computeSplitMax(body.width, PANE_MIN, RAIL_MIN);
  const railSize = clampSplitSize(layout.railWidth ?? RAIL_DEFAULT, { min: RAIL_MIN, max: railMax });
  const railPresence = useRailPresence(railVisible);
  const railSlotRef = useRailMotion(railPresence, railSize + RAIL_OVERLAY_SEAM);

  /**
   * The rail's list: the engine's workspaces, marked with what the RAIL knows about them.
   *
   * Which folder is showing (`active`) and which are pinned are view state, so they are applied
   * here rather than stored on the workspace — the persisted snapshot has no business holding
   * either.
   */
  /**
   * What every pane is doing, resolved once for the whole window.
   *
   * Every pane in every workspace, not just the showing one: the rail lists them all, and a folder
   * that cannot say "someone is waiting in here" is a folder you have to open to find out.
   */
  const allCells = useMemo(
    () => workspaces.flatMap((candidate) => candidate.cells),
    [workspaces],
  );
  const paneActivities = usePaneActivities({ cells: allCells });
  useEffect(() => {
    const due = Object.entries(renameNotices).filter(([paneId]) => {
      const activity = paneActivities.get(paneId)?.activity;
      return !allCells.some((cell) => cell.id === paneId) || activity === "idle" || activity === "done";
    });
    if (due.length === 0) return;
    setRenameNotices((previous) => {
      const next = { ...previous };
      for (const [paneId] of due) delete next[paneId];
      return next;
    });
    for (const [paneId, name] of due) {
      // A closed pane drops its notice; text and Enter go as two writes (ptyWritesForMessage).
      const cell = allCells.find((candidate) => candidate.id === paneId);
      const sessionId = cell?.type === "terminal" ? cell.runtimeSessionId : null;
      if (!sessionId) continue;
      void (async () => {
        for (const chunk of ptyWritesForMessage(`Your name is now ${name}.`)) await writeToSession(sessionId, chunk);
      })().catch((error: unknown) => console.warn("[agent-rename] notice failed:", error));
    }
  }, [renameNotices, paneActivities, allCells]);
  const paneLimits = usePaneUsageLimits();
  /*
    Seen = the user is looking at it right now: the mode is on screen, the pane holds focus, and the
    window itself is focused. Anything less — another app in front, another mode, another pane — and
    a finished turn waits to be opened.
  */
  const isPaneSeen = useCallback(
    (paneId: string) =>
      keyboardLive
      && paneId === focusedCellId
      && typeof document !== "undefined"
      && document.hasFocus(),
    [focusedCellId, keyboardLive],
  );
  // A finished turn the user is not looking at is announced — voice, chime or nothing (Lotus #184).
  const alertAgentDone = useCodeAgentDoneAlerts({
    nameFor: (paneId) => {
      const cell = allCells.find((candidate) => candidate.id === paneId);
      return cell ? railPaneForCell(cell).title : undefined;
    },
  });
  const paneUnread = usePaneUnread({ cells: allCells, isSeen: isPaneSeen, onTurnEnd: alertAgentDone });
  /*
    Only an idle or done pane still HAS an unread result — one that has started its next turn, or
    stopped to ask, is described by that state instead. One set, read by the header, the rail and
    the pill, so the three cannot disagree.
  */
  const unreadKey = paneUnread.unreadIds
    .filter((paneId) => {
      const activity = paneActivities.get(paneId)?.activity;
      // `offline` too: after a restart a restored pane is offline until its PTY reconnects, and a
      // mark kept on disk for it must still show (it is a result nobody opened, not new work).
      return activity === "idle" || activity === "done" || activity === "offline";
    })
    .join(" ");
  const unreadResultIds = useMemo(
    () => new Set(unreadKey ? unreadKey.split(" ") : []),
    [unreadKey],
  );
  // A pane earns a shorter name once, at the end of its first turn — see `usePaneAutoTitles`.
  usePaneAutoTitles({ workspaces, activities: paneActivities, onTitle: updateCellTitle });

  const railWorkspaces = useMemo(
    () =>
      orderRailWorkspaces(
        toRailWorkspaces(workspaces, paneActivities, unreadResultIds, paneUnread.unreadSince).map((workspace) => ({
          ...workspace,
          active: workspace.id === activeWorkspaceId,
        })),
        layout.pinnedWorkspaceIds,
      ),
    [activeWorkspaceId, layout.pinnedWorkspaceIds, paneActivities, paneUnread.unreadSince, unreadResultIds, workspaces],
  );

  /*
    The Jump palette reads the rail when it opens, and selects a workspace: both through refs, so the
    callbacks reported up stay stable (the loop `jumpToPaneRef` describes).
  */
  const jumpListRef = useRef<() => JumpWorkspace[]>(() => []);
  const selectWorkspaceRef = useRef<(workspaceId: string) => void>(() => {});
  useEffect(() => {
    jumpListRef.current = () =>
      railWorkspaces.map((rail) => {
        const location = workspaces.find((candidate) => candidate.id === rail.id)?.location;
        const ssh = location?.kind === "ssh" ? location : null;
        const folder = ssh?.remoteCwd ?? workspaces.find((candidate) => candidate.id === rail.id)?.cwd ?? "";
        return { id: rail.id, name: rail.name, folder, host: ssh ? (ssh.label ?? ssh.host) : undefined, panes: rail.panes };
      });
    selectWorkspaceRef.current = (workspaceId) => {
      if (workspaceId !== activeWorkspaceId) handleSelectWorkspace(workspaceId);
    };
  });
  // What the Jump palette's empty list calls recent.
  useEffect(() => touchRecent([activeWorkspaceId, focusedCellId]), [activeWorkspaceId, focusedCellId]);

  /**
   * Expanded folders come from stored preferences now, not from "whichever one is active".
   *
   * That was the whole bug: opening a second folder collapsed the first, so a rail someone had
   * arranged folded itself up every time they switched. The active folder is still forced open,
   * because a folder whose panes fill the screen cannot honestly be drawn collapsed.
   */
  const openWorkspaceIds = useMemo(
    () => (activeWorkspaceId ? withOpen(layout.openWorkspaceIds, activeWorkspaceId) : layout.openWorkspaceIds),
    [activeWorkspaceId, layout.openWorkspaceIds],
  );

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  // An account names a folder on this desktop, so an SSH workspace gets no account rows (addPane drops it there).
  const launchAgents = useMemo(
    () => (activeWorkspace?.location?.kind === "ssh" ? agents.filter((agent) => !agent.claudeAccount) : agents),
    [activeWorkspace?.location?.kind, agents],
  );

  /*
    Panes of the workspaces NOT on screen stay attached to their renderers (see `isPaneAttached`),
    so the pool has to be told which ones nobody can see: those are what it evicts first when its
    slots run out, and the ones it rebinds when their workspace comes back.

    Keyed on a joined string so a status update elsewhere in `workspaces` is not a new set.
  */
  const backgroundPaneKey = useMemo(
    () => workspaces
      .filter((workspace) => workspace.id !== activeWorkspaceId)
      .flatMap((workspace) => workspace.cells.map((cell) => cell.id))
      .join("\n"),
    [activeWorkspaceId, workspaces],
  );
  const rendererRuntime = terminalRuntime?.runtime ?? null;
  useEffect(() => {
    if (!rendererRuntime) return;
    const coordinator = rendererRuntime.rendererCoordinator;
    coordinator.setBackgroundPanes(backgroundPaneKey ? backgroundPaneKey.split("\n") : []);
    return () => {
      if (!rendererRuntime.isDisposed()) coordinator.setBackgroundPanes([]);
    };
  }, [backgroundPaneKey, rendererRuntime]);
  /** The zoom of the folder on screen. Panes read their OWN folder's — see `renderPane`. */
  const focusMode = isWorkspaceZoomed(activeWorkspace);
  const activeScreen = activeWorkspace
    ? screenViewOf(activeWorkspace, { focusedPaneId: focusedCellId, openFrameId: openFrameIdFor(activeWorkspace.id) })
    : null;
  const cells = activeWorkspace?.cells ?? [];

  const activeWorkspaceCwd = activeWorkspace?.cwd ?? "";

  /**
   * Which way to cut the pane a new one is born from: along its longer axis.
   *
   * Every creation path used to pass "horizontal", so pane five was column five — 200px wide, too
   * narrow for a terminal to render its own prompt without wrapping. The measurement comes from
   * the grid's own box and the tree's sizes, so a seam someone dragged is respected.
   */
  function nextSplitDirection() {
    return splitDirectionForPane(
      activeWorkspace?.paneLayout?.terminalV2Layout?.root ?? null,
      focusedCellId,
      { width: grid.width, height: grid.height },
    );
  }

  /**
   * Put the open panes back into an even grid.
   *
   * Closing panes and dragging seams leaves a tree nobody would have designed; this rebuilds the
   * same panes, in the same order, as rows of a near-square grid. It is deliberately destructive
   * of SIZES only — no pane is opened, closed or moved to another workspace.
   */
  function tidyPanes() {
    if (!activeWorkspaceId || !activeWorkspace) return;
    const screen = screenViewOf(activeWorkspace, { focusedPaneId: focusedCellId, openFrameId: openFrameIdFor(activeWorkspace.id) });
    const tidied = balancedPaneLayout(screen.cells.map((cell) => cell.id), focusedCellId);
    updateWorkspacePaneLayout(activeWorkspaceId, {
      ...activeWorkspace.paneLayout,
      mode: activeWorkspace.paneLayout?.mode ?? "grid",
      focusCellId: activeWorkspace.paneLayout?.focusCellId ?? null,
      // Tidy what is on screen: a Frame keeps its own split.
      ...(screen.kind === "frame"
        ? { frames: setFrameLayout(activeWorkspace.paneLayout?.frames ?? [], screen.frameId, tidied) }
        : { terminalV2Layout: screen.kind === "workspace" ? tidied : activeWorkspace.paneLayout?.terminalV2Layout }),
    });
  }

  /**
   * One opener per kind, each returning the pane it made — or null when it could not make one.
   *
   * Four callers share this: the add-pane menu, ⌘K, the pane shortcuts and a squad preset. Four
   * ways to open a terminal would be four places for the Browser/Editor/Bridge bug to come back
   * (all three used to open an empty terminal). The kind → cell translation lives in
   * `cell-mapping`, with the one that reads it the other way.
   *
   * It deliberately does NOT move focus: who ends up focused is the caller's decision, and a
   * squad that focused every pane as it opened would hand focus to whoever happened to be last
   * in the lineup.
   */
  function createThreadPane(
    workspaceId: string,
    sourceCellId: string | null,
  ): { paneId: string; sessionId: string } | null {
    // The pane runs the new chat (07d); its thread is made by its first message. It is
    // addressed by the pane's id (send, drafts), which exists before the thread does.
    const paneId = addChatPane(workspaceId, "", sourceCellId ?? undefined, nextSplitDirection(), { id: null });
    return { paneId, sessionId: paneId };
  }

  function createPaneOfKind(kind: PaneKind): string | null {
    if (!activeWorkspaceId) return null;

    if (kind === "thread") {
      return createThreadPane(activeWorkspaceId, focusedCellId)?.paneId ?? null;
    }

    if (kind === "browser" || kind === "editor") {
      const paneId = addCellPane(
        activeWorkspaceId,
        cellTypeForPaneKind(kind),
        focusedCellId ?? undefined,
        nextSplitDirection(),
      );
      // Opened from an agent: that agent owns it (PANE-LINK.md), so its picks have somewhere to go.
      const opener = focusedCellId ? cells.find((cell) => cell.id === focusedCellId) : undefined;
      if (kind === "browser" && paneId && opener && isLinkAgent(opener)) updateBrowserCellLink(activeWorkspaceId, paneId, opener.id);
      return paneId;
    }

    return addPane(activeWorkspaceId, "");
  }

  function editFrames(workspaceId: string, edit: (frames: CodeFrame[]) => CodeFrame[]) {
    const target = workspacesRef.current.find((w) => w.id === workspaceId);
    const frames = target?.paneLayout?.frames;
    if (!target || !frames) return;
    const next = edit(frames);
    if (next !== frames) writeFrames(target, next);
  }

  function writeFrames(target: Workspace, frames: CodeFrame[]) {
    updateWorkspacePaneLayout(target.id, { ...target.paneLayout, mode: target.paneLayout?.mode ?? "grid", frames });
  }

  /**
   * Put a Frame on screen: focus its last active pane, which is what the screen follows. An empty
   * Frame has no pane to focus, so it is held open until focus moves.
   */
  function openFrame(workspaceId: string, frameId: string) {
    onRevealWork?.();
    const target = workspacesRef.current.find((w) => w.id === workspaceId);
    if (workspaceId !== activeWorkspaceId) handleSelectWorkspace(workspaceId);
    const frame = target?.paneLayout?.frames?.find((f) => f.id === frameId);
    const live = frame?.paneIds.filter((id) => target?.cells.some((cell) => cell.id === id)) ?? [];
    const pane = live.find((id) => id === frame?.layout?.activePaneId) ?? live[0];
    if (pane) {
      moveFocusToPane(pane);
      return;
    }
    const focus = workspaceId === activeWorkspaceId ? focusedCellId : rememberedFocusCellId(target);
    setOpenedEmptyFrame({ workspaceId, frameId, focus });
  }

  /** The menu, ⌘K and the shortcuts all want the same thing: open it, then look at it. */
  function addPaneOfKind(kind: PaneKind) {
    splitNextPanesRef.current = activeWorkspaceId ?? null;
    const paneId = createPaneOfKind(kind);
    if (!paneId) {
      splitNextPanesRef.current = null;
      return;
    }
    onRevealWork?.();
    // A pane you just asked for is a pane you want to type in.
    moveFocusToPane(paneId);
  }

  /**
   * Start a squad — the lineup the menu just showed, opened in order.
   *
   * Until now the commit button only closed the menu, under a note promising that nothing would
   * be born until it was pressed. Pressing it still bore nothing.
   *
   * The layout is written ONCE, at the end, instead of being left to the split each opener
   * performs: five sequential splits give a shape nobody chose, and this is the same balanced
   * grid "Rapikan pane" produces. Focus goes to the first member, which is the row the lineup
   * listed first.
   */
  function startPreset(preset: SquadPreset) {
    if (!activeWorkspaceId) return;

    const { paneIds, skipped } = startSquadPreset(preset, {
      terminal: () => createPaneOfKind("terminal"),
      thread: () => createPaneOfKind("thread"),
      browser: () => createPaneOfKind("browser"),
      editor: () => createPaneOfKind("editor"),
    });

    if (skipped.length > 0) {
      // Not routed to the composer on purpose: `disabledReason` REPLACES the input field, so a
      // notice there would take away the place you type until something else cleared it. The
      // panes that did open are visible in the rail and in the grid; this line is for whoever
      // has to explain why there are four of them and not five.
      console.warn(`[shell] squad ${preset.id}: ${skipped.length} pane(s) could not open (${skipped.join(", ")})`);
    }

    if (paneIds.length === 0) return;

    onRevealWork?.();
    setFocusedCellId(paneIds[0]);
    updateWorkspacePaneLayout(activeWorkspaceId, {
      // Grid, whatever the folder was in: a squad that opened five panes and showed one of them
      // would be answering a question nobody asked.
      mode: "grid",
      focusCellId: paneIds[0],
      terminalV2Layout: balancedPaneLayout([...cells.map((cell) => cell.id), ...paneIds], paneIds[0]),
    });
  }

  /**
   * Open a pane because something OUTSIDE this window asked for it — `lotus_spawn_cell`, the
   * phone, another agent.
   *
   * It honours a workspace id when one is given, which the delegate's own signature has always
   * offered and CodeSpace never used: a caller that names a folder means that folder, and
   * dropping the id would quietly spawn into whichever one happened to be on screen. An unknown
   * id falls back to the showing workspace rather than refusing — the pane still lands somewhere
   * the operator can see.
   */
  function spawnPaneForMcp(agentCommand: string, workspaceId?: string, claudeAccount?: string, fromPaneId?: string): string | null {
    // An agent's pane lands beside its spawner: the spawner's folder when no folder was named.
    const spawnerHome = fromPaneId ? workspaces.find((candidate) => candidate.cells.some((paneCell) => paneCell.id === fromPaneId)) : undefined;
    const target =
      (workspaceId && workspaces.some((candidate) => candidate.id === workspaceId)
        ? workspaceId
        : spawnerHome?.id ?? activeWorkspaceId) ?? null;
    if (!target) return null;
    const paneId = addPane(target, agentCommand, undefined, claudeAccount);
    if (!paneId) return paneId;
    const spawnerFrame = fromPaneId && spawnerHome?.id === target ? frameOfPane(spawnerHome.paneLayout?.frames ?? [], fromPaneId) : null;
    if (spawnerFrame) spawnerOfNewPaneRef.current.set(paneId, fromPaneId!);
    // #319: joining a Frame that is not on screen must not change the screen, so focus stays put.
    const shown = target === activeWorkspaceId && spawnerHome
      ? screenViewOf(spawnerHome, { focusedPaneId: focusedCellId, openFrameId: openFrameIdFor(target) })
      : null;
    if (spawnerFrame && !(shown?.kind === "frame" && shown.frameId === spawnerFrame.id)) return paneId;
    // Marked focused, but the CURSOR is left alone: this pane was asked for from the phone or from
    // Bridge, and yanking the caret out of whatever the person at the keyboard is typing — mid-word,
    // into another agent's prompt — is the one case where following the focus would be wrong.
    setFocusedCellId(paneId);
    return paneId;
  }

  // A file link clicked in a Thread opens in this workspace's Editor pane (one is added if none).
  function openFileLink(workspaceId: string, link: FileLink): FileLinkOpenResult {
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return { ok: false, reason: "This workspace is no longer open." };
    const result = routeFileLink({
      workspace,
      preferredEditorId: lastEditorByWorkspaceRef.current.get(workspace.id) ?? null,
      sourceCellId: focusedCellId,
      link,
      addEditorPane: (sourceCellId) =>
        addCellPane(workspace.id, "workbench", sourceCellId ?? undefined, nextSplitDirection()),
    });
    if (!result.ok) return result;
    moveFocusToPane(result.cellId);
    return { ok: true };
  }
  const openFileLinkRef = useRef(openFileLink);
  // The Editor pane a file link should reuse: the one you worked in last, per workspace.
  const lastEditorByWorkspaceRef = useRef(new Map<string, string>());
  // The Thread a selection from the Editor should land in: the one you talked to last.
  const lastThreadByWorkspaceRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (!activeWorkspaceId || !focusedCellId) return;
    const focused = workspaces
      .find((candidate) => candidate.id === activeWorkspaceId)
      ?.cells.find((cell) => cell.id === focusedCellId);
    if (focused?.type === "workbench") lastEditorByWorkspaceRef.current.set(activeWorkspaceId, focusedCellId);
    if (focused?.type === "chat") lastThreadByWorkspaceRef.current.set(activeWorkspaceId, focusedCellId);
  }, [activeWorkspaceId, focusedCellId, workspaces]);
  useEffect(() => {
    openFileLinkRef.current = openFileLink;
  });
  useEffect(() => onFileLinkOpen((workspaceId, link) => openFileLinkRef.current(workspaceId, link)), []);

  // Split right in an Editor pane: the file opens again in a new Editor pane beside it.
  function splitEditor(sourceCellId: string, path: string) {
    const workspace = workspaces.find((candidate) => candidate.cells.some((cell) => cell.id === sourceCellId));
    if (!workspace) return;
    // A maximised pane shows only whatever has focus, so the new pane would replace the source
    // in the frame instead of standing beside it: the split leaves the zoom, as VS Code does.
    if (isWorkspaceZoomed(workspace)) setWorkspaceZoom(workspace.id, null);
    const paneId = addCellPane(workspace.id, "workbench", sourceCellId, "horizontal");
    // Kept until the new pane mounts and takes it.
    requestWorkbenchOpen(paneId, { path });
    moveFocusToPane(paneId);
  }
  const splitEditorRef = useRef(splitEditor);
  useEffect(() => {
    splitEditorRef.current = splitEditor;
  });
  // `workspacesRef` is declared further down; it is only read when a pane asks.
  useEffect(() => onEditorSplit({
    holds: (cellId) => workspacesRef.current.some((workspace) => workspace.cells.some((cell) => cell.id === cellId)),
    split: (sourceCellId, path) => splitEditorRef.current(sourceCellId, path),
  }), []);

  // ⌘L in an Editor pane: the selection goes into the composer of this workspace's Thread — the
  // one used last, else a new one beside the Editor. Filled and focused, never sent.
  function sendSelectionToThread(sourceCellId: string, text: string): SelectionSendResult | null {
    const workspace = workspaces.find((candidate) => candidate.cells.some((cell) => cell.id === sourceCellId));
    // Not a pane of this window's workspaces: another surface answers for it.
    if (!workspace) return null;
    const result = routeSelectionToThread({
      workspace,
      preferredThreadId: lastThreadByWorkspaceRef.current.get(workspace.id) ?? null,
      sourceCellId,
      text,
      addThreadPane: (source) => createThreadPane(workspace.id, source),
    });
    if (!result.ok) return result;
    moveFocusToPane(result.paneId);
    return { ok: true };
  }
  const sendSelectionRef = useRef(sendSelectionToThread);
  useEffect(() => {
    sendSelectionRef.current = sendSelectionToThread;
  });
  useEffect(() => onSelectionSend((sourceCellId, text) => sendSelectionRef.current(sourceCellId, text)), []);

  /** Close a pane on request. `false` says plainly that this window does not have it. */
  function closePaneForMcp(paneId: string): boolean {
    const owner = workspaces.find((candidate) =>
      candidate.cells.some((cell) => cell.id === paneId),
    );
    if (!owner) return false;
    closeForAgent(owner.id, paneId);
    return true;
  }

  /** A launch row runs the CLI as the pane's process — the command comes from the machine. */
  function launchAgent(agent: ShellAgent) {
    if (!activeWorkspaceId) return;
    onRevealWork?.();
    splitNextPanesRef.current = activeWorkspaceId;
    setFocusedCellId(addPane(activeWorkspaceId, agent.command, undefined, agent.claudeAccount));
    // The next ⌘K starts on the default again, as the chip does.
    setLaunchAccount(null);
  }

  // Reported from an effect rather than during render: this is a message to a component ABOVE
  // this one, and sending it mid-render would be setting another component's state while React
  // is drawing this one.
  const terminals = cells.filter((cell) => cell.type === "terminal").length;
  const liveTerminals = livePaneCount(cells);
  const chatPanes = cells.filter((cell) => cell.type === "chat").length;

  /*
    The two activity counts are WINDOW-wide, while the inventory behind them is about the folder on
    screen. That asymmetry is deliberate: an unanswered prompt in another folder is invisible
    everywhere else in this shell, and a count that stopped at the current folder would make the
    pill quietly wrong in exactly the case it exists for. The jump below is what makes a
    window-wide number honest — it can take you there.
  */
  const attentionPaneIds = useMemo(() => needsYouPaneIds(paneActivities), [paneActivities]);
  const working = workingPaneCount(paneActivities);
  const needsYou = attentionPaneIds.length;
  // Results nobody has opened yet, oldest first. Window-wide like the counts above, for the same reason.
  const resultPaneIds = [...unreadResultIds];
  const statusLabel = codeModeStatusLabel({
    terminals,
    liveTerminals,
    chatPanes,
    working,
    needsYou,
    unread: resultPaneIds.length,
  });

  // Needs you (GLOSSARY), window-wide: a failed pane waits for the user as an ask does.
  const failedPanes = [...paneActivities.values()].filter((state) => state.activity === "failed").length;
  const waitingPanes = needsYou + failedPanes;
  const donePanes = resultPaneIds.length;
  const markPaneSeen = paneUnread.markRead;
  // The hue follows what is actually running: a workspace of conversations should not wear the
  // terminal colour.
  const statusTone: PaneKind = liveTerminals > 0 || chatPanes === 0 ? "terminal" : "thread";
  const focusedPane = cells.find((cell) => cell.id === focusedCellId) ?? cells[0] ?? null;

  /*
    Dev-only: what the SHELL thinks, printed next to what the renderer does.

    The renderer log shows panes being told visible and then hidden again by the same effect, which
    can only mean the inputs to `isPaneAttached` changed. Those inputs live here, so this is where
    they have to be read from — a renderer log alone cannot say whether focus moved once or twice.
  */
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    console.warn(
      `[pane-focus] focused=${(focusedCellId ?? "-").slice(0, 8)} focusMode=${focusMode} ` +
        `workspace=${(activeWorkspaceId ?? "-").slice(0, 8)} modeShown=${active} panes=${cells.length}`,
    );
  }, [active, activeWorkspaceId, cells.length, focusMode, focusedCellId]);
  /**
   * Dropping a file from Finder onto a terminal pane.
   *
   * The same hook CodeSpace uses, on the same PTY sessions — a drop here and a drop there put the
   * identical text in front of the identical agent. Three inputs decide what it may touch:
   *
   *  - `active`: only the mode on screen listens. Both modes stay mounted and stacked, so a drop
   *    meant for a conversation must not be caught by the terminals hidden behind it.
   *  - the cell list: only the SHOWN workspace's visible terminals. Every folder is rendered at
   *    once here, and a drop resolved by hit-testing must never reach a pane in another one —
   *    least of all a remote folder, where the file would be uploaded to the wrong machine.
   *  - the location: this folder's own, so a remote workspace uploads instead of typing a local
   *    path its shell cannot open.
   *
   * Focus is kept OUT of the key unless focus mode is on, where alone it changes the answer —
   * `isPaneVisible` shows every pane otherwise. The list is what the hook keys its native
   * drag-drop listener on, so a new array tears that listener down and registers another over
   * IPC; without this, every click on a pane opened a window in which a dropped file is lost.
   */
  const dropFocusKey = focusMode ? focusedCellId : null;
  const dropCells = useMemo(
    () => shellTerminalDropCells({ workspace: activeWorkspace, focusMode, focusedPaneId: dropFocusKey }),
    [activeWorkspace, focusMode, dropFocusKey],
  );
  const fileDrop = useTerminalFileDrop({
    active: keyboardLive,
    cells: dropCells,
    location: activeWorkspace?.location ?? null,
    onFocusCell: setFocusedCellId,
  });
  /**
   * Putting the real keyboard cursor in a pane.
   *
   * `focusedCellId` alone was only a COLOUR: picking a pane from the rail or with ⌘K moved the
   * highlight while the next keystroke still went to the pane before it. CodeSpace avoids that by
   * holding a ref to each terminal (`TerminalV2TerminalPane`); this shell cannot, because its panes
   * are four components from three modules and only one of them has a focus method.
   *
   * So the pane is found in the DOM and asked what to focus — the terminal runtime first, because
   * with the pooled renderer it knows where that pane's xterm actually is, and the element only when
   * it says no.
   *
   * On the next frame, not now: the pane the key names may still be `display: none` while focus mode
   * is on, and an element that is not laid out cannot take the cursor.
   */
  const deliverPaneFocus = useCallback((paneId: string) => {
    requestAnimationFrame(() => {
      if (terminalRuntime?.runtime?.focusPaneRenderer(paneId)) return;
      // Matched rather than selected: a pane id would have to be escaped to go inside a selector,
      // and `CSS.escape` is missing in the test environment. Comparing the attribute needs no
      // escaping at all, and there are never more than a screenful of panes to walk.
      const panes = document.querySelectorAll<HTMLElement>("[data-pane-id]");
      const pane = [...panes].find((candidate) => candidate.dataset.paneId === paneId) ?? null;
      paneFocusTarget(pane)?.focus();
    });
  }, [terminalRuntime?.runtime]);

  const moveFocusToPane = useCallback((paneId: string) => {
    setFocusedCellId(paneId);
    deliverPaneFocus(paneId);
  }, [deliverPaneFocus, setFocusedCellId]);

  /**
   * Moving focus from pane to pane — ⌘⌥Arrow, Ctrl+Tab, ⌘1..⌘9.
   *
   * In the CAPTURE phase, which is the whole reason it works: a terminal pane's xterm listens on its
   * own textarea, and a listener that waited its turn would never hear Ctrl+Tab. CodeSpace binds the
   * same keys the same way (`TerminalV2DynamicGridBridge`).
   *
   * Registered apart from the pane shortcuts above because it needs `moveFocusToPane`, which is
   * declared below them — one effect holding both would read it before it exists. Same reason ⌘K has
   * an effect of its own.
   *
   * The inputs are read through a ref: the workspace object is a new value whenever any pane reports
   * a status, and listing it would tear this listener down and register another several times a
   * second.
   */
  const focusMoveInputsRef = useRef({ workspace: activeWorkspace, focusedPaneId: focusedCellId });
  focusMoveInputsRef.current = { workspace: activeWorkspace, focusedPaneId: focusedCellId };
  useEffect(() => {
    if (!keyboardLive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const command = paneFocusShortcut(event);
      if (!command) return;
      // ⌘⇧Arrow is also "extend the selection to the line start" in the composer, the rail's rename
      // box and a conversation's prompt. Whoever is typing there asked for the selection, not for a
      // pane. A terminal is not such a field — see `keepsChordForTyping`.
      if (isTextSelectionChord(event) && keepsChordForTyping(event.target)) return;
      /*
        Claimed whether or not it moves anything. ⌘⌥→ at the right-hand edge has nowhere to go, and
        letting it fall through would hand a terminal an escape sequence for a key the user meant as
        navigation. `stopPropagation` is what keeps it away from xterm, which listens further down.
      */
      event.preventDefault();
      event.stopPropagation();
      const { workspace, focusedPaneId } = focusMoveInputsRef.current;
      const next = nextFocusedPaneId({ workspace, focusedPaneId, command });
      if (!next || next === focusedPaneId) return;
      moveFocusToPane(next);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keyboardLive, moveFocusToPane]);

  /** The hover and upload overlays belong to ONE pane; the notice is the window's, drawn once. */
  const paneDropOverlay = useCallback(
    (paneId: string) => {
      const overlay = fileDrop.overlay;
      if (!overlay || overlay.kind === "notice") return null;
      return overlay.cellId === paneId ? overlay : null;
    },
    [fileDrop.overlay],
  );

  const route = routeComposerMessage(focusedPane);
  const threadComposers = useThreadComposerRegistry();
  // Only set when a delivery actually fails, and cleared on the next attempt: a stale complaint
  // about a pane you are no longer typing into is worse than none.
  const [composerError, setComposerError] = useState<string | null>(null);

  const focusedRail = focusedPane ? railPaneForCell(focusedPane) : null;

  /**
   * Everything the shell can be asked to do, as rows.
   *
   * Rebuilt whenever the machine's catalog, the folders or the panes change — the rows carry live
   * closures, so a stale list would focus a pane that has since been closed.
   */
  const commandItems = useMemo(
    () =>
      buildCommandItems({
        agents: launchAgents,
        workspaces: railWorkspaces,
        activeWorkspaceName: activeWorkspace?.label?.trim() || null,
        onLaunchAgent: launchAgent,
        launchAccount,
        onCycleAccount: (accounts) => setLaunchAccount((current) => cycleAccount(accounts, current)),
        onCreatePane: addPaneOfKind,
        onOpenWorkspace: (workspaceId) => {
          onRevealWork?.();
          handleSelectWorkspace(workspaceId);
          onLayoutChange({ openWorkspaceIds: withOpen(layout.openWorkspaceIds, workspaceId) });
        },
        onOpenPane: (workspaceId, paneId) => {
          onRevealWork?.();
          if (workspaceId !== activeWorkspaceId) handleSelectWorkspace(workspaceId);
          moveFocusToPane(paneId);
        },
        onOpenFrame: openFrame,
        paneCount: cells.length,
        onTidyPanes: tidyPanes,
      }),
    /* `launchAgent` and `addPaneOfKind` are function declarations, recreated on every render:
       listing them would rebuild every row on every keystroke in a terminal. They close over
       state that IS listed here. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeWorkspace?.label,
      activeWorkspaceId,
      launchAgents,
      launchAccount,
      cells.length,
      focusedCellId,
      handleSelectWorkspace,
      layout.openWorkspaceIds,
      onLayoutChange,
      onRevealWork,
      railWorkspaces,
      setFocusedCellId,
    ],
  );

  const sheet = useCommandSheet(commandItems);

  /**
   * ⌘K, from anywhere in Code mode.
   *
   * Registered separately from the pane shortcuts above because it must reach the composer, which
   * is declared below this point — one effect holding both would read `sheet` before it exists.
   */
  const openCommandSheet = sheet.openBrowse;
  useEffect(() => {
    if (!keyboardLive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      openCommandSheet();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keyboardLive, openCommandSheet]);

  // Reported from an effect rather than during render: this is a message to a component ABOVE
  // this one, and sending it mid-render would be setting another component's state while React
  // is drawing this one.
  /*
    Reported from an effect and keyed on a SIGNATURE, not on the array: `workspaces` is rebuilt on
    every render of the workspace state, and handing a parent a new array each time would make it
    set state, re-render this mode, and be handed another one — the loop this file already paid for
    once with the status pill.
  */
  const projectSignature = workspaces.map((workspace) => `${workspace.id}:${workspace.label ?? ""}:${workspace.cwd}`).join("|");
  useEffect(() => {
    onProjectsChange?.(
      railWorkspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
    );
    // `railWorkspaces` already resolves the name the rail prints — one answer for both surfaces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSignature, onProjectsChange]);

  /*
    The spawner is published ONCE and kept, not rebuilt per render: it is stored by the window and
    handed to a hook, and a new identity on every pass would rebuild that hook's primitives and
    its callbacks with them. Keyed on nothing, because `addPane` from the workspace manager is
    itself stable.
  */
  const addPaneRef = useRef(addPane);
  addPaneRef.current = addPane;
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  useEffect(() => {
    onSpawnerChange?.({
      addPane: (workspaceId, agentCommand, cwdOverride, _task, claudeAccount) =>
        addPaneRef.current(workspaceId, agentCommand, cwdOverride, claudeAccount),
      activeWorkspaceId: () => activeWorkspaceIdRef.current ?? null,
      workspace: (id) => {
        const found = workspacesRef.current.find((candidate) => candidate.id === id);
        return found ? { cwd: found.cwd, remote: found.location?.kind === "ssh" } : null;
      },
      workspaces: () =>
        workspacesRef.current.map((w) => ({
          id: w.id,
          cwd: w.cwd,
          remote: w.location?.kind === "ssh",
          target: w.location?.kind === "ssh" ? sshKey(w.location) : undefined,
          name: w.name ?? w.label,
        })),
    });
    return () => onSpawnerChange?.(null);
  }, [onSpawnerChange]);

  /*
    Keyed on a SIGNATURE, never on the Map: `paneActivities` is rebuilt on every render, and
    handing a parent a new Map each time would make it set state, re-render this mode, and be
    handed another one — the loop this file has already paid for once.
  */
  const activitySignature = [...paneActivities]
    .map(([id, state]) => `${id}:${state.activity}`)
    .sort()
    .join("|");
  useEffect(() => {
    onActivitiesChange?.(paneActivities);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activitySignature, onActivitiesChange]);

  const focusKind = focusedRail?.kind;
  // Keyed on the id list, as `attentionKey` is: a new Set per render would re-report forever.
  const paneKey = workspaces.flatMap((workspace) => workspace.cells.map((cell) => cell.id)).join(" ");
  const paneIds = useMemo(() => new Set(paneKey.split(" ").filter(Boolean)), [paneKey]);
  const focusPane = useCallback((paneId: string) => jumpToPaneRef.current(paneId), []);
  const jumpWorkspaces = useCallback(() => jumpListRef.current(), []);
  const selectWorkspace = useCallback((workspaceId: string) => selectWorkspaceRef.current(workspaceId), []);
  useEffect(() => {
    onStatusChange?.({
      label: statusLabel,
      tone: statusTone,
      focusKind,
      attention: needsYou > 0,
      needsYou: { waiting: waitingPanes, done: donePanes },
      onMarkSeen: markPaneSeen,
      paneIds,
      onFocusPane: focusPane,
      jumpWorkspaces,
      onSelectWorkspace: selectWorkspace,
    });
  }, [donePanes, focusKind, focusPane, jumpWorkspaces, markPaneSeen, needsYou, onStatusChange, paneIds, selectWorkspace, statusLabel, statusTone, waitingPanes]);

  async function sendToFocusedPane(typed: string) {
    setComposerError(null);
    // Text kept for the pane it was spoken to goes there, wherever focus is now (ADR-0064). A kept
    // pane that has since closed lets go: the composer already shows the focused pane instead. A
    // focused Browser pane sends to its linked agent (PANE-LINK.md).
    const target = lockCell ? routeForPane(lockCell.id) : route;
    const targetId = lockCell?.id ?? focusedPane?.id;
    const picks = browserPicks && browserPicks.owner === targetId ? browserPicks.list : [];
    setKeptFor(null);
    if (target.kind === "blocked") return;
    const text = withBrowserPicks(typed, picks, target.kind === "terminal");
    // A Held Prompt in the same agent is still in its prompt: the message goes after it, as one.
    const outcome = await (heldPrompt.joins(target) ? heldPrompt.sendJoined(text) : deliverToRoute(text, target)).catch(
      (): CodeVoiceSendOutcome => ({ ok: false, reason: HELD_PROMPT_UNREACHABLE }),
    );
    // Picks stay in the composer when the message did not arrive.
    if (!outcome.ok) setComposerError(outcome.reason);
    else if (picks.length > 0) setBrowserPicks(null);
  }

  function routeForPane(paneId: string | null): ComposerRoute {
    return routeComposerMessage(paneId ? (cells.find((cell) => cell.id === paneId) ?? null) : null);
  }

  /** The one way text reaches a pane, for a typed Enter and a spoken turn alike. */
  async function deliverToRoute(text: string, target: Exclude<ComposerRoute, { kind: "blocked" }>): Promise<CodeVoiceSendOutcome> {
    if (target.kind === "terminal") {
      /*
        The prompt names the pane.

        A pane called after its folder tells you where it is and nothing about why it is open, and
        with two shells in one folder it does not even do that ("alwisofwan", "alwisofwan 2"). The
        name is written BEFORE the write goes out, so it is there while the agent is still starting,
        and `paneTitleSeed` refuses whenever the pane already has one — the first ask is what a pane
        is called, not the latest one. See `services/pane-title.ts` for why that is `bb`'s rule.
      */
      const targetCell = cells.find((cell) => cell.id === target.paneId);
      if (targetCell && activeWorkspaceId) {
        const seed = paneTitleSeed({ cell: targetCell, prompt: text, now: Date.now() });
        if (seed) updateCellTitle(activeWorkspaceId, targetCell.id, seed);
      }
      for (const chunk of ptyWritesForMessage(text)) {
        await writeToSession(target.runtimeSessionId, chunk);
      }
      return { ok: true };
    }
    // Delivered by CALLING the thread's own send, so the model, the attachments and the
    // context prefixes stay the conversation's business (M3).
    const delivered = threadComposers?.send(target.sessionId, text) ?? false;
    return delivered ? { ok: true } : { ok: false, reason: "That conversation is not ready to receive messages." };
  }

  // A spoken turn waiting, unsent, in an agent's own prompt (ADR-0064): see `useHeldPrompt`.
  const heldPrompt = useHeldPrompt({
    cells: allCells,
    threadComposers,
    onSent: (paneId, text) => {
      const cell = cells.find((candidate) => candidate.id === paneId);
      if (!cell || !activeWorkspaceId) return;
      const seed = paneTitleSeed({ cell, prompt: text, now: Date.now() });
      if (seed) updateCellTitle(activeWorkspaceId, cell.id, seed);
    },
  });
  async function actOnHeldPrompt(action: () => Promise<CodeVoiceSendOutcome>) {
    setComposerError(null);
    const outcome = await action();
    if (!outcome.ok) setComposerError(outcome.reason);
  }

  // Push-to-Talk (Voice Core): a spoken turn to a terminal agent waits in its prompt, otherwise in the
  // composer, or goes where Enter would have gone when the mic opened.
  const [composerInsert, setComposerInsert] = useState<{ text: string; seq: number; spoken?: string } | undefined>(undefined);
  /** Elements picked on a Browser pane's page, waiting in the composer for their agent (`owner`). */
  const [browserPicks, setBrowserPicks] = useState<{ owner: string; list: Pick[] } | null>(null);
  const browserPicksRef = useRef(false);
  useEffect(() => {
    browserPicksRef.current = Boolean(browserPicks?.list.length);
  }, [browserPicks]);
  /** The pane the text in the composer was spoken for, when focus moved away during that turn. */
  const [keptFor, setKeptFor] = useState<VoiceTurnTarget | null>(null);
  // The lock belongs to the message, not to one turn: text added to a message already in the field
  // continues it and goes where it goes; a new message takes the new turn's lock, or none.
  const composerEmptyRef = useRef(true);
  const onComposerEmptyChange = useCallback((empty: boolean) => {
    composerEmptyRef.current = empty;
    if (empty && !browserPicksRef.current) setKeptFor(null);
  }, []);
  // Shown with a lock only while it differs from focus; back on that pane, the target is just focus.
  const keptCell = keptFor && keptFor.id !== focusedPane?.id ? cells.find((cell) => cell.id === keptFor.id) : undefined;
  /** The panes of the folder on screen, by the names the rail shows — what voice can address. */
  const voicePanes = (): CodeVoicePane[] =>
    cells.map((cell) => {
      const activity = paneActivities.get(cell.id)?.activity;
      const rail = railPaneForCell(cell, activity);
      const agent = cell.type === "terminal" ? Boolean(rail.runner) : undefined;
      return { id: cell.id, name: rail.title, kind: rail.kind, activity, persona: rail.persona, agent, runner: rail.runner?.label };
    });

  // What each terminal pane printed last, for Live Voice's "what did Rowan say?". Every folder's
  // panes, not only the one on screen: switching folders must not wipe what an agent printed.
  const [outputTail] = useState(createPaneOutputTail);
  const terminalPaneKey = allCells.filter((cell) => cell.type === "terminal").map((cell) => cell.id).join(" ");
  const outputRuntime = terminalRuntime?.runtime ?? null;
  useEffect(() => {
    const paneIds = terminalPaneKey ? terminalPaneKey.split(" ") : [];
    outputTail.retain(new Set(paneIds));
    if (!outputRuntime) return;
    const stops = paneIds.map((paneId) => outputRuntime.subscribePaneOutput(paneId, (data) => outputTail.append(paneId, data)));
    return () => stops.forEach((stop) => stop());
  }, [outputRuntime, outputTail, terminalPaneKey]);

  // ── Browser panes ↔ agent panes (plans/code-browser-redesign/PANE-LINK.md) ──
  const linkAgentsOf = (workspace: Workspace): LinkAgent[] =>
    workspace.cells.filter(isLinkAgent).map((cell) => {
      // The handle ("Gio"), not the conversation title, which changes with what was asked.
      const pane = railPaneForCell(cell);
      return { id: cell.id, name: pane.persona ?? pane.title };
    });
  const ownerOf = (workspace: Workspace, browser: BrowserCellData) =>
    browserOwner({ linkedPaneId: browser.linkedPaneId, url: browser.url, agents: linkAgentsOf(workspace), tail: outputTail.read });
  /** A focused Browser pane talks through its agent: typing there goes to the agent, locked. */
  const focusedOwner = focusedPane?.type === "browser" && activeWorkspace ? ownerOf(activeWorkspace, focusedPane) : null;
  const lockCell = keptCell ?? (focusedOwner ? cells.find((cell) => cell.id === focusedOwner.id) : undefined);
  const lockName = keptCell ? keptFor!.name : focusedOwner?.name;
  // Picks for an agent that has since closed have nowhere to go: not shown, not sent.
  const shownPicks = browserPicks && cells.some((cell) => cell.id === browserPicks.owner) ? browserPicks.list : [];
  const [linkMenuFor, setLinkMenuFor] = useState<string | null>(null);
  /** Panes outlined together while a link chip, menu row or backlink is hovered. */
  const [linkHover, setLinkHover] = useState<readonly string[]>([]);
  /** A pick on a browser with no agent: kept while the link menu asks, then sent to the choice. */
  const pendingPick = useRef<{ browserId: string; payload: BrowserAnnotationPayload } | null>(null);
  const pickOwner = useRef(new Map<string, string>());
  const capturePick = usePickCapture({
    onPick: ({ slot }, pick) => {
      const owner = pickOwner.current.get(slot);
      if (owner) setBrowserPicks((current) => ({ owner, list: addPick(current?.owner === owner ? current.list : [], pick) }));
    },
    onNote: (_, note) => setComposerInsert((previous) => ({ text: note, seq: (previous?.seq ?? 0) + 1 })),
  });
  function pickInBrowser(workspace: Workspace, browser: BrowserCellData, payload: BrowserAnnotationPayload) {
    const owner = ownerOf(workspace, browser);
    if (!owner) {
      // The overlay reports one pick more than once: the first report (with the note) is the one kept.
      if (pendingPick.current?.payload.id !== payload.id || !payload.id) pendingPick.current = { browserId: browser.id, payload };
      setLinkMenuFor(browser.id);
      return;
    }
    // A guessed owner (it printed the address) becomes the kept link, so picks never wander.
    if (!browser.linkedPaneId) updateBrowserCellLink(workspace.id, browser.id, owner.id);
    const slot = codeBrowserSlot(browser.id);
    pickOwner.current.set(slot, owner.id);
    setKeptFor({ id: owner.id, name: owner.name });
    // Pictures are saved like a chat paste, under a UUID folder: the owner's id, else the browser's.
    capturePick({ slot, saveTo: UUID.test(owner.id) ? owner.id : browser.id }, payload).catch((reason: unknown) =>
      setComposerError(reason instanceof Error ? reason.message : String(reason)),
    );
  }
  function chooseLink(workspace: Workspace, browser: BrowserCellData, agentId: string) {
    updateBrowserCellLink(workspace.id, browser.id, agentId);
    const pending = pendingPick.current;
    pendingPick.current = null;
    if (pending?.browserId === browser.id) pickInBrowser(workspace, { ...browser, linkedPaneId: agentId }, pending.payload);
  }
  function removeBrowserPick(id: string) {
    const left = (browserPicks?.list ?? []).filter((pick) => pick.id !== id);
    setBrowserPicks(left.length > 0 && browserPicks ? { ...browserPicks, list: left } : null);
    if (left.length === 0 && composerEmptyRef.current) setKeptFor(null);
  }
  /** The Browser panes an agent owns, for the `↗ :3000` in its header. */
  const browsersOwnedBy = (workspace: Workspace, agent: GridCell) =>
    isLinkAgent(agent)
      ? workspace.cells.filter((cell): cell is BrowserCellData => cell.type === "browser" && ownerOf(workspace, cell)?.id === agent.id)
      : [];

  // Live Voice (ticket 10): Lotus acts on the panes by voice. A message goes straight in, as typed.
  const codeLive = useCodeLiveVoice({
    getPanes: voicePanes,
    focusedId: () => focusedPane?.id ?? null,
    focus: moveFocusToPane,
    send: (paneId, text) => {
      const target = routeForPane(paneId);
      return target.kind === "blocked" ? Promise.resolve({ ok: false, reason: target.reason }) : deliverToRoute(text, target);
    },
    launchable: () => launchAgents.filter((agent) => agent.installed).map((agent) => agent.name),
    spawn: (name) => {
      const agent = launchAgents.find((candidate) => candidate.installed && candidate.name === name);
      if (!agent || !activeWorkspaceId) return null;
      onRevealWork?.();
      const paneId = addPane(activeWorkspaceId, agent.command, undefined, agent.claudeAccount);
      setFocusedCellId(paneId);
      return paneId;
    },
    close: (paneId) => {
      const owner = workspaces.find((candidate) => candidate.cells.some((cell) => cell.id === paneId));
      if (owner) requestClosePane(owner.id, paneId);
    },
    readOutput: outputTail.read,
    projectId: activeWorkspaceCwd ? localProjectIdForRoot(activeWorkspaceCwd) : null,
    assistantCwd: activeWorkspace?.location?.kind === "ssh" ? null : activeWorkspaceCwd || null,
    memoryWrite: codecanvasMemoryWrite,
    memorySearch: codecanvasMemorySearch,
  });

  const voice = useCodeVoice({
    live: keyboardLive,
    liveVoice: codeLive.live,
    deps: {
      focused: () => (focusedPane && focusedRail ? { id: focusedPane.id, name: focusedRail.title } : null),
      routeFor: routeForPane,
      composerHasText: () => !composerEmptyRef.current,
      getPanes: voicePanes,
      sendRightAway: () => getVoiceInputSettings().sendRightAway,
      holdInComposer: (text, spoken, target) => {
        if (composerEmptyRef.current) setKeptFor(target ?? null);
        setComposerInsert((previous) => ({ text, spoken, seq: (previous?.seq ?? 0) + 1 }));
      },
      send: deliverToRoute,
      prompt: heldPrompt.place,
      liveTools: codeLive.liveTools,
    },
  });

  /** A pane menu's action, from the rail row or the pane's own header. */
  const actOnRailPane = (action: RailPaneAction, pane: RailPane, workspace: RailWorkspace, title?: string) => {
    const cell = workspacesRef.current.find((w) => w.id === workspace.id)?.cells.find((c) => c.id === pane.id);
    if (!cell) return;
    const sink = {
      latestCell: () => workspacesRef.current.find((w) => w.id === workspace.id)?.cells.find((c) => c.id === pane.id),
      onTitle: (patch: Parameters<typeof updateCellTitle>[2]) => updateCellTitle(workspace.id, pane.id, patch),
      onChatThread: (thread: Parameters<typeof updateChatPaneThread>[2]) => updateChatPaneThread(workspace.id, pane.id, thread),
    };
    if (action === "rename") renamePane(cell, title ?? "", sink);
    else if (action === "retitle") void regeneratePaneConversationTitle(cell, sink).catch(() => {});
    else if (action === "close") requestClosePane(workspace.id, pane.id);
    else {
      // Maximise shows whatever has focus, so the pane is brought up and focused first.
      onRevealWork?.();
      if (workspace.id !== activeWorkspaceId) handleSelectWorkspace(workspace.id);
      moveFocusToPane(pane.id);
      setWorkspaceZoom(workspace.id, pane.id);
    }
  };
  /** Move a pane into a group, a new group, or out: from a menu or a rail drag. */
  const regroupPane = (action: RegroupAction, pane: RailPane, workspace: RailWorkspace) => {
    let made = null as string | null;
    editFrames(workspace.id, (frames) => {
      if (action.kind === "out") return takePaneOut(frames, pane.id);
      let next = frames;
      let frameId = action.kind === "move" ? action.frameId : null;
      if (!frameId) {
        next = createFrame(frames, { name: "New group", now: Date.now(), newId: () => `frame-${crypto.randomUUID()}` });
        frameId = made = next[next.length - 1].id;
      }
      const target = next.find((frame) => frame.id === frameId);
      // The split it leaves, down to one pane, dissolves on the next reconcile.
      return addPaneToFrame(next, frameId, pane.id, frameDirection(target));
    });
    // Its new Frame comes on screen with it.
    onRevealWork?.();
    if (workspace.id !== activeWorkspaceId) handleSelectWorkspace(workspace.id);
    moveFocusToPane(pane.id);
    return made;
  };

  /** Two panes on one screen trade places: a header dropped on another pane. Splits keep their sizes. */
  const swapPanes = (workspace: Workspace, a: string, b: string) => {
    const screen = screenViewOf(workspace, {
      focusedPaneId: workspace.id === activeWorkspaceId ? focusedCellId : null,
      openFrameId: openFrameIdFor(workspace.id),
    });
    if (!screen.layout || screen.kind === "pane") return;
    const swapped = swapTerminalV2LayoutPanes(screen.layout, a, b);
    updateWorkspacePaneLayout(workspace.id, {
      ...workspace.paneLayout,
      mode: workspace.paneLayout?.mode ?? "grid",
      focusCellId: workspace.paneLayout?.focusCellId ?? null,
      ...(screen.kind === "frame"
        ? { frames: setFrameLayout(workspace.paneLayout?.frames ?? [], screen.frameId, swapped) }
        : { terminalV2Layout: swapped }),
    });
  };

  function renderPane(paneWorkspace: Workspace) {
    return function renderWorkspacePane(cell: GridCell) {
    const rail = railPaneForCell(cell);
    // Its OWN folder's zoom, never the window's: every folder's panes are rendered here.
    const paneZoom = isWorkspaceZoomed(paneWorkspace);
    return (
      <PaneCard
        key={cell.id}
        paneId={cell.id}
        kind={rail.kind}
        title={rail.title}
        meta={rail.meta}
        /* Who the pane is, and what is running inside it — the same two facts a CodeCanvas node
           wears. Both come from the mapping above, so the header, the rail and an `@mention`
           cannot disagree about an agent's name. */
        persona={rail.persona}
        runner={rail.runner}
        personaControl={
          cell.type === "terminal" && rail.persona && rail.runner ? (
            <AgentNameControl
              name={rail.persona}
              onRename={(name) => {
                const error = renameTerminalAgent(paneWorkspace.id, cell.id, name);
                if (error) return agentRenameErrorText(error);
                setRenameNotices((previous) => ({ ...previous, [cell.id]: name.trim() }));
                return null;
              }}
            />
          ) : undefined
        }
        /* Only the kinds that run something get a badge; a browser pane has no state to report,
           and "ready" over a web page is noise wearing the costume of information. */
        activity={paneKindReportsActivity(rail.kind) ? paneActivities.get(cell.id)?.activity : undefined}
        activitySince={paneActivities.get(cell.id)?.since}
        unread={unreadResultIds.has(cell.id)}
        className={linkHover.includes(cell.id) ? "ws-pane--linked" : undefined}
        focused={cell.id === focusedCellId}
        maximized={paneZoom && cell.id === focusedCellId}
        hidden={!isPaneVisible({ focusMode: paneZoom, focusedPaneId: focusedCellId, paneId: cell.id })}
        onMaximize={() => {
          // Maximising a pane that is not focused focuses it first: focus mode shows whatever
          // has focus, so the two must agree before the mode turns on.
          setFocusedCellId(cell.id);
          setWorkspaceZoom(paneWorkspace.id, paneZoom && cell.id === focusedCellId ? null : cell.id);
        }}
        onFocus={() => {
          setFocusedCellId(cell.id);
          // A click or a keyboard focus is opening the pane; hover never reaches here.
          paneUnread.markRead(cell.id);
        }}
        onClose={() => requestClosePane(paneWorkspace.id, cell.id)}
        /* A header drags onto a rail group (move) or onto another pane on screen (swap places). */
        swapWorkspaceId={paneWorkspace.id}
        onHeaderPointerDown={(event) => {
          const workspace = railWorkspaces.find((candidate) => candidate.id === paneWorkspace.id);
          const pane = workspace?.panes.find((candidate) => candidate.id === cell.id);
          if (!workspace || !pane) return;
          beginPaneDrag(event, {
            label: rail.persona || rail.title,
            paneId: cell.id,
            workspaceId: workspace.id,
            fromFrameId: workspace.frames?.find((frame) => frame.paneIds.includes(cell.id))?.id ?? null,
            canSwap: true,
            onDrop: (drop) => (drop.kind === "swap" ? swapPanes(paneWorkspace, cell.id, drop.paneId) : regroupPane(drop, pane, workspace)),
          });
        }}
        onHeaderContextMenu={(event) => {
          // A title being renamed keeps the native menu: copy and paste live there.
          if ((event.target as HTMLElement).closest("input, textarea")) return;
          event.preventDefault();
          setHeaderMenu({ paneId: cell.id, workspaceId: paneWorkspace.id, x: event.clientX, y: event.clientY });
        }}
        titleControl={
          // The conversation's title, renamable and regenerable as in Chat and Canvas.
          hasPaneConversation(cell, Boolean(rail.runner)) ? (
            <PaneTitleControl
              cell={cell}
              latestCell={() => workspacesRef.current.find((w) => w.id === paneWorkspace.id)?.cells.find((c) => c.id === cell.id)}
              onTitle={(patch) => updateCellTitle(paneWorkspace.id, cell.id, patch)}
              onChatThread={(thread) => updateChatPaneThread(paneWorkspace.id, cell.id, thread)}
            />
          ) : undefined
        }
        headerExtra={
          <>
            {renameNotices[cell.id] ? (
              <span className="ws-rename-notice" title="Lotus tells the agent its new name when it finishes this turn">
                <Clock size={11} aria-hidden /> Tells {renameNotices[cell.id]} when free
              </span>
            ) : null}
            {
              // An account names a folder on this desktop; an SSH pane runs on the far machine.
              cell.type === "terminal" && paneWorkspace.location?.kind !== "ssh" && providerFromAgentCommand(cell.agentCommand) === "claude" ? (
                <PaneAccountChip
                  paneId={cell.id}
                  account={cell.claudeAccount}
                  command={cell.agentCommand ?? "claude"}
                  name={rail.persona || rail.title}
                  busy={paneActivities.get(cell.id)?.activity === "working"}
                  onMove={(account, command) => {
                    paneLimits.clear(cell.id);
                    moveTerminalToAccount(paneWorkspace.id, cell.id, account, command);
                  }}
                />
              ) : undefined
            }
            <BrowserBacklink
              browsers={browsersOwnedBy(paneWorkspace, cell)}
              onGo={moveFocusToPane}
              onHover={(ids) => setLinkHover(ids.length > 0 ? [cell.id, ...ids] : [])}
            />
          </>
        }
      >
        <PaneBody
          workspace={paneWorkspace}
          cell={cell}
          focused={cell.id === focusedCellId}
          /*
            Two different questions, so two props.

            `active`: is this pane on screen right now? Native webviews (browser, workbench) need
            it — they are drawn by the OS above the page, so no CSS can hide them.

            `attached`: may this terminal keep its renderer? Saying "no" releases the pooled slot
            and disposes the pane's own xterm, and coming back rebuilds both. A hidden mode or a
            hidden workspace is not a reason for that; see `isPaneAttached`.
          */
          active={
            paneWorkspace.id === activeWorkspaceId
            && isPaneVisible({ focusMode: paneZoom, focusedPaneId: focusedCellId, paneId: cell.id })
          }
          attached={isPaneAttached({
            workspaceActive: paneWorkspace.id === activeWorkspaceId,
            modeShown: active,
            focusMode: paneZoom,
            focusedPaneId: focusedCellId,
            paneId: cell.id,
          })}
          maximized={paneZoom && cell.id === focusedCellId}
          onRuntimeSessionIdChange={(paneId, sessionId) =>
            updateCellRuntimeSessionId(paneWorkspace.id, paneId, sessionId)
          }
          onRuntimeStatusChange={(paneId, status) =>
            updateCellRuntimeStatus(paneWorkspace.id, paneId, status)
          }
          onAgentExit={(paneId) => fallBackToShell(paneWorkspace.id, paneId)}
          onRelaunch={(paneId) => relaunchTerminal(paneWorkspace.id, paneId)}
          onBrowserUrlChange={(paneId, url) => updateBrowserCellUrl(paneWorkspace.id, paneId, url)}
          onBrowserPick={(_, payload) => {
            if (cell.type === "browser") pickInBrowser(paneWorkspace, cell, payload);
          }}
          browserLink={
            cell.type === "browser"
              ? {
                  owner: ownerOf(paneWorkspace, cell),
                  agents: linkAgentsOf(paneWorkspace),
                  open: linkMenuFor === cell.id,
                  onOpenChange: (open) => {
                    setLinkMenuFor(open ? cell.id : null);
                    if (!open) pendingPick.current = null;
                  },
                  onChoose: (agentId) => chooseLink(paneWorkspace, cell, agentId),
                  onHover: (agentId) => setLinkHover(agentId ? [cell.id, agentId] : []),
                }
              : undefined
          }
          onUpdateWorkbenchCell={(paneId, updater) =>
            updateWorkbenchCell(paneWorkspace.id, paneId, updater)
          }
          onChatThreadChange={(paneId, thread) => updateChatPaneThread(paneWorkspace.id, paneId, thread)}
          onClosePane={(paneId) => requestClosePane(paneWorkspace.id, paneId)}
        />
        {cell.type === "terminal" && paneLimits.limits.has(cell.id) ? (
          <PaneLimitStrip
            paneId={cell.id}
            account={cell.claudeAccount}
            command={cell.agentCommand ?? "claude"}
            limit={paneLimits.limits.get(cell.id)!}
            onMove={(account, command) => {
              paneLimits.clear(cell.id);
              moveTerminalToAccount(paneWorkspace.id, cell.id, account, command);
            }}
          />
        ) : null}
        {/* Drawn over the pane body, never the header: the header is how you still tell the panes
            apart while a drag is in flight. Non-terminal panes never produce an overlay, because
            they are never a drop target. */}
        <TerminalFileDropOverlay state={paneDropOverlay(cell.id)} />
      </PaneCard>
    );
    };
  }

  /**
   * Everything this mode draws, inside the bus the MCP bridges need.
   *
   * Applied to BOTH branches below — the wizard included. A window that is reachable only while
   * it has a workspace open is a window the phone loses the moment someone starts creating one,
   * and `lotus_spawn_cell` would then time out rather than answer.
   */
  const withFleetBridges = (body: ReactNode) => (
    <CellBusProvider
      workspaceId={activeWorkspaceId}
      onRequestSpawn={(agentCommand) => {
        spawnPaneForMcp(agentCommand);
      }}
    >
      <ShellFleetBridges
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        updateTerminalAgentIdentity={updateTerminalAgentIdentity}
        onAgentEnded={(workspaceId, paneId) => fallBackToShell(workspaceId, paneId, true)}
        onSpawn={spawnPaneForMcp}
        onClose={closePaneForMcp}
      />
      {body}
    </CellBusProvider>
  );

  // One launch path for the New workspace page and the empty state's saved presets.
  const launchFromLayout: ComponentProps<typeof ConfigureLayoutView>["onLaunch"] = (template, cwd, agentCommands, workspaceLabel, remote) => {
    if (!remote) return launchWorkspace(template, cwd, agentCommands, workspaceLabel);
    const target = { host: remote.host, user: remote.user ?? null, port: remote.port ?? null };
    void createSshWorkspace(target, workspaceLabel ?? remoteWorkspaceLabel(remote.host, cwd), cwd, template, agentCommands)
      .then(handleCancelWizard)
      .catch((error) => console.error("Failed to open the folder on another machine", error));
  };

  if (wizardActive) {
    // The wizard takes the whole body: it is a decision about what to create, and a half-visible
    // grid behind it would suggest the workspace already exists.
    return withFleetBridges(
      <div className="ws-body" ref={bodyRef}>
        <div className="ws-card ws-pane-slot--fill">
          {view.name === "layout" ? (
            <ConfigureLayoutView
              onCancel={handleCancelWizard}
              onPickRemote={() => new Promise((resolve) => {
                remotePickRef.current?.(null);
                remotePickRef.current = resolve;
                setRemotePickerOpen(true);
              })}
              onLaunch={launchFromLayout}
            />
          ) : null}
        </div>
        {remotePickerOpen ? (
          <RemoteFolderPicker
            onClose={() => settleRemotePick(null)}
            onOpen={(target, root) => settleRemotePick({
              remote: { kind: "ssh", host: target.host, user: target.user ?? undefined, port: target.port ?? undefined },
              cwd: root,
            })}
          />
        ) : null}
      </div>,
    );
  }

  return withFleetBridges(
    <div className="ws-body" ref={bodyRef} {...railMotionProps(railPresence, railSize)}>
      {(() => {
        const workspace = headerMenu && railWorkspaces.find((candidate) => candidate.id === headerMenu.workspaceId);
        const pane = workspace?.panes.find((candidate) => candidate.id === headerMenu?.paneId);
        if (!headerMenu || !workspace || !pane) return null;
        return (
          <RailPaneMenu
            pane={pane}
            folder={workspace.name}
            at={headerMenu}
            hide={["rename"]}
            onAct={(action) => {
              setHeaderMenu(null);
              actOnRailPane(action, pane, workspace);
            }}
            onClose={() => setHeaderMenu(null)}
            {...(workspace.frames ? regroupOptions(pane, workspace) : {})}
            onRegroup={
              workspace.frames
                ? (action) => {
                    setHeaderMenu(null);
                    regroupPane(action, pane, workspace);
                  }
                : undefined
            }
          />
        );
      })()}
      {addMenu ? (
        <AddPaneMenu
          workspaceName={addMenu.workspace.name}
          anchor={addMenu.anchor}
          onAddPane={(kind) => {
            looseNextPanesRef.current = addMenu.loose ? addMenu.workspace.id : null;
            addPaneOfKind(kind);
            setAddMenu(null);
          }}
          /* The commit button now commits. It closes after starting, not instead of it. */
          onStartPreset={(preset) => {
            looseNextPanesRef.current = addMenu.loose ? addMenu.workspace.id : null;
            startPreset(preset);
            setAddMenu(null);
          }}
          onClose={() => setAddMenu(null)}
        />
      ) : null}

      {deletedFrame ? (
        <TasksToast
          // A new delete is a new toast, on its own clock.
          key={deletedFrame.deleted.frame.id}
          label="Ungrouped"
          message={deletedFrame.message}
          action="Undo"
          onAction={() => {
            editFrames(deletedFrame.workspaceId, (frames) => restoreFrame(frames, deletedFrame.deleted));
            setDeletedFrame(null);
          }}
          onDismiss={dismissDeletedFrame}
        />
      ) : null}

      {/* The rail stays mounted while hidden, so showing it builds nothing: it only becomes
          visible and slides in. Rebuilding it on every show left the slot empty for a moment. */}
      <div
        className="ws-pane-slot"
        ref={railSlotRef}
        data-rail={railPresence ?? "hidden"}
        inert={railPresence ? undefined : true}
        aria-hidden={railPresence ? undefined : true}
        style={{ width: railSize }}
      >
        <WorkspaceRail
          navSlot={navSlot}
          sectionSlot={sectionSlot}
          workspaces={railWorkspaces}
          openWorkspaceIds={openWorkspaceIds}
          activePaneId={focusedCellId}
          activeFrameId={activeScreen?.kind === "frame" ? activeScreen.frameId : null}
          onRenameFrame={(workspaceId, frameId, name) => editFrames(workspaceId, (frames) => renameFrame(frames, frameId, name))}
          onRecolorFrame={(workspaceId, frameId, color) => editFrames(workspaceId, (frames) => recolorFrame(frames, frameId, color))}
          onDeleteFrame={(frame, workspace) =>
            editFrames(workspace.id, (frames) => {
              // Only the Frame goes: its panes keep running, loose, and the screen follows focus.
              const { frames: next, deleted } = deleteFrame(frames, frame.id);
              // Separating a split loses nothing worth an Undo: it had no name.
              if (deleted && !isSplit(deleted.frame)) {
                const count = deleted.frame.paneIds.length;
                const stay = `${paneCountLabel(count)} ${count === 1 ? "stays" : "stay"} open`;
                setDeletedFrame({ workspaceId: workspace.id, message: `Ungrouped “${frame.name}” — ${stay}`, deleted });
              }
              return next;
            })
          }
          /* Expanding is not showing: the chevron only folds, so a folder can be left open
             while another one is on screen. */
          onToggleWorkspace={(workspaceId) =>
            onLayoutChange({ openWorkspaceIds: toggleOpen(layout.openWorkspaceIds, workspaceId) })
          }
          onOpenWorkspace={(workspaceId) => {
            onRevealWork?.();
            handleSelectWorkspace(workspaceId);
            onLayoutChange({ openWorkspaceIds: withOpen(layout.openWorkspaceIds, workspaceId) });
          }}
          onTogglePin={(workspaceId) =>
            onLayoutChange({ pinnedWorkspaceIds: togglePinned(layout.pinnedWorkspaceIds, workspaceId) })
          }
          onRenameWorkspace={renameWorkspace}
          onPaneAction={actOnRailPane}
          /* Picking a pane in another folder brings that folder up with it — the pane the
             rail says is focused has to be the pane on screen. */
          onSelectPane={(pane, workspace) => {
            onRevealWork?.();
            if (workspace.id !== activeWorkspaceId) handleSelectWorkspace(workspace.id);
            moveFocusToPane(pane.id);
          }}
          onAddWorkspace={() => {
            onRevealWork?.();
            handleOpenLayoutWizard();
          }}
          onAddPane={(workspace, anchor) => {
            onRevealWork?.();
            handleSelectWorkspace(workspace.id);
            setAddMenu({ workspace, anchor, loose: true });
          }}
          onRegroupPane={regroupPane}
        />
      </div>
      {railPresence ? (
        <SplitHandle
          orientation="vertical"
          size={railSize}
          min={RAIL_MIN}
          max={railMax}
          defaultSize={RAIL_DEFAULT}
          label="Resize workspace rail"
          onResize={(next) => onLayoutChange({ railWidth: next })}
        />
      ) : null}

      {/* Mounted and alive, but out of reach while a panel covers it: the panes keep their
          renderer slots — hiding is not detaching (§M2) — and nothing under the panel can be
          clicked or tabbed into. */}
      <div className="ws-column" inert={columnOverlay ? true : undefined} aria-hidden={columnOverlay ? true : undefined}>
        {/*
          EVERY workspace is rendered, and the inactive ones are only hidden.

          CodeSpace does the same thing for the same reason: unmounting a workspace tears down
          every terminal in it, so switching folders would kill running agents — and, measured on
          2026-09-20, throw from the pooled renderer as it tried to snapshot a buffer that was
          already disposed.
        */}
        <ManagedHostBanner location={activeWorkspace?.location} />
        <div className="ws-workspace-stack" ref={gridRef}>
          {workspaces.length === 0 ? (
            <CodeEmptyState
              onNewWorkspace={handleOpenLayoutWizard}
              onLaunchPreset={({ preset, template, agentCommands }) => {
                void markPresetOpened(preset.id).catch(() => undefined);
                launchFromLayout(template, preset.cwd, agentCommands, preset.name, preset.location);
              }}
            />
          ) : (
            workspaces.map((paneWorkspace) => {
              // The split draws the workspace's view, not the workspace itself.
              const screen = screenViewOf(paneWorkspace, {
                focusedPaneId: paneWorkspace.id === activeWorkspaceId ? focusedCellId : null,
                openFrameId: openFrameIdFor(paneWorkspace.id),
              });
              const screenRoot = screen.layout?.root;
              return (
              <div
                key={paneWorkspace.id}
                className="ws-workspace"
                data-active={paneWorkspace.id === activeWorkspaceId ? "true" : "false"}
                aria-hidden={paneWorkspace.id !== activeWorkspaceId}
                inert={paneWorkspace.id !== activeWorkspaceId ? true : undefined}
              >
                {screen.cells.length === 0 ? (
                  <div className="ws-card ws-pane-slot--fill">
                    {screen.kind === "frame" ? (
                      /* An empty Frame says what to do next: one button per runner. A pane opened
                         here joins the Frame, because the Frame is on screen. */
                      <RailEmptyState
                        action={
                          <span className="ws-frame-empty-actions">
                            {(["claude", "codex"] as const).map((id) => {
                              const agent = launchAgents.find((candidate) => candidate.id === id && candidate.installed);
                              return agent ? (
                                <button key={id} type="button" className="ws-rail-empty-action" onClick={() => launchAgent(agent)}>
                                  {agent.name}
                                </button>
                              ) : null;
                            })}
                            <button type="button" className="ws-rail-empty-action" onClick={() => addPaneOfKind("terminal")}>
                              Terminal
                            </button>
                            <button type="button" className="ws-rail-empty-action" onClick={() => addPaneOfKind("browser")}>
                              Browser
                            </button>
                          </span>
                        }
                      >
                        This Frame has no panes yet.
                      </RailEmptyState>
                    ) : (
                      <RailEmptyState>This workspace has no panes yet.</RailEmptyState>
                    )}
                  </div>
                ) : screenRoot ? (
                  /*
                    ONE tree, in one place, whether or not focus mode is on.

                    Focus mode used to render its own `<div className="ws-focus-mode">` wrapping a
                    second `<SplitTree>`. Same panes, same root — but a different position in the
                    element tree, so React unmounted every pane and mounted it again on each
                    toggle. Measured in the native window on 2026-09-21: seven panes' renderer
                    slots unregistering and re-registering per toggle, and a pane whose slot came
                    back was left blank (see the coordinator's `registerPaneSlot`).

                    Now the wrapper is always there and only its data attribute changes, so a
                    toggle is a CSS change and nothing is torn down.

                    The split tree is also the richer layout and the one the engine maintains on
                    every split, so it wins whenever it exists: each seam moves exactly one pair
                    of panes. The row/column grid stays for workspaces never split, which have no
                    tree yet.
                  */
                  <div
                    className="ws-split-root"
                    data-focus-mode={
                      isWorkspaceZoomed(paneWorkspace)
                      && screen.cells.some((paneCell) => paneCell.id === focusedCellId)
                        ? "true"
                        : undefined
                    }
                  >
                    <SplitTree
                      node={screenRoot}
                      path={[]}
                      renderPane={(paneId) => {
                        const paneCell = screen.cells.find((candidate) => candidate.id === paneId);
                        return paneCell ? renderPane(paneWorkspace)(paneCell) : null;
                      }}
                      onResize={(path, sizes) => {
                        // A seam drag means nothing while one pane fills the frame.
                        if (isWorkspaceZoomed(paneWorkspace)) return;
                        const layout = screen.layout;
                        if (!layout) return;
                        const resized = resizeTerminalV2LayoutSplit(layout, path, sizes);
                        updateWorkspacePaneLayout(paneWorkspace.id, {
                          ...paneWorkspace.paneLayout,
                          // `mode` is required: a layout without it would drop the workspace out
                          // of whatever view it is in (focus, main-right) on the first seam drag.
                          mode: paneWorkspace.paneLayout?.mode ?? "grid",
                          focusCellId: paneWorkspace.paneLayout?.focusCellId ?? null,
                          ...(screen.kind === "frame"
                            // A Frame keeps its own split: the seam belongs to it, not to the workspace.
                            ? { frames: setFrameLayout(paneWorkspace.paneLayout?.frames ?? [], screen.frameId, resized) }
                            : { terminalV2Layout: resized }),
                        });
                      }}
                    />
                  </div>
                ) : (
                  <WorkspaceGrid
                    workspace={paneWorkspace}
                    containerWidth={grid.width}
                    containerHeight={grid.height}
                    renderPane={renderPane(paneWorkspace)}
                    onResizeColumn={(columnIndex, deltaPx, containerWidth) =>
                      resizePaneColumn(paneWorkspace.id, columnIndex, deltaPx, containerWidth)
                    }
                    onResizeRow={(rowIndex, deltaPx, containerHeight) =>
                      resizePaneRow(paneWorkspace.id, rowIndex, deltaPx, containerHeight)
                    }
                  />
                )}
              </div>
              );
            })
          )}
        </div>

        {/* No pane, nothing to send to: the empty page owns the column. */}
        {workspaces.length === 0 ? null : <UnifiedComposer
          target={
            lockCell
              ? { kind: railPaneForCell(lockCell).kind, label: lockName!, locked: true }
              : focusedRail && focusedPane
              ? {
                  kind: focusedRail.kind,
                  label: focusedRail.title,
                  activity: paneKindReportsActivity(focusedRail.kind)
                    ? paneActivities.get(focusedPane.id)?.activity
                    : undefined,
                }
              : null
          }
          placeholder={lockCell ? `Message ${lockName}…` : focusedRail ? `Message ${focusedRail.title}…` : "Type here…"}
          sheet={sheet}
          onSubmit={lockCell || route.kind !== "blocked" ? sendToFocusedPane : undefined}
          disabledReason={
            lockCell
              ? composerError ?? undefined
              : focusedPane?.type === "browser"
                ? "Choose an agent for this browser: the chip in its header."
                : route.kind === "blocked"
                  ? route.reason
                  : composerError ?? undefined
          }
          extras={
            shownPicks.length > 0
              ? {
                  node: (
                    <ul className="chat-picks ws-composer-picks" aria-label="Picked on the page">
                      {shownPicks.map((pick) => (
                        <PickChip key={pick.id} pick={pick} onRemove={() => removeBrowserPick(pick.id)} />
                      ))}
                    </ul>
                  ),
                  ready: true,
                }
              : null
          }
          voice={{
            phase: voice.phase,
            interim: voice.interim,
            onToggle: voice.toggle,
            onCancel: voice.cancel,
            levelTarget: voice.levelTarget,
            hotkey: voice.hotkeyLabel,
            available: voice.available,
            held: voice.held,
          }}
          liveVoice={{ hotkey: voice.liveHotkeyLabel, onStart: voice.startLiveVoice }}
          liveSession={{
            active: codeLive.live.active,
            phase: codeLive.live.phase,
            agentSpeaking: codeLive.live.agentSpeaking,
            error: codeLive.live.error,
            providerName: codeLive.live.providerName,
            strip: codeLive.strip,
            onEnd: codeLive.live.stop,
            onRetry: () => void codeLive.live.start(),
            micMuted: codeLive.live.micMuted,
            onToggleMic: () => codeLive.live.setMicMuted(!codeLive.live.micMuted),
            ending: codeLive.live.ending,
            working: codeLive.live.working,
            endNote: codeLive.endNote,
          }}
          insert={composerInsert}
          heldPrompt={
            heldPrompt.held
              ? {
                  label: heldPrompt.held.name,
                  seq: heldPrompt.held.seq,
                  cleaned: heldPrompt.held.cleaned,
                  joinsMessage: heldPrompt.joins(lockCell ? routeForPane(lockCell.id) : route),
                  onSend: () => void actOnHeldPrompt(heldPrompt.send),
                  onClear: () => void actOnHeldPrompt(heldPrompt.clear),
                }
              : null
          }
          notice={voice.notice}
          onEmptyChange={onComposerEmptyChange}
          floating
        />}

        {/* One notice for the window, not one per pane: it reports the outcome of a drop that has
            already happened, and the pane it happened in may be off screen by the time it lands. */}
        <TerminalFileDropOverlay state={fileDrop.overlay?.kind === "notice" ? fileDrop.overlay : null} onDismiss={fileDrop.dismissOverlay} />
        {unsavedCloseDialog}
      </div>

      {/* Drawn beside the rail, not over it. The offset is this mode's own rail width, which is
          the only place that number is known for certain. */}
      {columnOverlay ? (
        <div
          className="ws-column-overlay"
          style={{ left: railVisible ? railSize + RAIL_OVERLAY_SEAM : 0 }}
        >
          {columnOverlay}
        </div>
      ) : null}
    </div>,
  );
}

/** An agent's own browsers, in its header: `↗ :3000`. Click goes there; hover outlines both panes. */
function BrowserBacklink({
  browsers,
  onGo,
  onHover,
}: {
  browsers: readonly BrowserCellData[];
  onGo: (paneId: string) => void;
  onHover: (browserIds: string[]) => void;
}) {
  const first = browsers[0];
  if (!first) return null;
  const more = browsers.length - 1;
  return (
    <button
      type="button"
      className="ws-browser-backlink"
      title={more > 0 ? `${browsers.length} browsers send picks here · click for the first` : "This agent's browser · click to go there"}
      onClick={() => onGo(first.id)}
      onMouseEnter={() => onHover(browsers.map((browser) => browser.id))}
      onMouseLeave={() => onHover([])}
    >
      ↗ {shortAddress(addressOf(first.url) ?? "")}
      {more > 0 ? ` +${more}` : null}
    </button>
  );
}
