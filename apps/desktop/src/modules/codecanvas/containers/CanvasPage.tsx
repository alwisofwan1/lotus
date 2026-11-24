"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import {
  ReactFlow,
  ViewportPortal,
  ConnectionMode,
  SelectionMode,
  BackgroundVariant,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { CanvasConnectionLine } from "../components/edges/CanvasConnectionLine";
import { CanvasToolRail } from "../components/CanvasToolRail";
import { CanvasDrawCapture } from "../components/CanvasDrawCapture";
import { CanvasEraseCapture } from "../components/CanvasEraseCapture";
import { InspectorPanel, type ArrangeAction } from "../components/InspectorPanel";
import { resolveToolShortcut, shapeForTool, type CanvasTool } from "../services/canvas-tool";
import { recordCapturedSession } from "../services/session-sync";
import { canvasSessionStore } from "../services/session-store";
import { agentSessionControlRegistry } from "../services/session-control-registry";
import type { CanvasSessionRecord } from "../services/session-record";
import { attachSessionToNode } from "../services/session-mutations";
import type { SessionNotice } from "../services/session-verdict-copy";
import { boundsWithRunMargin, fitInsideRunMargin, nodeRect, runGroupArrangeMargin, runGroupDrop, runGroupsOf, runMemberLabel } from "../services/run-group";
import { isRunNodeActive } from "../services/run-node-activity";
import { useSessionDispatch } from "../hooks/useSessionDispatch";
import { CanvasAddProjectPanel } from "../components/panels/CanvasAddProjectPanel";
import { resolveTopControlsMode } from "../services/canvas-layout-mode";
import { applyShapeStylePatch, cycleSelectBehind, textToolEditTarget } from "../services/canvas-shape";
import { applySelectionElevation } from "../services/canvas-node-elevation";
import { useShapeHistory } from "../hooks/useShapeHistory";
import { CanvasSnapGuides } from "../components/CanvasSnapGuides";
import { CanvasJumpLabels } from "../components/CanvasJumpLabels";
import { CanvasDock, DOCK_DELEGATE_UNAVAILABLE } from "./CanvasDock";
import { useCanvasDock, useCanvasDockChords } from "../hooks/useCanvasDock";
import { jumpLabelsStore } from "../services/jump-labels-store";
import { onScreenNodeIds } from "../services/canvas-jump-labels";
import { canvasSnapStore } from "../services/canvas-snap-store";
import { shapeHitTest } from "../services/canvas-erase";
import { liveThemedShapeStyle } from "../services/canvas-theme-fill";
import { sharedShapeStyle, selectionSections } from "../services/inspector-selection";
import { duplicateShapes } from "../services/canvas-duplicate";
import { canCreateFrame, canDissolveFrame, membershipChangesForDrop, resolveAgentFrameRef } from "../services/canvas-frames";
import { canvasFrameDropStore } from "../services/canvas-frame-drop-store";
import { canvasFrameEditStore } from "../services/canvas-frame-edit-store";
import { FrameActionsContext } from "../components/nodes/frame-actions-context";
import { CanvasFrameDeleteDialog } from "../components/CanvasFrameDeleteDialog";
import { CanvasFrameDrawCapture } from "../components/CanvasFrameDrawCapture";
import { CanvasFrameToast } from "../components/CanvasFrameToast";
import { CanvasFrameHint } from "../components/CanvasFrameHint";
import { CanvasFrameSuggestion } from "../components/CanvasFrameSuggestion";
import { CanvasFrameSelectionToolbar } from "../components/CanvasFrameSelectionToolbar";
import type { AgentNodeStatus, CanvasShapeKind, CanvasSkillPreview, CanvasShapeNodeData, CanvasShapeStyle, ShapeNodePatch } from "../types/canvas";
import { CanvasTopBar } from "../components/CanvasTopBar";
import { useMachineTunnel } from "../hooks/useMachineTunnel";
import type { CanvasMachineStatusProps } from "../components/CanvasMachineStatus";
import { machineRecheck } from "@/lib/tauri/codespace-editor-ssh";
import { adoptionShapeFor, cellLabel, type RemoteHostCell } from "../services/remote-host";
import { CanvasesModal } from "../components/CanvasesModal";
import { useCanvasFrameGrid } from "../hooks/useCanvasFrameGrid";
import { CanvasFrameOverviewLayer } from "../components/CanvasFrameOverviewLayer";
import { useCanvasFrameOverview } from "../hooks/useCanvasFrameOverview";
import { useLotusSettings, useLotusSettingsHost, type LotusSettingsHost } from "@/modules/lotus-settings/lotus-settings-context";
import { CanvasProjectEmptyState } from "../components/CanvasProjectEmptyState";
import { CanvasProjectRestoringState } from "../components/CanvasProjectRestoringState";
import { getHomedir, isTauri } from "@/lib/tauri-api";
import { buildRecentProjects, projectDisplayName } from "../services/recent-projects";
import { useCanvasBoard } from "../hooks/useCanvasBoard";
import { useCanvasTheme } from "../hooks/useCanvasTheme";
import { toCanvasThemeStyle } from "../services/theme/canvas-theme-style";
import { TEXT_SIZE_REM } from "../types/canvas-theme";
import { useAppliedSkillGuard } from "../hooks/useAppliedSkillGuard";
import { useCanvasSkillDnd } from "../hooks/useCanvasSkillDnd";
import { useCanvasNodeIntake, type CanvasIntakeClientPoint, type CanvasIntakeTarget } from "../hooks/useCanvasNodeIntake";
import type { CanvasNodeIntakeKind } from "../services/canvas-node-intake";
import { buildCanvasIntakeEffects } from "../services/canvas-intake-effects";
import { agentReplyRegistry } from "../services/agent-reply-registry";
import type { CanvasImageRef, CanvasIntakePayload } from "../services/canvas-intake";
import { canvasAttachmentStore } from "../services/canvas-attachment-store";
import { placeImageShapes } from "../services/canvas-image-shape";
import { canvasImageRefToNoteAsset, measureNoteAssetImage, parseNoteAssetUri } from "../services/note-assets";
import { canvasDropTargetStore, pickIntersectingDropTarget } from "../services/canvas-drop-target-store";
import { codecanvasStageNoteAssetForAgent } from "@/lib/tauri/codecanvas";
import { getTerminalSessionInput, writeTerminalSession } from "@/modules/codespace/services/terminal-session-registry";
import { CanvasCornerControls } from "../components/CanvasCornerControls";
import { CanvasAdaptiveBackground, type CanvasBackgroundPattern } from "../components/CanvasAdaptiveBackground";
import { CanvasLodViewportMarker } from "../components/CanvasLodViewportMarker";
import { CanvasFrameChromeMarker } from "../components/CanvasFrameChromeMarker";
import { CanvasNlCommandBar } from "../components/CanvasNlCommandBar";
import { useAgentStatusSnapshots } from "../hooks/useAgentStatusSnapshots";
import { useCanvasFrameUi } from "../hooks/useCanvasFrameUi";
import { commandBarFocusRegistry } from "../services/command-bar-focus-registry";
import { CanvasCommandDeliveryOverlay } from "../components/CanvasCommandDeliveryOverlay";
import { CanvasCollaborationRunOverlay, type CanvasCollaborationMarkBlockedInput, type CanvasCollaborationRecordEvidenceInput } from "../components/CanvasCollaborationRunOverlay";
import { useHoldSpeechWhileLive, useVoiceFeedback } from "@/modules/voice-core/use-voice-feedback";
import { subscribeAgentHookEvents, useNarrationChannel } from "../services/narration/use-narration-channel";
import { agentStatusRegistry } from "../services/agent-status-registry";
import { nlComplete } from "@/lib/tauri-api";
import { useTtsProviderRegistry } from "@/lib/hooks/useTtsProviderRegistry";
import { bundledPersonaSource, loadPersona, personaNameForTone } from "../services/voice/persona/canvas-persona";
import { LiveVoiceStatusProvider, useLiveVoiceStatusState } from "@/modules/voice-core/live-voice-status";
import { useAgentDoneCallouts, type AgentFinishInfo } from "../hooks/useAgentDoneCallouts";
import { useAgentCompletionToasts } from "../hooks/useAgentCompletionToasts";
import { AgentCompletionToasts } from "../components/AgentCompletionToasts";
import { buildCompletionToast } from "../services/agent-completion-toast";
import { computeAnnounceVisibility, rectsIntersect } from "../services/voice/agent-done-callout";
import { CanvasGraphRunProvider } from "../components/CanvasGraphRunProvider";
import { useCanvasCollaborationLaunch } from "../hooks/useCanvasCollaborationLaunch";
import { useCanvasCollaborationTask } from "../hooks/useCanvasCollaborationTask";
import { useCanvasCollaborationLedger } from "../hooks/useCanvasCollaborationLedger";
import { useCanvasCollaborationContext } from "../hooks/useCanvasCollaborationContext";
import { canvasCollaborationRunId } from "../services/collaboration/canvas-collaboration-ledger";
import { useCanvasCollaborationMailbox } from "../hooks/useCanvasCollaborationMailbox";
import { useCanvasFleetPush } from "../hooks/useCanvasFleetPush";
import { useAgentTurnFacts } from "../hooks/useAgentTurnFacts";
import { useAgentHeadlineFeed } from "../hooks/useAgentHeadlineFeed";
import { fleetBriefing } from "../services/fleet-briefing";
import { canvasRuntimePaneId } from "../services/canvas-runtime-scope";
import { paneAskBuffer } from "../services/pane-ask-buffer";
import { isSkillStillApplied } from "../services/skills/applied-skill-presence";
import { mergeNeedsYou, needsYouQueue, nextNeedsYouTarget } from "../services/needs-you-queue";
import { agentTurnRegistry } from "../services/agent-turn-registry";
import { useMcpCanvasDispatchBridge } from "../hooks/useMcpCanvasDispatchBridge";
import { useMcpCanvasControlBridge } from "../hooks/useMcpCanvasControlBridge";
import { useMcpCanvasDrawBridge } from "../hooks/useMcpCanvasDrawBridge";
import { measureDiagramLabel } from "../services/agent-draw/measure-label";
import { buildSceneReadback } from "../services/agent-draw/scene-readback";
import { AgentDraftPill } from "../components/AgentDraftPill";
import { useMcpCanvasSpawnBridge } from "../hooks/useMcpCanvasSpawnBridge";
import { useCanvasFollowPaneBridge } from "../hooks/useCanvasFollowPaneBridge";
import { useMcpCloseBridge } from "@/modules/codespace/hooks/useMcpCloseBridge";
import { nodeIdFromPaneId } from "../services/canvas-spawn-depth";
import { buildSpawnFirstAgentDefinition } from "../services/spawn-first-agent";
import { useAutomationAgentWatch } from "../hooks/useAutomationAgentWatch";
import { useCanvasTaskSpawner } from "../hooks/useCanvasTaskSpawner";
import { useCanvasFactoryBrainstorm } from "../hooks/useCanvasFactoryBrainstorm";
import { canvasPaneNodes, useCanvasTaskActivities } from "../hooks/useCanvasTaskActivities";
import { getActiveProjectLocation } from "../services/canvas-active-project";
import { indexProjectFiles } from "../services/file-node/file-node-io";
import { createFileBoardLinks } from "../services/file-node/file-board-links";
import { pathToOpenOnEnter } from "../services/file-node/file-node-enter";
import { openInCode } from "../services/open-in-code";
import { routeSelectionToCanvasAgent } from "../services/selection-to-canvas-agent";
import { machineFromLocation, wireTarget } from "../services/machine";
import { useOptionalSharedTrackerBoard } from "@/modules/workspace-shell/hooks/TrackerBoardProvider";
import { useCanvasTaskLinks } from "../hooks/useCanvasTaskLinks";
import { useCanvasSheetTasks } from "../hooks/useCanvasSheetTasks";
import { CanvasTaskLinksContext } from "../components/nodes/canvas-task-links-context";
import { noteAgentSpawnPosition, noteAgentWire } from "../services/nodes/note-agent-link";
import { useMcpNotesBridge } from "../hooks/useMcpNotesBridge";
import { useMcpCanvasCollaborationBridge } from "../hooks/useMcpCanvasCollaborationBridge";
import { centeredSpawnPosition } from "../services/canvas-spawn-position";
import { ARRANGE_ANIM_MS, isTiledCanvasNode } from "../services/canvas-arrange";
import { shouldEnterFocusFromDoubleClick } from "../services/canvas-focus-layout";
import { CANVAS_MOTION, TIDY_DEBOUNCE_MS, canvasEaseOutQuint, canvasMotionEnabled, holdCanvasArrangeGlide, holdCanvasNodeDrag, releaseCanvasNodeDrag } from "../services/canvas-motion";
import { runCanvasViewportMotion } from "../services/viewport/canvas-viewport-motion";
import { frameBoundsInVisibleArea, measureVisibleCanvasArea } from "../services/viewport/canvas-visible-frame";
import { useCanvasFocusMode } from "../hooks/useCanvasFocusMode";
import { useCanvasProjectFocusView } from "../runtime/useCanvasProjectFocusView";
import { CanvasPaperMedia } from "../components/CanvasPaperMedia";
import { useCanvasKeyboardControls } from "../hooks/useCanvasKeyboardControls";
import { useCanvasOcclusionLock } from "../hooks/useCanvasOcclusionLock";
import { useCanvasHotkeys } from "../hooks/useCanvasHotkeys";
import {
  findNodeFocusTarget,
  focusCanvasNodeInput,
  isEditableCanvasKeyTarget,
  isTerminalKeyTarget,
} from "../services/canvas-keyboard-guard";
import {
  nearestNodeInDirection,
  stepInOrder,
  type SpatialDirection,
  type SpatialRect,
} from "../services/canvas-spatial-nav";
import { useCanvasCommandDeliveryQueue } from "../hooks/useCanvasCommandDeliveryQueue";
import { useCanvasProjectSidebarActions } from "../hooks/useCanvasProjectSidebarActions";
import { useCanvasViewportPersistence } from "../hooks/useCanvasViewportPersistence";
import { useCanvasViewportMotionSnapshot } from "../hooks/useCanvasViewportMotion";
import { useCanvasBehaviorSettings, getCanvasBehaviorSettings } from "../hooks/useCanvasBehaviorSettings";
import { currentNamePool } from "@/lib/agent-naming";
import { shouldTidyOnMutation } from "../services/canvas-tidy-trigger";
import { decideMutationTidy } from "../services/canvas-frame-retile";
import { activeFrameCanvasKey, canvasActiveFrameStore, decideUserArrange, resolveActiveFrameId, useActiveFrameId } from "../services/canvas-active-frame";
import { useCanvasFrameFocus } from "../hooks/useCanvasFrameFocus";
import { isCanvasCreateCommand, type CanvasCommand, type CanvasCommandResult } from "../services/commands/canvas-command";
import { useCanvasTaskDispatch } from "../hooks/useCanvasTaskDispatch";
import { useCanvasTerminalDispatch } from "../hooks/useCanvasTerminalDispatch";
import { useRouter } from "next/navigation";
import { buildMissingAssigneeSpawnSpecs, projectCanvasCollaborationParticipants } from "../services/collaboration/canvas-collaboration-participants";

import { useCanvasBrowserApiBridge } from "../runtime/useCanvasBrowserApiBridge";
import { useDevServerAutoOpen } from "../hooks/useDevServerAutoOpen";
import { useCanvasBrowserActivityBridge } from "../runtime/useCanvasBrowserActivityBridge";
import { useCanvasFocusCommands } from "../runtime/useCanvasFocusCommands";
import { useCanvasNodeCommandDispatcher } from "../runtime/useCanvasNodeCommandDispatcher";
import { useCanvasProjectMaintenance } from "../runtime/useCanvasProjectMaintenance";
import { useCanvasCommandCenter } from "../runtime/useCanvasCommandCenter";
import { useCanvasTaskCommands } from "../runtime/useCanvasTaskCommands";
import { CANVAS_EDGE_TYPES, CANVAS_NODE_TYPES, createCanvasFlowInjector } from "./canvas-flow-config";
const INTAKE_NODE_TYPES = new Set<CanvasNodeIntakeKind>(["note", "terminal", "agent", "skills", "skill", "plan"]);

function nodeToIntakeTarget(node: Node | undefined): CanvasIntakeTarget | null {
  if (!node?.type || !INTAKE_NODE_TYPES.has(node.type as CanvasNodeIntakeKind)) return null;
  return { id: node.id, kind: node.type as CanvasNodeIntakeKind };
}

function nodeIdFromElementAtPoint(point: CanvasIntakeClientPoint): string | null {
  const el = document.elementFromPoint(point.clientX, point.clientY);
  if (!(el instanceof HTMLElement)) return null;
  return el.closest(".react-flow__node")?.getAttribute("data-id") ?? null;
}

export interface CanvasPageProps {
}

/** Escape a node id for use inside a `[data-id="…"]` attribute selector. */
function cssEscapeId(id: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
}

export function CanvasPage() {
  const router = useRouter();
  const voice = useVoiceFeedback();
  const commandDelivery = useCanvasCommandDeliveryQueue();
  const {
    nodes, edges,
    onNodesChange, onBeforeDelete, onEdgesChange, onConnect, onReconnect, isValidConnection,
    removeEdge, updateEdgeLabel,
    addTerminalNode, addLaunchedTerminalNode, addAdoptedCellNode, addHostCellNode, addNoteNode, addShapeNode, addShapeNodes, addImageShapeNode, reorderNodesByIds, arrangeNodes, arrangeFrameMembers, retileFrameMembers, applyFrameGrid, applyFocusLayout, captureLayoutSnapshot, restoreLayoutSnapshot, settleLayoutSnapshot, createFrame, addEmptyFrame, addFrameInBox, renameFrameNode, recolorFrameNode, fitFrameNode, deleteFrameAndContents, dissolveFrame, applyFrameMembership, sendNodesToFrame, spawnCentreRef, setSelectedNodes, addSkillsNode, addSkillNode, addAgentNode, addPlanNode, addTaskNode, addContextNode, addCriticNode, addHumanGateNode, addTeamNode, addMusicNode, addFactoryNode, addFileNode, addRunNode,
    appendDispatch, spawnTerminalChild, patchNodeData, agentCounterRef,
    removeNode, markNodeLeaving, markAllNodesLeaving, removeAllNodes, closeError, handleNoteChange, focusNode, morphNoteToTask,
    commitAgentDraw, applyDraftBatch, discardDraftBatch,
    restoreShapeSnapshot,
    loadSnapshot,
    projects, activeProjectId, activeProject, rootDir, loading, booted, showPicker, openProject,
    selectProject, renameProject, closeProject, setBeforeBoardSwap, setPrepareNodesForSave,
    spawnBrowserNode, spawnStandaloneBrowserNode, closeBrowserNode,
  } = useCanvasBoard();

  // "New project" opens the native OS folder picker (Finder / Explorer) directly — no
  // intermediate page. Selecting a folder opens it as the project root. In browser dev
  // (no Tauri) we fall back to a manual path prompt.
  // "Add project" opens the picker (`design/vps-connector.html`, screens 01-03): a machine is a
  // choice in that list, not a separate mode. The native folder dialog is one of its rows.
  const [addProjectOpen, setAddProjectOpen] = useState(false);

  const handleNewProjectViaDialog = useCallback(async () => {
    if (!isTauri()) {
      const manual = typeof window !== "undefined" ? window.prompt("Project root path") : null;
      if (manual && manual.trim()) void openProject(manual.trim());
      return;
    }
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({ directory: true, multiple: false, title: "Open a project" });
      if (typeof selected === "string" && selected.trim()) void openProject(selected.trim());
    } catch {
      /* dialog cancelled or unavailable */
    }
  }, [openProject]);
  const taskDispatch = useCanvasTaskDispatch();
  const terminalDispatch = useCanvasTerminalDispatch();
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<Node, Edge> | null>(null);
  // The Canvas Dock (plans/canvas-dock/): Automation, Factory, Tasks and Fleet, one panel on the
  // right. Declared before the camera code because everything that flies to a node reads it.
  const dock = useCanvasDock();
  const dockStateRef = useRef({ open: dock.open, wide: dock.wide });
  dockStateRef.current = { open: dock.open, wide: dock.wide };
  const readDock = useCallback(() => dockStateRef.current, []);

  // Focus mode (spotlight): hero + right-rail layout morph, snapshot-restored on exit. The fleet
  // rail that used to share this machine moved into the Canvas Dock (plans/canvas-dock/ S6).
  const { focusedNodeId, enterFocus, exitFocus, refreshFocus, inspectFocus, settleFocus } = useCanvasFocusMode({
    flowInstance,
    nodes,
    applyFocusLayout,
    captureLayoutSnapshot,
    restoreLayoutSnapshot,
    // The hero is the selection — see `onHeroChange` for why that has to be said out loud.
    onHeroChange: useCallback(
      (nodeId: string) => setSelectedNodes(new Set([nodeId])),
      [setSelectedNodes],
    ),
    readDock,
  });
  const focusedNodeIdRef = useRef(focusedNodeId);
  focusedNodeIdRef.current = focusedNodeId;

  useCanvasProjectFocusView({
    activeProjectId,
    loading,
    ready: flowInstance !== null,
    nodes,
    setBeforeBoardSwap,
    setPrepareNodesForSave,
    inspectFocus,
    settleFocus,
    settleLayoutSnapshot,
    restoreFocus: enterFocus,
  });

  const dockChords = useCanvasDockChords();
  const { open: dockOpen, toggle: toggleDock, show: showDock, close: closeDock, showFactoryRun, showFactoryNewRun } = dock;
  // Read by ⌘J, which walks the one Needs-you queue (S5) from a handler, not a render.
  const dockAsksRef = useRef(dock.asks);
  dockAsksRef.current = dock.asks;
  const dockOpenRef = useRef(dock.open);
  dockOpenRef.current = dock.open;
  const lastNeedsYouJumpRef = useRef<string | null>(null);
  const openAutomation = useCallback(() => showDock("automation"), [showDock]);
  const openFleet = useCallback(() => showDock("fleet"), [showDock]);
  const [connectingWire, setConnectingWire] = useState(false);

  // Agent-done voice callouts (ADR-0031): a node is "visible" when its screen rect intersects the
  // viewport AND the app window is focused/unhidden — a blurred or minimized window classifies as
  // background so the away-from-app finish is announced (computeAnnounceVisibility).
  const isAgentVisible = useCallback(
    (nodeId: string): boolean => {
      if (!flowInstance || typeof window === "undefined") return false;
      const node = flowInstance.getNode(nodeId);
      if (!node) return false;
      const w = node.width ?? node.measured?.width ?? 0;
      const h = node.height ?? node.measured?.height ?? 0;
      const tl = flowInstance.flowToScreenPosition({ x: node.position.x, y: node.position.y });
      const br = flowInstance.flowToScreenPosition({ x: node.position.x + w, y: node.position.y + h });
      const rectVisible = rectsIntersect(
        { left: tl.x, top: tl.y, right: br.x, bottom: br.y },
        { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
      );
      return computeAnnounceVisibility(rectVisible, document.hasFocus(), document.hidden);
    },
    [flowInstance],
  );
  // A cross-project finish (an agent in a project other than the one on screen) is named by its repo
  // so a multi-project user knows WHERE the work landed. Resolve projectId → repo label from the
  // known projects (alias / basename), same convention as the picker/sphere.
  const resolveProjectLabel = useCallback(
    (projectId: string): string | null => {
      const project = projects.find((p) => p.id === projectId);
      return project ? projectDisplayName(project) : null;
    },
    [projects],
  );
  // The same question `resolveProjectLabel` answers, in the shape the fleet push needs: every
  // project this window can name, keyed by id. Built here because `projects` is the index the
  // board already holds — a second lookup path would be a second answer to "what is this called".
  const fleetProjectCatalog = useMemo(
    () =>
      Object.fromEntries(
        projects.map((project) => [project.id, { cwd: project.rootDir, name: projectDisplayName(project) }]),
      ),
    [projects],
  );
  // App-level completion toasts (visual, voice-independent). The callout hook reports every turn-end
  // for a known agent; we turn each into a toast that names WHERE it finished. A re-firing agent
  // replaces its own toast (latest-wins) inside the queue.
  const completionToasts = useAgentCompletionToasts();
  const pushCompletionToast = completionToasts.push;
  const toastSeqRef = useRef(0);
  const emitCompletionToast = useCallback(
    (info: AgentFinishInfo) => {
      pushCompletionToast(
        buildCompletionToast({
          eventId: `${info.agentId}:${(toastSeqRef.current += 1)}`,
          agentId: info.agentId,
          agentName: info.agentName,
          agentProjectId: info.agentProjectId,
          activeProjectId,
          resolveProjectLabel,
          now: Date.now(),
        }),
      );
    },
    [pushCompletionToast, activeProjectId, resolveProjectLabel],
  );
  const {
    canvasAnimations,
    showToolRail,
    topControls,
    toastPosition,
    completionToastAutoDismiss,
    autoOpenBrowserOnDevServer,
    liveNarration,
  } = useCanvasBehaviorSettings();
  useAgentDoneCallouts({
    announce: voice.announce,
    chime: voice.chime,
    canSpeak: voice.canSpeak,
    isVisible: isAgentVisible,
    activeProjectId,
    resolveProjectLabel,
    onFinish: emitCompletionToast,
    // Narration speaks a richer turn-end line from the same stop hook; two utterances through a
    // latest-wins speaker would abort each other.
    narrationCoversTurnEnd: liveNarration,
  });
  // Whiteboard undo/redo (⌘Z / ⇧⌘Z): shape-scoped, idle-coalesced, reset per project.
  // Membership (Frames) rides the same history, so a drag in/out undoes with ⌘Z too.
  const { undo: undoHistory, clear: clearHistory } = useShapeHistory({ nodes, edges, resetKey: activeProjectId, restore: restoreShapeSnapshot });
  // A node the user creates lands in the Frame holding the viewport centre (same centre
  // `centeredSpawnPosition` spawns at), or stays loose.
  useEffect(() => {
    spawnCentreRef.current = flowInstance ? () => centeredSpawnPosition(flowInstance, { w: 0, h: 0 }) ?? null : null;
    return () => { spawnCentreRef.current = null; };
  }, [flowInstance, spawnCentreRef]);
  // Hold ⌘/Ctrl while dragging a shape to bypass alignment snapping (Excalidraw). Window blur
  // resets the flag — a ⌘Tab away would otherwise leave snapping stuck off.
  useEffect(() => {
    const setBypass = (event: KeyboardEvent) => { canvasSnapStore.config.bypass = event.metaKey || event.ctrlKey; };
    const clearBypass = () => { canvasSnapStore.config.bypass = false; };
    window.addEventListener("keydown", setBypass);
    window.addEventListener("keyup", setBypass);
    window.addEventListener("blur", clearBypass);
    return () => {
      window.removeEventListener("keydown", setBypass);
      window.removeEventListener("keyup", setBypass);
      window.removeEventListener("blur", clearBypass);
    };
  }, []);
  // Whiteboard tool-rail state (UI-only). Picking a shape tool then clicking the canvas
  // creates that shape and snaps back to select.
  const [activeTool, setActiveTool] = useState<CanvasTool>("select");
  const activeShapeTool = shapeForTool(activeTool);
  // Excalidraw/Miro interaction model, driven by the tool rail:
  //  • Select (default): left-drag = marquee select; pan via middle/right-mouse or Space-drag.
  //  • Pan (hand): left-drag = pan.
  // Shape tools are handled by the CanvasDrawCapture overlay, so ReactFlow stays idle then.
  const panOnDrag: boolean | number[] = activeTool === "pan" ? true : activeTool === "select" ? [1, 2] : false;
  const selectionOnDrag = activeTool === "select";
  const handleCreateShape = useCallback(
    (shape: CanvasShapeKind, position: { x: number; y: number }, size: { w: number; h: number }, points?: Array<[number, number]>) => {
      // Text tool over an existing editable shape edits THAT shape's text (Excalidraw) instead of
      // stacking a loose text node that any later z change would hide under the shape.
      if (shape === "text") {
        const targetId = textToolEditTarget(position, nodes);
        if (targetId) {
          setSelectedNodes(new Set([targetId]));
          patchNodeData(targetId, { editRequestId: Date.now() });
          setActiveTool("select");
          return;
        }
      }
      // Premium theme-aware default: containers are born with a translucent tint of the live
      // theme accent (stamped, persisted) instead of fully transparent.
      addShapeNode(shape, position, size, points, liveThemedShapeStyle(shape) ?? undefined);
      setActiveTool("select");
    },
    [addShapeNode, nodes, setSelectedNodes, patchNodeData],
  );
  // Inspector targets the selected shapes (whiteboard layer only). Single → full per-kind panel;
  // multi → schema intersection with shared/mixed styling, applied to every selected shape.
  const selectedShapes = nodes.filter((node) => node.type === "shape" && node.selected);
  const primaryShape = selectedShapes[0];
  const multiSelect = selectedShapes.length > 1;
  const { shared: selectionShared, mixed: selectionMixed } = multiSelect
    ? sharedShapeStyle(selectedShapes.map((n) => (n.data as CanvasShapeNodeData).style))
    : { shared: {} as CanvasShapeStyle, mixed: new Set<keyof CanvasShapeStyle>() };

  // Style deltas merge into each shape's own style; text/areaLabel pass straight through.
  const handleShapePatch = useCallback((patch: ShapeNodePatch) => {
    for (const node of selectedShapes) {
      patchNodeData(node.id, applyShapeStylePatch((node.data as CanvasShapeNodeData).style, patch));
    }
  }, [selectedShapes, patchNodeData]);

  const handleShapeArrange = useCallback((action: ArrangeAction) => {
    if (selectedShapes.length === 0) return;
    if (action === "delete") { selectedShapes.forEach((n) => removeNode(n.id)); return; }
    // Arrange the whole selection/group as one contiguous block (single state update,
    // preserves relative order among members) — not shape-by-shape.
    if (action === "front" || action === "back") { reorderNodesByIds(selectedShapes.map((n) => n.id), action); return; }
    // duplicate: faithful copies (rotation, image, group as a NEW group) — see canvas-duplicate.ts.
    addShapeNodes(duplicateShapes(selectedShapes, { newId: () => crypto.randomUUID() }));
  }, [selectedShapes, removeNode, reorderNodesByIds, addShapeNodes]);

  // Read through a ref, never a dep: `persistAgentSession` must keep a stable identity (see below),
  // and it only ever runs after a capture, long after the current render committed.
  // Handles by node id, so a session row can say "Rowan · …" instead of a bare session title.
  const agentNamesByNodeId = useMemo(() => {
    const names: Record<string, string | undefined> = {};
    for (const node of nodes) {
      if (node.type !== "agent") continue;
      const name = (node.data as { name?: string }).name;
      if (name) names[node.id] = name;
    }
    return names;
  }, [nodes]);

  const nodesRefForSessions = useRef(nodes);
  nodesRefForSessions.current = nodes;
  const activeProjectIdRefForSessions = useRef(activeProjectId);
  activeProjectIdRefForSessions.current = activeProjectId;

  // Persist a live agent's freshly minted session id onto its node so the next reopen resumes it
  // (ADR-0027 Phase 5). Stable identity so LiveAgentNode's one-shot persist effect doesn't re-fire.
  //
  // Dual-write (`plans/codecanvas-session-widget/`, Slice 01): the same fact also goes to
  // `codecanvas_sessions`, where it can be listed, titled, and counted. The node pointer stays the
  // one LiveAgentNode reads to decide on `--resume`; the table is not load-bearing yet. A failure
  // here must therefore never disturb the pointer write, which is why it is fired and forgotten.
  const persistAgentSession = useCallback(
    async (nodeId: string, sessionId: string): Promise<boolean> => {
      const projectId = activeProjectIdRefForSessions.current;
      const node = nodesRefForSessions.current.find((n) => n.id === nodeId);
      const data = (node?.data ?? {}) as {
        runner?: string;
        runnerCommand?: string;
        account?: string;
        cwd?: string;
        name?: string;
        assignedWorktreePath?: string | null;
      };

      if (projectId) {
        try {
          const outcome = await recordCapturedSession({
            store: canvasSessionStore,
            projectId,
            nodeId,
            providerSessionId: sessionId,
            runner: data.runner,
            // A `custom` runner's type cannot name its command, so the row has to carry it or no
            // node can ever be rebuilt from it (`plans/codecanvas-session-refactor/issues/03`).
            runnerCommand: data.runnerCommand ?? null,
            account: data.account ?? null,
            cwd: data.assignedWorktreePath || data.cwd || "",
            worktreePath: data.assignedWorktreePath ?? null,
            agentName: data.name,
          });
          // The one case that must NOT reach the node: another node already owns this conversation.
          // Writing the pointer anyway would make both nodes resume the same transcript.
          if (outcome.kind === "claimed-elsewhere") return false;
        } catch (error) {
          // Any other failure is the table's problem, not the node's. The pointer is still what
          // drives resume today (Slice 01), so a store outage must not cost the user their session.
          console.warn("[canvas] session row not recorded:", error);
        }
      }

      patchNodeData(nodeId, { resumeSessionId: sessionId });
      return true;
    },
    [patchNodeData],
  );

  /**
   * Point a node at a different conversation (Session Widget, Slice 04).
   *
   * Deliberately NOT `persistAgentSession`: that one records an id a CLI just created, and its
   * empty-string case marks a session dead. Switching away from a conversation must leave it
   * resumable — you are stepping out of it, not losing it.
   */
  const switchAgentSession = useCallback(
    (nodeId: string, providerSessionId: string | null) => {
      patchNodeData(nodeId, { resumeSessionId: providerSessionId ?? "" });

      const projectId = activeProjectIdRefForSessions.current;
      if (!projectId) return;
      void (async () => {
        try {
          const rows = await canvasSessionStore.list(projectId);
          for (const row of rows.filter((r) => r.nodeId === nodeId)) {
            const isTarget = Boolean(providerSessionId) && row.providerSessionId === providerSessionId;
            const next = isTarget ? "live" : row.status === "live" ? "resumable" : row.status;
            if (next !== row.status) await canvasSessionStore.upsert({ ...row, status: next });
          }
        } catch (error) {
          // Status is a cache; a failure here costs a label, never the switch itself.
          console.warn("[canvas] session status not updated after switch:", error);
        }
      })();
    },
    [patchNodeData],
  );

  /**
   * Move a Claude node to another account. The node relaunches on it and resumes the same
   * conversation; the live session row follows, so a node rebuilt from it keeps the new account.
   */
  const switchAgentAccount = useCallback(
    (nodeId: string, account: string) => {
      patchNodeData(nodeId, { account });
      const projectId = activeProjectIdRefForSessions.current;
      if (!projectId) return;
      void (async () => {
        try {
          const rows = await canvasSessionStore.list(projectId);
          for (const row of rows.filter((r) => r.nodeId === nodeId && r.status === "live")) {
            await canvasSessionStore.upsert({ ...row, account });
          }
        } catch (error) {
          // The node holds the account the next launch uses; the row only matters for a rebuild.
          console.warn("[canvas] session row account not updated:", error);
        }
      })();
    },
    [patchNodeData],
  );

  /**
   * Step the focused agent node to its previous/next conversation.
   *
   * Silent no-ops on purpose when there is nothing to do: a node with one session, a node that is
   * not an agent, or no selection at all. A hotkey that beeps at you for pressing it on the wrong
   * node teaches you not to press it.
   */
  /**
   * Filled in below, once the dispatcher exists. A ref and not a dependency because this callback is
   * registered as a hotkey handler and must keep a stable identity.
   */
  const dispatchSessionRef = useRef<((session: CanvasSessionRecord) => Promise<void>) | null>(null);
  const cycleFocusedNodeSession = useCallback(
    (direction: 1 | -1) => {
      const nodeId = selectedNodeIdRef.current;
      if (!nodeId) return;
      const control = agentSessionControlRegistry.get(nodeId);
      if (!control) return;

      const sessions = control.sessions().filter((s) => s.status !== "dead");
      if (sessions.length < 2) return;

      const activeId = control.activeSessionId();
      const index = sessions.findIndex((s) => s.id === activeId);
      // Wraps, so a two-session node toggles between them with the same key.
      const nextIndex = index < 0 ? 0 : (index + direction + sessions.length) % sessions.length;
      const next = sessions[nextIndex];
      // Through the dispatcher like every other surface, so a refusal here speaks too.
      if (next && next.id !== activeId) void dispatchSessionRef.current?.(next);
    },
    [],
  );

  // ── Frames (Cmd+G creates one around the selection, any node kind; Cmd+Shift+G dissolves) ──
  // Full Frame UX (drag in/out, title tab, menus) lands in LOT2-122 / LOT2-123.
  const selectedNodes = nodes.filter((node) => node.selected);
  const groupEligible = canCreateFrame(selectedNodes);
  const ungroupEligible = canDissolveFrame(selectedNodes);
  const handleGroup = useCallback(() => {
    if (!canCreateFrame(selectedNodes)) return;
    const frameId = createFrame(selectedNodes.map((n) => n.id));
    // The new Frame's title opens for typing, pre-filled with the auto name (Enter keeps, Esc reverts).
    if (frameId) canvasFrameEditStore.request(frameId);
  }, [selectedNodes, createFrame]);
  const handleUngroup = useCallback(() => {
    if (canDissolveFrame(selectedNodes)) dissolveFrame(selectedNodes.map((n) => n.id));
  }, [selectedNodes, dissolveFrame]);

  // Alt-click cycles the selection through overlapping shapes, one deeper per click (Excalidraw's
  // select-behind): once a shape covers another, plain clicks can only ever reach the top one.
  const handleNodeClick = useCallback((event: ReactMouseEvent, node: Node) => {
    if (!event.altKey || node.type !== "shape" || !flowInstance) return;
    const point = flowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const hits = shapeHitTest(
      nodes.filter((n) => n.type === "shape").map((n) => ({
        id: n.id,
        position: n.position,
        width: n.width ?? undefined,
        height: n.height ?? undefined,
        shape: (n.data as CanvasShapeNodeData).shape,
        points: (n.data as CanvasShapeNodeData).points,
      })),
      point,
    );
    const current = nodes.find((n) => n.type === "shape" && n.selected)?.id ?? null;
    const target = cycleSelectBehind(hits, current);
    if (target) setSelectedNodes(new Set([target]));
  }, [flowInstance, nodes, setSelectedNodes]);

  // Double-clicking a windowed node's chrome toggles focus mode — the gate keeps xterm word-select,
  // editors, rename, and buttons owning their own double-clicks. Shapes edit via their own handler.
  const handleNodeDoubleClick = useCallback((event: ReactMouseEvent, node: Node) => {
    if (node.type === "shape" || node.type === "frame") return;
    if (shouldEnterFocusFromDoubleClick(event.target)) enterFocus(node.id);
  }, [enterFocus]);

  // Cmd/Ctrl+G group · Cmd/Ctrl+Shift+G ungroup. The shared editable-target guard also covers
  // xterm's helper textarea; the key is only swallowed when there is something to do (audit A#6).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "g") return;
      if (isEditableCanvasKeyTarget(event.target)) return;
      if (event.shiftKey) {
        if (!ungroupEligible) return;
        event.preventDefault();
        handleUngroup();
      } else {
        if (!groupEligible) return;
        event.preventDefault();
        handleGroup();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleGroup, handleUngroup, groupEligible, ungroupEligible]);
  // F2 renames the selected Frame (only when exactly one Frame is selected).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F2" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableCanvasKeyTarget(event.target)) return;
      const selectedFrames = selectedNodes.filter((n) => n.type === "frame");
      if (selectedFrames.length !== 1) return;
      event.preventDefault();
      canvasFrameEditStore.request(selectedFrames[0].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedNodes]);
  // Tool-rail keyboard shortcuts (V/R/O/D/T/…) + Escape→select. Never fires while typing.
  // showToolRail gates the DRAWING tools only (plans/nl-type-to-focus §3): the setting used to hide
  // the rail's UI while every shortcut kept firing underneath it, so "r" armed the rectangle tool
  // with nothing on screen to explain why. V/H stay live regardless — the rail is the only click
  // path to a tool, so suppressing them pinned activeTool to "select" and left the canvas unable to
  // pan by left drag at all. resolveToolShortcut owns that distinction. Reading a reactive value
  // here means the effect must re-subscribe when it changes, hence the dependency array.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The decision lives in resolveToolShortcut so it can be tested by behaviour instead of by a
      // regex over this file — it gates ten bare letters, which is too much to verify by inspection.
      // isEditableCanvasKeyTarget is the shared guard (it also covers xterm's helper textarea, which
      // the hand-rolled tagName check here used to miss).
      const tool = resolveToolShortcut(event, {
        showToolRail,
        editableTarget: isEditableCanvasKeyTarget(event.target),
        jumpLabelsOpen: jumpLabelsStore.snapshot() !== null,
      });
      if (tool) setActiveTool(tool);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showToolRail]);
  /**
   * Jump labels (`plans/codecanvas-hotkeys/` S7). Opens badges over every cell; typing one goes there.
   *
   * `jump-labels` has sat in the hotkey registry on `f` since that plan — listed in Settings as a
   * rebindable row, with no handler anywhere. The chord resolved and nothing happened, and because
   * `useCanvasHotkeys` returns before `preventDefault` when a command has no handler, the key was not
   * even swallowed. A settings panel promising a gesture the canvas never performed.
   */
  const openJumpLabels = useCallback(() => {
    if (jumpLabelsStore.snapshot() !== null) {
      // Pressing the chord again puts them away. The chord is remappable, so it cannot be a badge.
      jumpLabelsStore.cancel();
      return;
    }
    // Reading order, tiles only, and ON SCREEN only.
    //
    // A shape is an annotation, not somewhere to jump to. And the alphabet is scarce: labelling every
    // tile meant cells parked off-viewport spent single letters, pushing the ones actually in front of
    // the operator up to two-letter labels for nothing — and putting badges outside the frame for
    // cells nobody could aim at.
    if (!flowInstance || typeof window === "undefined") return;
    const boxes = nodes.filter(isTiledCanvasNode).map((node) => {
      const width = node.width ?? node.measured?.width ?? 0;
      const height = node.height ?? node.measured?.height ?? 0;
      const topLeft = flowInstance.flowToScreenPosition(node.position);
      const bottomRight = flowInstance.flowToScreenPosition({
        x: node.position.x + width,
        y: node.position.y + height,
      });
      return {
        id: node.id,
        box: { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y },
      };
    });
    jumpLabelsStore.open(
      onScreenNodeIds(boxes, { width: window.innerWidth, height: window.innerHeight }),
    );
  }, [flowInstance, nodes]);


  const hoveredIntakeTargetRef = useRef<CanvasIntakeTarget | null>(null);
  const { viewportZoomBounds, initialViewport, handleMoveEnd } = useCanvasViewportPersistence(
    activeProjectId,
    nodes.length,
    flowInstance,
  );
  const viewportMotion = useCanvasViewportMotionSnapshot();
  const { focusCanvasNodes, focusCanvasNode, revealCanvasNodes } = useCanvasFocusCommands({ flowInstance, focusNode, readDock });

  /**
   * Give a detached conversation a node to run on (Session Widget, Slice 05).
   *
   * The node is rebuilt from what the session itself remembers — its runner and the handle its
   * title carries — so attaching does not require the deleted node to still exist anywhere. The
   * session id is written straight onto the new node, which is what makes its first launch a
   * resume rather than a fresh start.
   *
   * **Declared here, below `useCanvasFocusCommands`, and not beside the other session callbacks.**
   * A `useCallback` dependency array is evaluated during render, so listing `focusCanvasNode` above
   * the hook that produces it throws "Cannot access 'focusCanvasNode' before initialization" — a
   * temporal dead zone, not a hoisting-friendly function declaration. Moving the callback up to sit
   * with its siblings would reintroduce it.
   */
  const createNodeForSession = useCallback(
    (session: CanvasSessionRecord): string | null => {
      const handle = session.title.split(" · ")[0]?.trim();
      const nodeId = addAgentNode({
        id: crypto.randomUUID(),
        name: handle && handle.length <= 24 ? handle : "Agent",
        model: "",
        prompt: "",
        appliedSkills: [],
        updatedAt: Date.now(),
      });
      if (!nodeId) return null;
      patchNodeData(nodeId, {
        runner: session.runner,
        ...(session.runnerCommand ? { runnerCommand: session.runnerCommand } : {}),
        ...(session.account ? { account: session.account } : {}),
        cwd: session.cwd,
        ...(session.worktreePath ? { assignedWorktreePath: session.worktreePath } : {}),
        ...(session.providerSessionId ? { resumeSessionId: session.providerSessionId } : {}),
      });
      focusCanvasNode(nodeId);
      return nodeId;
    },
    [addAgentNode, patchNodeData, focusCanvasNode],
  );

  /**
   * One owner for "what happens when a session row is pressed"
   * (`plans/codecanvas-session-refactor/issues/02` and `/03`).
   *
   * The popover, the ⌘K rows and the cycle hotkeys all call `dispatchSession` and nothing else.
   * Refusals arrive as a sentence in the shared canvas notice strip — deliberately an
   * existing channel, not a second toast system — and `needs-you` is asked inside the pressed row of
   * the Sessions list before anything is destroyed.
   */
  const [sessionNotice, setSessionNotice] = useState<SessionNotice | null>(null);
  useEffect(() => { if (closeError) setSessionNotice({ kind: "error", text: closeError }); }, [closeError]);
  const [sessionConfirm, setSessionConfirm] = useState<{
    session: CanvasSessionRecord;
    settle: (go: boolean) => void;
  } | null>(null);
  const adoptSession = useCallback(
    async (session: CanvasSessionRecord): Promise<string | null> => {
      const nodeId = createNodeForSession(session);
      if (!nodeId) return null;
      try {
        await attachSessionToNode(canvasSessionStore, session, nodeId);
      } catch (error) {
        // The node exists and carries the pointer either way; only the row's ownership is unsaved.
        console.warn("[canvas] session not attached:", error);
      }
      return nodeId;
    },
    [createNodeForSession],
  );
  const { dispatch: dispatchSession } = useSessionDispatch({
    projectId: activeProjectId,
    focusNode: focusCanvasNode,
    adoptSession,
    notify: setSessionNotice,
    confirmNeedsYou: useCallback(
      (session: CanvasSessionRecord) =>
        new Promise<boolean>((resolve) =>
          setSessionConfirm({
            session,
            settle: (go) => {
              setSessionConfirm(null);
              resolve(go);
            },
          }),
        ),
      [],
    ),
  });
  dispatchSessionRef.current = dispatchSession;

  // A run requested from the Agents page (which cannot call `addAgentNode` — that is a canvas
  // hook) arrives as a one-shot intent and is consumed here, then focused: starting something
  // invisible is the fastest way to make an operator click twice.
  const { registry: ttsRegistry } = useTtsProviderRegistry();
  // The narrator speaks in the Speak-style persona, same as the callouts and Live Voice. Memoised
  // because this parses a persona file: inline in the render body it re-parsed on every canvas
  // pan, zoom and selection.
  const narrationPersonaBody = useMemo(
    () => loadPersona(personaNameForTone(ttsRegistry?.output?.tone), [bundledPersonaSource()]).body,
    [ttsRegistry?.output?.tone],
  );
  // Live narration (plans/voice-narration-layer). Off by default — with one agent working the
  // router speaks every tool call. Only a pierce (failure, question, new prompt) moves the camera.
  // Reported by the command bar's Live Voice session through context (no module-global flag).
  const liveVoiceStatus = useLiveVoiceStatusState();
  const liveVoiceActive = liveVoiceStatus.active;
  // Live Voice outranks every other voice (Speaker Queue, Lotus #176): what is playing stops at once
  // so it cannot leak into the Live Voice mic; on end, one callout line covers what finished meanwhile.
  useHoldSpeechWhileLive(liveVoiceActive, voice);
  useNarrationChannel({
    enabled: liveNarration,
    liveVoiceActive,
    subscribeAgentHook: subscribeAgentHookEvents,
    announce: voice.announce,
    focusNode: focusCanvasNode,
    complete: nlComplete,
    personaBody: narrationPersonaBody,
    resolveName: (paneId) =>
      agentStatusRegistry.list().find((a) => a.hookPaneId === paneId || a.id === paneId)?.name
      ?? paneId.split(":").pop()
      ?? paneId,
  });
  const collaborationLaunch = useCanvasCollaborationLaunch();
  const collaborationTask = useCanvasCollaborationTask(collaborationLaunch);
  useCanvasCollaborationContext(activeProjectId, collaborationLaunch, collaborationTask.task);
  const { ledger: collaborationLedger, recordSpawn: recordCollaborationSpawn, syncParticipants: syncCollaborationParticipants } = useCanvasCollaborationLedger(activeProjectId, collaborationLaunch);
  const {
    messages: collaborationMailboxMessages,
    appendMessage: appendCollaborationMessage,
    syncTaskFeedback: syncCollaborationTaskFeedback,
    storageStatus: collaborationStorageStatus,
  } = useCanvasCollaborationMailbox(activeProjectId, collaborationLaunch);
  const collaborationParticipants = useMemo(() => projectCanvasCollaborationParticipants({
    task: collaborationTask.task,
    ledger: collaborationLedger,
    mailboxMessages: collaborationMailboxMessages,
    agents: nodes
      .filter((node) => node.type === "agent")
      .map((node) => {
        const data = node.data as { name?: string; role?: string; status?: AgentNodeStatus };
        return { id: node.id, name: data.name ?? "Agent", role: data.role, status: data.status ?? "idle" };
      }),
  }), [collaborationLedger, collaborationMailboxMessages, collaborationTask.task, nodes]);
  useEffect(() => {
    syncCollaborationParticipants(collaborationParticipants);
  }, [collaborationParticipants, syncCollaborationParticipants]);
  useEffect(() => {
    syncCollaborationTaskFeedback(collaborationTask.task);
  }, [collaborationTask.task, syncCollaborationTaskFeedback]);
  // Spawn-first auto-naming uniqueness (ADR-0026 §3.5): the handles already on the canvas.
  const takenAgentNames = useMemo(
    () => nodes.filter((n) => n.type === "agent").map((n) => (n.data as { name?: string }).name).filter((x): x is string => !!x),
    [nodes],
  );

  const { isApplied, listApplied, markApplied, clearApplied, resetTerminal } = useAppliedSkillGuard();

  useCanvasBrowserApiBridge({ nodes, edges, spawnBrowserNode, patchNodeData });
  useDevServerAutoOpen({ nodes, edges, spawnBrowserNode, patchNodeData, enabled: autoOpenBrowserOnDevServer });
  useCanvasBrowserActivityBridge();

  const handleClose = useCallback(
    (nodeId: string, delayMs?: number) => { void removeNode(nodeId, delayMs).then((closed) => { if (closed) resetTerminal(nodeId); }); },
    [removeNode, resetTerminal],
  );

  // Close-all uses the same receipt-bearing cleanup and retains nodes whose shutdown fails.
  const handleCloseAll = useCallback(
    (delayMs?: number) => { for (const n of nodes) resetTerminal(n.id); void removeAllNodes(delayMs); },
    [nodes, removeAllNodes, resetTerminal],
  );

  const hasBrowserNodeCb = useCallback(
    (terminalId: string) =>
      nodes.some(
        (n) => n.type === "browser" &&
          edges.some((e) => e.source === terminalId && e.target === n.id),
      ),
    [nodes, edges],
  );

  const { handleTaskDispatch, handleTeamLaunch, handleSpawnTerminalForWorktree, handlePromoteToTerminal } = useCanvasTaskCommands({
    nodes,
    rootDir,
    activeProjectId,
    agentCounterRef,
    appendDispatch,
    spawnTerminalChild,
    patchNodeData,
    taskDispatch,
    terminalDispatch,
    focusCanvasNodes,
  });

  useCanvasProjectMaintenance({ nodes, rootDir, activeProjectId, patchNodeData });

  // "Arrange the canvas": pack nodes into a desktop-filling grid, then smoothly reframe the camera
  // once they settle — the coordinated CNVS-style transition. Cells are sized to fill the *visible*
  // canvas area (between the left tool rail and the right edge, below the top bar, above the NL bar),
  // and the viewport is set so the grid is centred in that visible area — fitView can't account for
  // the overlay chrome, which left an asymmetric gap on the right.
  const handleArrange = useCallback(() => {
    // A manual arrange is an explicit "re-tile everything" — it overrides focus mode. Exit
    // WITHOUT restoring the snapshot: the arrange about to run owns the final positions.
    if (focusedNodeIdRef.current) exitFocus({ restore: false });
    const pane = typeof document !== "undefined" ? document.querySelector(".react-flow") : null;
    if (!pane || !flowInstance) {
      arrangeNodes();
      return;
    }
    const motion = canvasMotionEnabled();
    const duration = motion ? Math.max(ARRANGE_ANIM_MS, CANVAS_MOTION.reframeMs) : 0;
    // Suspend the per-node backdrop blur while the glide + reframe run (rule in motion.css) —
    // and flush before ReactFlow receives final positions so the move can't collapse to a blink.
    holdCanvasArrangeGlide(duration);
    // Size cells to the visible area in *screen pixels* (a zoom-1 reference), NOT divided by the
    // current zoom — so the result is zoom-independent and always frames at ~100%, keeping terminal
    // content legible no matter how far the user was zoomed out when they ran arrange.
    // Chrome state comes from the Layout settings: a hidden tool rail / docked top pill hands
    // its strip back to the grid instead of leaving a phantom margin.
    const chromeFlags = getCanvasBehaviorSettings();
    const area = measureVisibleCanvasArea(pane.getBoundingClientRect(), {
      showToolRail: chromeFlags.showToolRail,
      topControls: chromeFlags.topControls,
    });
    // An open Run Node's outline and header sit outside its members (#74): keep room for them.
    const margin = runGroupArrangeMargin(flowInstance.getNodes());
    const grid = arrangeNodes(fitInsideRunMargin(area, margin));
    if (!grid || grid.width === 0) return;
    const bounds = boundsWithRunMargin(grid, margin);
    // World-class arrange: move the camera WITH the node glide, not after it. The old delayed
    // reframe made nodes appear to slide in from the right, then the camera caught up. Coordinating
    // both on the same easing curve keeps the board feeling spatial and removes the blink.
    const target = frameBoundsInVisibleArea(bounds, area);
    const current = flowInstance.getViewport();
    void runCanvasViewportMotion(
      { currentZoom: current.zoom, durationMs: duration },
      () => flowInstance.setViewport(target, { duration, ease: canvasEaseOutQuint, interpolate: "smooth" }),
    );
  }, [arrangeNodes, exitFocus, flowInstance]);

  // Frame focus + Active Frame + member re-tile (decisions 35-39) live in one hook: `focusFrame` is the ONE
  // path every "fly to a Frame" goes through (chips, ⌥1–9, Overview, NL "buka X"), and a member added or
  // closed re-tiles its Frame with the camera staying put, never a whole-canvas arrange.
  const focusFrameNodesRef = useRef(nodes);
  focusFrameNodesRef.current = nodes;
  const activeFrameKey = activeFrameCanvasKey(activeProjectId);
  const { focusFrame, activateFrame } = useCanvasFrameFocus({
    flowInstance,
    nodes,
    nodesRef: focusFrameNodesRef,
    canvasKey: activeFrameKey,
    boardReady: !loading,
    focusedNodeIdRef,
    exitFocus,
    arrangeFrameMembers,
    retileFrameMembers,
  });
  const activeFrameId = useActiveFrameId(activeFrameKey);

  // User arrange (NL "arrange", ⌘K, hotkey) with Frames = focus the active Frame (decision 40). The MCP
  // `lotus_arrange_canvas` and the Frame-less auto-tidy keep calling `handleArrange` directly.
  const handleUserArrange = useCallback(() => {
    const decision = decideUserArrange(focusFrameNodesRef.current, canvasActiveFrameStore.get(activeFrameKey));
    if (decision.kind === "focus-frame") focusFrame(decision.frameId);
    else handleArrange();
  }, [activeFrameKey, focusFrame, handleArrange]);

  // Frame Grid (decisions 43-44): Frames snap into equal slots when created, deleted or when the Overview opens.
  const { snapFrameGrid } = useCanvasFrameGrid({
    nodes,
    nodesRef: focusFrameNodesRef,
    canvasKey: activeFrameKey,
    boardReady: !loading,
    applyFrameGrid,
    focusedNodeIdRef,
    flowInstance,
  });

  const liveAgentStatuses = useAgentStatusSnapshots();
  // Frame Overview (LOT2-125): the grid button's job. Zoom out to every Frame, Esc/Enter/click leave.
  const frameOverview = useCanvasFrameOverview({
    flowInstance,
    nodes,
    zoomBounds: viewportZoomBounds,
    canvasKey: activeProjectId,
    statuses: liveAgentStatuses,
    snapFrameGrid,
    activeFrameId: () => canvasActiveFrameStore.get(activeFrameKey) ?? null,
    focusFrame,
  });

  // Auto-tidy (Settings → Canvas): re-tile after a node is created/closed via a command.
  // INTENT-driven (only real mutations, never project loads) and DEBOUNCED so a batch like
  // "open 3 agents" — three create commands — settles into ONE arrange instead of stacking.
  const tidyTimerRef = useRef<number | undefined>(undefined);
  const nodesRefForTidy = useRef(nodes);
  nodesRefForTidy.current = nodes;
  const requestTidy = useCallback(
    (kind: "open" | "close", isNote: boolean) => {
      const flags = getCanvasBehaviorSettings();
      // Focus mode always re-tiles on mutation (rail must stay coherent) — the tidy
      // opt-in flags only gate the grid arrange.
      if (!focusedNodeIdRef.current && !shouldTidyOnMutation(kind, isNote, flags)) return;
      if (tidyTimerRef.current !== undefined) window.clearTimeout(tidyTimerRef.current);
      // Coalesce a rapid batch; arrange is idempotent so an extra fire is harmless. Use the SAME
      // handleArrange the manual "arrange" command uses — it reframes from arrange's self-computed
      // bounds (accurate immediately), NOT fitView's xyflow-measured dims (stale while a freshly
      // spawned agent's terminal is still mounting). With auto-focus suppressed during tidy, nothing
      // competes for the camera, so the manual reframe lands correctly. The debounce is long enough
      // for a PTY batch's xterm mount spike to pass — gliding through it janks the tween to a jump.
      // While focus mode is active, a tidy re-tiles the FOCUS layout instead (newborn nodes join
      // the rail; a closed hero exits back to the snapshot) — never yanks the user out of focus.
      // Decided at fire time, once the mutation has landed: with any Frame on the board the whole-canvas
      // arrange (which also reframes the camera) is never run — that was "closing a node zooms out".
      // Frame members re-tile through useCanvasFrameFocus instead (decision 39).
      tidyTimerRef.current = window.setTimeout(() => {
        const action = decideMutationTidy({
          kind, isNote, flags: getCanvasBehaviorSettings(), nodeFocused: Boolean(focusedNodeIdRef.current), nodes: nodesRefForTidy.current,
        });
        if (action === "refresh-focus") refreshFocus();
        else if (action === "arrange-all") handleArrange();
      }, TIDY_DEBOUNCE_MS);
    },
    [handleArrange, refreshFocus],
  );
  // Also on a canvas switch: a tidy queued on the old canvas must not run on the incoming one.
  useEffect(() => () => { if (tidyTimerRef.current !== undefined) window.clearTimeout(tidyTimerRef.current); }, [activeProjectId]);

  const runCanvasCommandRaw = useCanvasCommandCenter({
    addTerminalNode,
    addNoteNode,
    addPlanNode,
    addTaskNode,
    addContextNode,
    addCriticNode,
    addHumanGateNode,
    addTeamNode,
    addMusicNode,
    addRunNode,
    nodes,
    edges,
    flowInstance,
    addAgentNode,
    addSkillsNode,
    addSkillNode,
    spawnBrowserNode,
    spawnStandaloneBrowserNode,
    closeBrowserNode,
    removeNode: handleClose,
    markNodeLeaving,
    markAllNodesLeaving,
    removeAllNodes: handleCloseAll,
    focusNode: focusCanvasNode,
    focusNodes: focusCanvasNodes,
    revealNodes: revealCanvasNodes,
    enterFocusMode: enterFocus,
    patchNodeData,
    dispatchTask: handleTaskDispatch,
    convertNoteToTask: morphNoteToTask,
    arrangeNodes: handleUserArrange,
    commitAgentDraw,
  });

  // Wrap the command center so every node create/close requests an auto-tidy. This is the single
  // chokepoint for NL-bar, toolbar, and agent-issued node mutations; project load doesn't run here.
  const frameCommandRef = useRef<(command: Extract<CanvasCommand, { kind: "create-frame" | "move-to-frame" | "fly-to-frame" }>) => CanvasCommandResult>(() => ({}));
  const runCanvasCommand = useCallback(
    (command: Parameters<typeof runCanvasCommandRaw>[0]) => {
      // Frame commands from the NL bar / voice (LOT2-129) live with the Frame state further down.
      if (command.kind === "create-frame" || command.kind === "move-to-frame" || command.kind === "fly-to-frame") {
        return frameCommandRef.current(command);
      }
      const result = runCanvasCommandRaw(command);
      if (isCanvasCreateCommand(command)) {
        const isNote = command.kind === "create-note-drop-target" || (command.kind === "create-node" && command.nodeType === "note");
        requestTidy("open", isNote);
      } else if (command.kind === "close-node") {
        const isNote = nodesRefForTidy.current.find((n) => n.id === command.nodeId)?.type === "note";
        requestTidy("close", isNote);
      }
      return result;
    },
    [runCanvasCommandRaw, requestTidy],
  );

  // ── Keyboard navigation between nodes (spatial / cycle / slot) + focus/close ──
  // Whiteboard shapes are skipped: only functional nodes are keyboard-navigable targets.
  const navRects = useMemo<SpatialRect[]>(
    () =>
      nodes
        .filter((n) => n.type !== "shape")
        .map((n) => ({
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          width: n.width ?? n.measured?.width ?? 0,
          height: n.height ?? n.measured?.height ?? 0,
        })),
    [nodes],
  );
  // Reading order (top-to-bottom, then left-to-right) — the same order Arrange lays nodes out in,
  // so slot numbers stay intuitive.
  const navOrderRef = useRef<string[]>([]);
  navOrderRef.current = [...navRects]
    .sort((a, b) => (Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x))
    .map((r) => r.id);
  const navRectsRef = useRef<SpatialRect[]>(navRects);
  navRectsRef.current = navRects;
  // Captured, not merely listened for. While the badges are up they own every plain letter, and the
  // competition is real: ten of them are whiteboard tools and a focused terminal would eat the rest.
  // The capture phase plus `preventDefault` is what makes the mode unambiguous.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (jumpLabelsStore.snapshot() === null) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        jumpLabelsStore.cancel();
        return;
      }
      // One printable character only: Tab, arrows and the rest are not labels and must stay usable.
      if (event.key.length !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      const match = jumpLabelsStore.typeKey(event.key);
      if (match.kind === "hit") runCanvasCommand({ kind: "focus-node", nodeId: match.nodeId });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [runCanvasCommand]);

  const selectedNodeIdRef = useRef<string | null>(null);
  selectedNodeIdRef.current = nodes.find((n) => n.selected)?.id ?? null;

  const focusInDirection = useCallback(
    (direction: SpatialDirection) => {
      const current = selectedNodeIdRef.current;
      const target = current
        ? nearestNodeInDirection(navRectsRef.current, current, direction)
        : (navOrderRef.current[0] ?? null);
      if (target) focusCanvasNode(target);
    },
    [focusCanvasNode],
  );
  const cycleFocus = useCallback(
    (delta: number) => {
      const target = stepInOrder(navOrderRef.current, selectedNodeIdRef.current, delta);
      if (target) focusCanvasNode(target);
    },
    [focusCanvasNode],
  );
  const focusSlot = useCallback(
    (slot: number) => {
      const target = navOrderRef.current[slot - 1];
      if (target) focusCanvasNode(target);
    },
    [focusCanvasNode],
  );

  useCanvasHotkeys({
    "focus-dir-left": () => focusInDirection("left"),
    "focus-dir-right": () => focusInDirection("right"),
    "focus-dir-up": () => focusInDirection("up"),
    "focus-dir-down": () => focusInDirection("down"),
    "cycle-forward": () => cycleFocus(1),
    "cycle-backward": () => cycleFocus(-1),
    "focus-slot-1": () => focusSlot(1),
    "focus-slot-2": () => focusSlot(2),
    "focus-slot-3": () => focusSlot(3),
    "focus-slot-4": () => focusSlot(4),
    "focus-slot-5": () => focusSlot(5),
    "focus-slot-6": () => focusSlot(6),
    "focus-slot-7": () => focusSlot(7),
    "focus-slot-8": () => focusSlot(8),
    "focus-slot-9": () => focusSlot(9),
    "arrange": () => handleUserArrange(),
    "toggle-dock": toggleDock,
    "widen-dock": () => {
      if (dock.open) dock.toggleWide();
    },
    // plans/nl-type-to-focus: "/" and Space put the caret in the NL bar, ready to type — neither
    // key should insert its own character, so both are named commands (not the bar's own keydown
    // handler) and route through the focus registry rather than a ref CanvasPage doesn't have.
    // NOTE: these two command ids are being added to canvas-hotkeys.ts by a concurrent change; until
    // that lands this object literal has two keys TypeScript doesn't yet know (expected, not a bug
    // in this file — see the task report for the coordination note).
    "focus-command-bar": () => commandBarFocusRegistry.focus(),
    "dive-into-node": () => {
      const current = selectedNodeIdRef.current;
      if (!current) return;
      // A selected File Node opens in Code; every other node is dived into.
      const filePath = pathToOpenOnEnter(flowInstance?.getNode(current), document.activeElement);
      if (filePath) {
        openInCode({ path: filePath });
        return;
      }
      const selector =`.react-flow__node[data-id="${cssEscapeId(current)}"]`;
      const root = document.querySelector<HTMLElement>(selector);
      if (root) findNodeFocusTarget(root)?.focus();
    },
    "exit-layer": () => {
      // Escape also clears the fleet briefing, so the reveal can never be left on by accident.
      // Unconditional and idempotent — Escape fires for many reasons and this must not consume it.
      fleetBriefing.dismiss();
      // Escape reaches here only for non-terminal targets (the terminal keeps its own Esc).
      // Blur a focused editable control and pop back to the canvas layer, reselecting its node.
      const active = document.activeElement as HTMLElement | null;
      if (!active || !isEditableCanvasKeyTarget(active) || isTerminalKeyTarget(active)) return;
      active.blur();
      const nodeId = active.closest<HTMLElement>(".react-flow__node")?.getAttribute("data-id");
      if (nodeId) focusNode(nodeId);
    },
    "toggle-focus-mode": () => {
      const current = selectedNodeIdRef.current;
      if (current) enterFocus(current);
    },
    "close-node": () => {
      const current = selectedNodeIdRef.current;
      if (current) runCanvasCommand({ kind: "close-node", nodeId: current });
    },
    // Move between the focused node's own conversations without opening anything
    // (`plans/codecanvas-session-widget/`, Slice 04). Read from the registry at press time — a
    // keystroke is an event, not a view, so there is nothing to subscribe to.
    "session-prev": () => cycleFocusedNodeSession(-1),
    "session-next": () => cycleFocusedNodeSession(1),
    // Walks the needs-you queue, oldest ask first (plans/honest-agent-status/ Slice 5).
    //
    // The queue is read from the registries HERE, at press time, rather than from the live-ticking
    // hook the sidebar lane uses: a keystroke is an event, not a view. Nothing to subscribe to,
    // nothing to keep warm, and no second 5s interval running behind a panel that may be closed.
    //
    // Deriving the next target from the CURRENT selection is what makes repeated presses walk the
    // queue without anyone storing a cursor that could go stale when an ask is answered.
    "fleet-briefing": () => fleetBriefing.toggle(),
    // Was registered on `f` with no handler at all — see `openJumpLabels`.
    "jump-labels": openJumpLabels,
    "frame-go-1": () => goToFrameAt(1), "frame-go-2": () => goToFrameAt(2), "frame-go-3": () => goToFrameAt(3),
    "frame-go-4": () => goToFrameAt(4), "frame-go-5": () => goToFrameAt(5), "frame-go-6": () => goToFrameAt(6),
    "frame-go-7": () => goToFrameAt(7), "frame-go-8": () => goToFrameAt(8), "frame-go-9": () => goToFrameAt(9),
    "frame-move-1": () => moveSelectionToFrameAt(1), "frame-move-2": () => moveSelectionToFrameAt(2), "frame-move-3": () => moveSelectionToFrameAt(3),
    "frame-move-4": () => moveSelectionToFrameAt(4), "frame-move-5": () => moveSelectionToFrameAt(5), "frame-move-6": () => moveSelectionToFrameAt(6),
    "frame-move-7": () => moveSelectionToFrameAt(7), "frame-move-8": () => moveSelectionToFrameAt(8), "frame-move-9": () => moveSelectionToFrameAt(9),
    "jump-needs-you": () => {
      const now = Date.now();
      // One queue (S5): agents, then Factory runs and Automation rows by the same oldest-first key.
      const queue = mergeNeedsYou(
        needsYouQueue(agentStatusRegistry.list(), (paneId) => agentTurnRegistry.get(paneId), now),
        dockAsksRef.current,
        now,
      );
      // A Dock item is never the selection, so the walk remembers it while the Dock still shows it.
      const lastDockJump = lastNeedsYouJumpRef.current;
      const at = lastDockJump && dockOpenRef.current ? lastDockJump : selectedNodeIdRef.current;
      const target = queue.find((entry) => entry.id === nextNeedsYouTarget(queue, at));
      if (!target) return;
      if ((target.source ?? "agent") === "agent") {
        lastNeedsYouJumpRef.current = null;
        focusNode(target.id);
      } else {
        lastNeedsYouJumpRef.current = target.id;
        target.onOpen?.();
      }
    },
  });

  const recordManualCollaborationEvidence = useCallback((input: CanvasCollaborationRecordEvidenceInput) => {
    appendCollaborationMessage({
      assignee: input.assignee,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      kind: "evidence",
      author: "human",
      body: input.summary,
      evidence: {
        ...(input.files ? { files: input.files } : {}),
        ...(input.checks ? { checks: input.checks } : {}),
      },
    });
  }, [appendCollaborationMessage]);

  const markManualCollaborationBlocked = useCallback((input: CanvasCollaborationMarkBlockedInput) => {
    appendCollaborationMessage({
      assignee: input.assignee,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      kind: "blocker",
      author: "human",
      body: input.summary,
      evidence: {
        ...(input.blockers ? { blockers: input.blockers } : {}),
      },
    });
  }, [appendCollaborationMessage]);

  const spawnMissingCollaborationAgents = useCallback(() => {
    const base = centeredSpawnPosition(flowInstance) ?? { x: 0, y: 0 };
    buildMissingAssigneeSpawnSpecs(collaborationParticipants, {
      task: collaborationTask.task,
      projectId: activeProjectId,
      runId: canvasCollaborationRunId(collaborationLaunch),
    }).forEach((spec, index) => {
      const result = runCanvasCommand({
        kind: "create-agent",
        definition: spec.definition,
        brief: spec.brief,
        at: { x: base.x + index * 44, y: base.y + index * 44 },
        options: { teamLabel: activeProject?.alias ?? undefined },
        focus: index === 0,
      });
      if (result.nodeId) {
        recordCollaborationSpawn({ assignee: spec.participant.name, nodeId: result.nodeId, brief: spec.brief });
        appendCollaborationMessage({
          assignee: spec.participant.name,
          nodeId: result.nodeId,
          kind: "handoff",
          author: "director",
          body: spec.brief,
        });
      }
    });
  }, [activeProject?.alias, activeProjectId, appendCollaborationMessage, collaborationLaunch, collaborationParticipants, collaborationTask.task, flowInstance, recordCollaborationSpawn, runCanvasCommand]);

  // The Skills node can apply a skill without a drag (row button, ⏎). That reuses the intake
  // seam — the same path a drop takes — but `intake` is built further down, so the dispatcher
  // reaches it through a ref rather than being re-ordered around it.
  const applySkillRef = useRef<((targetId: string, skill: CanvasSkillPreview) => void) | null>(null);

  /**
   * Is a remembered skill still actually in the target's prompt?
   *
   * The guard only knows what was SENT, so deleting the inserted token left the row marked
   * "applied" for the rest of the session. Read the prompt line instead — a terminal's mirrored
   * input, or a live agent's reconstructed compose buffer — and let the marker follow it.
   *
   * Both sources are best-effort mirrors, so this narrows a MARKER only. Applying is never gated
   * on it: a wrong answer here costs a badge, and the operator can always re-apply.
   */
  // Read through a ref, not the `nodes` array: this callback reaches the Skills node through the
  // flow injector, and a new identity every render would blow that node's memo on every pan.
  const nodesForPromptRef = useRef(nodes);
  nodesForPromptRef.current = nodes;
  const promptLineForNode = useCallback((nodeId: string): string | null => {
    const node = nodesForPromptRef.current.find((n) => n.id === nodeId);
    if (!node) return null;
    if (node.type === "terminal") {
      const paneId = typeof node.data?.runtimePaneId === "string" ? node.data.runtimePaneId : nodeId;
      return getTerminalSessionInput(paneId);
    }
    if (node.type === "agent" && node.data?.executionMode === "live") {
      return paneAskBuffer.peek(activeProjectId ? canvasRuntimePaneId(activeProjectId, nodeId) : nodeId);
    }
    // A headless agent has no prompt to read — its applied set IS the run prompt, so it stands.
    return null;
  }, [activeProjectId]);

  const isSkillAppliedNow = useCallback(
    (nodeId: string, skillName: string) =>
      isSkillStillApplied(isApplied(nodeId, skillName), promptLineForNode(nodeId), skillName),
    [isApplied, promptLineForNode],
  );

  // Agent note writes for the project on screen are applied here, in the open editor (ADR-0047).
  useMcpNotesBridge({
    projectId: activeProjectId,
    nodes,
    edges,
    writeNote: handleNoteChange,
    addNoteNode,
    patchNodeData,
    appendDispatch,
  });

  // The note's "Agent" chip (ADR-0046): a new runner-first agent beside the note, wired note → agent
  // so it reads the note as context. Not briefed — the user decides what to ask it.
  const spawnAgentForNote = useCallback(
    (noteId: string) => {
      const note = nodes.find((node) => node.id === noteId);
      if (!note) return;
      const takenNames = nodes
        .filter((node) => node.type === "agent")
        .map((node) => String((node.data as { name?: string }).name ?? ""));
      const result = runCanvasCommand({
        kind: "create-agent",
        definition: buildSpawnFirstAgentDefinition("claude", takenNames, { pool: currentNamePool() }),
        at: noteAgentSpawnPosition(note),
        options: { teamLabel: activeProject?.alias ?? undefined },
      });
      if (result?.nodeId) appendDispatch([], [noteAgentWire(noteId, result.nodeId)]);
    },
    [nodes, runCanvasCommand, activeProject?.alias, appendDispatch],
  );

  /*
    The Dock's "Create with agent": a claude agent node on this canvas, the request as its first
    message. It has to ask the user for a yes, so the Dock steps aside and the node takes focus.
  */
  const createAutomationWithAgent = useCallback(
    async (prompt: string): Promise<string | null> => {
      const takenNames = nodes
        .filter((node) => node.type === "agent")
        .map((node) => String((node.data as { name?: string }).name ?? ""));
      const result = runCanvasCommand({
        kind: "create-agent",
        definition: buildSpawnFirstAgentDefinition("claude", takenNames, { pool: currentNamePool() }),
        brief: prompt,
        options: { teamLabel: activeProject?.alias ?? undefined },
      });
      if (!result?.nodeId) return result?.error ?? "Lotus could not place an agent on this canvas.";
      closeDock();
      return null;
    },
    [nodes, runCanvasCommand, activeProject?.alias, closeDock],
  );

  // A Fleet row in the Dock flies to its node and hands it the keyboard — no re-layout, unlike the
  // focus rail's promote. Same blur fallback: a button left holding focus swallows every key.
  // A widened Dock covers the whole canvas, so it narrows first: the node lands beside the list,
  // where it can be seen, and the list stays open for the next row.
  const toggleDockWide = dock.toggleWide;
  const focusFromDockFleet = useCallback(
    (nodeId: string, source?: HTMLElement | null) => {
      if (dockStateRef.current.open && dockStateRef.current.wide) {
        toggleDockWide();
        // The camera reads this before React re-renders; it must already see the narrow Dock.
        dockStateRef.current = { ...dockStateRef.current, wide: false };
      }
      focusCanvasNode(nodeId);
      requestAnimationFrame(() => {
        if (focusCanvasNodeInput(nodeId)) return;
        if (source && document.activeElement === source) source.blur();
      });
    },
    [focusCanvasNode, toggleDockWide],
  );

  // The Dock's New page (16e v2) follows the agent it opens instead of stepping aside.
  const automationAgentWatch = useAutomationAgentWatch({
    nodes,
    runCanvasCommand,
    teamLabel: activeProject?.alias ?? undefined,
    focusNode: focusFromDockFleet,
    closeDock,
  });

  // Delegate in the Dock's Tasks opens the agent as a terminal on this canvas (S4b).
  const sharedTrackerBoard = useOptionalSharedTrackerBoard();
  const canvasTaskSpawner = useCanvasTaskSpawner({
    nodes,
    workspaces: sharedTrackerBoard?.workspaceFolders ?? null,
    boardIsRemote: () => getActiveProjectLocation() !== null,
    addLaunchedTerminalNode,
    createFrame,
    revealNode: revealCanvasNodes,
    rootDir,
    boardReady: !loading,
    openProject,
  });
  // Brainstorm live from the Dock's Factory: a terminal in the run's Frame, on the checkout's canvas.
  const factoryBrainstorm = useCanvasFactoryBrainstorm({
    nodes,
    rootDir,
    boardReady: !loading,
    openProject,
    projectFolders: () => projects.map((project) => project.rootDir),
    boardIsRemote: () => getActiveProjectLocation() !== null,
    addFactoryNode: (run) => addFactoryNode(run, centeredSpawnPosition(flowInstance)),
    addLaunchedTerminalNode,
    createFrame,
    revealNode: revealCanvasNodes,
    onStarted: closeDock,
  });
  // ...and what those cells are doing reaches the task rows and their history.
  useCanvasTaskActivities(nodes, sharedTrackerBoard?.publishCanvasActivities);
  // Task nodes linked to a task read it from that board, and Delegate as the Dock does (board 18).
  const canvasTaskLinks = useCanvasTaskLinks({
    nodes,
    shared: sharedTrackerBoard,
    spawner: canvasTaskSpawner,
    rootDir,
    openInDock: dock.showTask,
    patchNodeData,
    unavailable: DOCK_DELEGATE_UNAVAILABLE,
  });
  // ...and ⌘K "From Tasks…" places one of them here as a linked node.
  const sheetTasks = useCanvasSheetTasks({
    nodes,
    shared: sharedTrackerBoard,
    boardWorkspaceId: canvasTaskLinks?.boardWorkspace?.id ?? null,
    addTaskNode: (seed) => addTaskNode(seed, centeredSpawnPosition(flowInstance)),
    revealNode: revealCanvasNodes,
    openInDock: dock.showTask,
  });
  // The terminal on each agent's pane, for a Tasks row's live badge (LOT2-220). Keyed on a
  // signature: `nodes` is a new array on every drag.
  const paneNodeKey = [...canvasPaneNodes(nodes)].map((entry) => entry.join("\u0000")).join("\u0001");
  const paneNodes = useMemo(
    () => new Map(paneNodeKey ? paneNodeKey.split("\u0001").map((entry) => entry.split("\u0000") as [string, string]) : []),
    [paneNodeKey],
  );
  const dockCanvasTasks = useMemo(
    () => ({ nodes: sheetTasks.linkedNodes, panes: paneNodes, reveal: revealCanvasNodes }),
    [sheetTasks.linkedNodes, paneNodes, revealCanvasNodes],
  );

  const dispatchNodeCommand = useCanvasNodeCommandDispatcher({
    closeNode: (nodeId) => runCanvasCommand({ kind: "close-node", nodeId }),
    changeNote: handleNoteChange,
    convertNote: (nodeId, draft) => runCanvasCommand({ kind: "convert-note-to-task", nodeId, draft }),
    patchBrowser: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    patchContext: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    patchCritic: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    patchHumanGate: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    patchMusic: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    patchFile: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    spawnAgentForNote,
    patchNote: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    patchPlan: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    patchRun: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    patchTask: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    patchTeam: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    patchTerminal: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    patchShape: (nodeId, patch) => runCanvasCommand({ kind: "patch-node", nodeId, patch: patch as Record<string, unknown> }),
    recoverTerminal: (nodeId) => runCanvasCommand({ kind: "recover-terminal", nodeId }),
    addAgentSkills: (terminalId, cwd) => runCanvasCommand({ kind: "add-skills", terminalId, cwd }),
    // Rename is a validated node-data patch (persisted via autosave). The header already gated the
    // name (non-empty, valid chars, unique) before dispatching, so this just writes it.
    renameAgent: (agentId, name) => patchNodeData(agentId, { name }),
    promoteAgentToTerminal: handlePromoteToTerminal,
    openSkill: (skillsNodeId, skill) => runCanvasCommand({ kind: "open-skill", skillsNodeId, skill }),
    applySkill: (targetId, skill) => applySkillRef.current?.(targetId, skill),
    reenableSkill: clearApplied,
    addTerminalSkills: (terminalId, cwd) => runCanvasCommand({ kind: "add-skills", terminalId, cwd }),
    spawnTerminalForWorktree: handleSpawnTerminalForWorktree,
    toggleBrowser: (terminalId) => runCanvasCommand({ kind: "toggle-browser", terminalId }),
    dispatchTask: handleTaskDispatch,
    launchTeam: handleTeamLaunch,
    // The header Focus action rides the same command-center path as NL "fokus ke X".
    focusNode: (nodeId) => runCanvasCommand({ kind: "focus-node", nodeId }),
  });

  const getNodeAtPoint = useCallback((point: CanvasIntakeClientPoint) => {
    const nodeId = nodeIdFromElementAtPoint(point);
    return nodeToIntakeTarget(nodes.find((node) => node.id === nodeId));
  }, [nodes]);
  const createCanvasDropTarget = useCallback((payload: CanvasIntakePayload, point: CanvasIntakeClientPoint | null) => {
    if (payload.kind === "none" || payload.kind === "skill") return null;
    const screen = point ? { x: point.clientX, y: point.clientY } : undefined;
    const nodeId = runCanvasCommand({ kind: "create-note-drop-target", screen }).nodeId;
    return nodeId ? { id: nodeId, kind: "note" as const } : null;
  }, [runCanvasCommand]);
  // An image dropped/pasted on empty canvas becomes an Excalidraw-style image shape (bytes persist
  // to the note-asset store; the shape holds the durable URI). Point is null for a clipboard paste.
  const createImageShape = useCallback(async (images: CanvasImageRef[], point: CanvasIntakeClientPoint | null) => {
    if (!activeProjectId) return null;
    const origin = (point && flowInstance
      ? flowInstance.screenToFlowPosition({ x: point.clientX, y: point.clientY })
      : centeredSpawnPosition(flowInstance)) ?? { x: 80, y: 80 };
    const ids = await placeImageShapes(images, origin, {
      persist: (ref) => canvasImageRefToNoteAsset(activeProjectId, ref),
      measure: (uri) => measureNoteAssetImage(uri),
      addShape: (opts) => addImageShapeNode(opts),
    }, { max: 520 });
    return ids[0] ?? null;
  }, [activeProjectId, flowInstance, addImageShapeNode]);
  // Arm the drop-target frame — only terminal/agent nodes light up (not notes/shapes).
  const armDropTarget = useCallback((nodeId: string | null, kind?: string) => {
    canvasDropTargetStore.set(nodeId && (kind === "terminal" || kind === "agent") ? nodeId : null);
  }, []);
  const intake = useCanvasNodeIntake({
    getSelectedNode: () => nodeToIntakeTarget(nodes.find((node) => node.selected)),
    getHoveredNode: () => hoveredIntakeTargetRef.current,
    getNodeAtPoint,
    createCanvasDropTarget,
    createImageShape,
    onHoverTarget: (target) => armDropTarget(target?.id ?? null, target?.kind),
    effects: buildCanvasIntakeEffects({
      getNode: (id) => {
        const node = nodes.find((n) => n.id === id);
        return node ? { type: node.type, content: node.data?.content, runtimePaneId: node.data?.runtimePaneId, executionMode: node.data?.executionMode, runner: node.data?.runner } : null;
      },
      setNoteContent: handleNoteChange,
      writeToPane: writeTerminalSession,
      getPaneInput: getTerminalSessionInput,
      markApplied: (id, skillName) => markApplied(id, skillName),
      // Runner-first skills (ADR-0027 Phase 6a): a dropped skill is INSERTED into the live agent's
      // prompt (no submit) via the reply registry's raw write — user adds context then presses Enter.
      insertIntoAgent: (id, text) => agentReplyRegistry.get(id)?.insert?.(text),
      collectAttachment: (id, images) => canvasAttachmentStore.add(id, images),
      projectId: activeProjectId,
    }),
  });
  const skillDnd = useCanvasSkillDnd({ onSkillDrop: intake.handleSkillDrop });
  applySkillRef.current = (targetId, skill) => {
    const target = nodeToIntakeTarget(nodes.find((node) => node.id === targetId));
    if (target?.kind !== "terminal" && target?.kind !== "agent") return;
    intake.handleSkillDrop(target.kind, targetId, {
      name: skill.name,
      source: skill.source,
      content: skill.content,
      path: skill.path,
    });
    // A skill is INSERTED, not submitted — the user's next keystroke belongs in the target's
    // prompt, not in the Skills node's search box it is currently in. Bring the node on screen
    // and put the caret there. The insert lands asynchronously (the reply registry writes into
    // xterm), so focus after a frame or it is stolen back by the re-render.
    revealCanvasNodes(targetId);
    // Retried once, exactly like promoteFleetRow: the insert lands asynchronously (the reply
    // registry writes into xterm) and a node still refitting is not focusable yet.
    requestAnimationFrame(() => {
      if (focusCanvasNodeInput(targetId)) return;
      requestAnimationFrame(() => focusCanvasNodeInput(targetId));
    });
  };

  // Source 2: dragging an on-canvas image shape onto a terminal/agent. While dragging, arm the
  // node the shape overlaps; on drop, hand that shape's image file to the target's PTY. The shape
  // stays on the canvas (non-destructive) — only the file reference is delivered.
  // One injector for the life of the canvas. It carries the previous injected result so a render
  // storm — a drag fires onNodesChange per pointermove — does not hand every node a fresh `data`
  // object and blow past every node component's memo(). See canvas-flow-config.ts.
  const flowInjector = useMemo(() => createCanvasFlowInjector(), []);

  // Suspend every node's backdrop blur for the length of the gesture (motion.css
  // [data-canvas-dragging]) — the same relief arrange and node-enter already take, for the one
  // motion the user's hand is actually on.

  // Frames: while dragging, light up the Frame the dragged node would join; on drop, commit the
  // membership change and offer Undo. `nodesLatestRef` keeps the handlers stable across the
  // per-pointermove node churn (same reason as the injector above).
  const nodesLatestRef = useRef<Node[]>(nodes);
  nodesLatestRef.current = nodes;

  // Open Run Nodes (#74): the outlines as they were when the drag started are what the drop is
  // judged against — a member's outline would otherwise stretch with it.
  const runGroupsAtDragStart = useRef<ReturnType<typeof runGroupsOf> | null>(null);
  const handleNodeDragStart = useCallback(() => {
    holdCanvasNodeDrag();
    runGroupsAtDragStart.current = runGroupsOf(nodesLatestRef.current);
  }, []);
  const commitRunGroupDrop = useCallback((dropped: Node[]) => {
    const groups = runGroupsAtDragStart.current;
    runGroupsAtDragStart.current = null;
    if (!groups || groups.open.length === 0) return;
    const { changes, notice } = runGroupDrop(
      groups,
      dropped.map((n) => ({ id: n.id, type: n.type, label: runMemberLabel(n), rect: nodeRect(n) })),
      isRunNodeActive,
    );
    for (const change of changes) {
      runCanvasCommand({ kind: "patch-node", nodeId: change.runId, patch: { memberIds: change.memberIds } });
    }
    if (notice) setSessionNotice({ kind: "info", text: notice });
  }, [runCanvasCommand]);
  const {
    frameToast, handleFrameToastUndo, commitFrameDrop,
    frameSwitcher, goToFrame, goToFrameAt, moveSelectionToFrameAt,
    handleCreateFrameAtCentre, handleFrameToolCreate,
    frameActions, frameDeleteTarget, frameDeleteSummary, frameDeleteTitle, cancelFrameDelete,
    confirmDeleteWithContents, deleteFrameOnly,
    showFirstFrameHint, dismissFirstFrameHint,
    frameSuggestion, dismissFrameSuggestion, acceptFrameSuggestion,
    frameSelectionIds,
  } = useCanvasFrameUi({
    nodes, nodesLatestRef, flowInstance, liveAgentStatuses, applyFrameMembership, sendNodesToFrame, createFrame,
    addEmptyFrame, addFrameInBox, renameFrameNode, recolorFrameNode, fitFrameNode, dissolveFrame, deleteFrameAndContents,
    spawnCentreRef, runCanvasCommand, teamLabel: activeProject?.alias ?? undefined, undoHistory, clearHistory, resetTerminal,
    onToolDone: () => setActiveTool("select"), frameCommandRef, focusFrame, activateFrame,
  });
  const handleFrameToolCancel = useCallback(() => setActiveTool("select"), []);

  const handleShapeNodeDrag = useCallback((_evt: unknown, node: Node, dragged?: Node[]) => {
    const changes = membershipChangesForDrop(nodesLatestRef.current, dragged?.length ? dragged : [node]);
    canvasFrameDropStore.set(changes.find((c) => c.to)?.to ?? null);
    if (node.type !== "shape" || (node.data as CanvasShapeNodeData)?.shape !== "image" || !flowInstance) return;
    canvasDropTargetStore.set(pickIntersectingDropTarget(flowInstance.getIntersectingNodes(node)));
  }, [flowInstance]);
  const handleShapeNodeDragStop = useCallback((_evt: unknown, node: Node, dragged?: Node[]) => {
    commitFrameDrop(dragged?.length ? dragged : [node]);
    commitRunGroupDrop(dragged?.length ? dragged : [node]);
    releaseCanvasNodeDrag();
    canvasSnapStore.setGuides([]);
    const targetId = canvasDropTargetStore.get();
    canvasDropTargetStore.set(null);
    const assetUri = (node.data as CanvasShapeNodeData)?.imageAssetUri;
    if (node.type !== "shape" || typeof assetUri !== "string" || !targetId) return;
    const assetId = parseNoteAssetUri(assetUri);
    const target = nodeToIntakeTarget(nodes.find((n) => n.id === targetId));
    if (!assetId || !target) return;
    // Stage the shape's image to a clean, space-free path (~/.lotus/agent-drops/<name>) and hand it
    // to the target's prompt. Failures are surfaced (not swallowed) — e.g. a stale binary missing
    // the staging command needs an app rebuild.
    void codecanvasStageNoteAssetForAgent(assetId)
      .then((path) => intake.deliverImageToNode(target, [{ kind: "path", path }]))
      .catch(() => intake.notify("Couldn't attach the image — rebuild the app if this keeps happening."));
  }, [nodes, intake, commitFrameDrop, commitRunGroupDrop]);

  // The project's human name rides along on every cell, so a remote client never has to
  // infer it from a cwd (ADR-14). `projectDisplayName` is the same function the project
  // menu uses — one answer to "what is this called", not two.
  // The SCOPED pane id (canvasRuntimePaneId), never the bare node id: Rust's turn store is keyed
  // by what the hook actually exported as LOTUS_PANE_ID, and asking with a node id returns silence
  // rather than an error. Agent-bearing node types only — a note has no turn.
  const agentTurnPaneIds = useMemo(
    () =>
      nodes
        .filter((node) => node.type === "agent" || node.type === "critic")
        .map((node) => canvasRuntimePaneId(activeProjectId, node.id)),
    [nodes, activeProjectId],
  );
  // The way home for a remote project, held open for as long as that project is the active one
  // (`plans/codecanvas-vps-connector/issues/07`). A local project has none and needs none.
  const machineLocation = useMemo(() => machineFromLocation(activeProject?.location), [activeProject?.location]);
  const machineTunnel = useMachineTunnel(machineLocation);
  const machineStatus: CanvasMachineStatusProps | null = machineLocation
    ? {
        label: machineLocation.label ?? machineLocation.host,
        host: machineLocation.host,
        tunnel: machineTunnel.status,
        hooks: machineTunnel.hooks,
        disconnected: machineTunnel.disconnected,
        onRetry: machineTunnel.refresh,
        onRecheck: () => machineRecheck(wireTarget(machineLocation)),
        onDisconnect: machineTunnel.disconnect,
      }
    : null;

  useCanvasFleetPush({
    projectId: activeProjectId,
    cwd: rootDir,
    nodes,
    projectName: activeProject ? projectDisplayName(activeProject) : null,
    // Agents outlive the board that drew them (a project switch unmounts the board, not the
    // PTYs), so a push can carry an agent whose project is not the one on screen. This is how
    // it still gets its OWN name and directory instead of inheriting the board's.
    projects: fleetProjectCatalog,
  });
  // Hook turn facts for every agent on the board — the honest source of idle / working / needs-you
  // (`plans/honest-agent-status/`). Mounted once here rather than per node: one cold hydrate and
  // one subscription feed the registry, and each node reads from it via useAgentTurnFact.
  //
  // Deliberately NOT inside the narration stack, which is gated by the voice profile. A status
  // badge must never depend on whether the user has narration switched on.
  useAgentTurnFacts(agentTurnPaneIds);
  // Per-agent facts a headline is made of (plans/agent-headlines/). Its own subscription to the raw
  // drop stream, deliberately NOT the narration channel's — that one is gated by the voice profile,
  // and a card title must not depend on whether narration is switched on.
  useAgentHeadlineFeed();
  // ADR-0030: route MCP agent→agent dispatch (canvas: targets) to the canvas message bus.
  useMcpCanvasDispatchBridge(nodes);
  useMcpCanvasCollaborationBridge({
    launch: collaborationLaunch,
    participants: collaborationParticipants,
    task: collaborationTask.task,
    mailboxMessages: collaborationMailboxMessages,
    appendMessage: appendCollaborationMessage,
  });
  // Agent canvas-control (lotus_focus_cell / lotus_arrange_canvas) — gated by the
  // "Let agents move the canvas & focus" toggle (Settings → Canvas), off by default.
  useMcpCanvasControlBridge({ nodes, focusNode: focusCanvasNode, arrangeNodes: handleArrange });
  // Agent canvas-draw (lotus_canvas_draw / lotus_canvas_draw_diagram) — gated by the
  // "Let agents draw & generate diagrams" toggle (Settings → Canvas), off by default.
  useMcpCanvasDrawBridge({
    resolveAnchor: (payload) => {
      const near = payload.anchor && typeof payload.anchor === "object" ? payload.anchor.near : undefined;
      if (near && flowInstance) {
        const node = flowInstance.getNode(near);
        if (node) return { x: Math.round(node.position.x + (node.width ?? 220) + 64), y: Math.round(node.position.y) };
      }
      if (flowInstance && typeof window !== "undefined") {
        return flowInstance.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight * 0.4 });
      }
      return { x: 0, y: 0 };
    },
    existingShapeIds: () => new Set(nodes.filter((n) => n.type === "shape").map((n) => n.id)),
    measure: measureDiagramLabel,
    commit: (application) => commitAgentDraw(application),
    board: () => ({ nodes, edges }),
    readScene: () => {
      let viewport: { x: number; y: number; w: number; h: number } | undefined;
      if (flowInstance && typeof window !== "undefined") {
        const tl = flowInstance.screenToFlowPosition({ x: 0, y: 0 });
        const br = flowInstance.screenToFlowPosition({ x: window.innerWidth, y: window.innerHeight });
        viewport = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
      }
      return buildSceneReadback(nodes, edges, viewport ? { viewport } : {});
    },
  });
  // Phase 2b: the Agent Orchestrator's `lotus_spawn_cell` spawns an auto-named agent NODE on the canvas
  // (native runner, or a custom runner named via runnerId — e.g. "Wesley"), reusing the same create path.
  /**
   * Ends a canvas agent asked for from outside — the MCP `lotus_close_cell` tool, and
   * since 2026-08-09 the phone, which reaches the same event through
   * `POST /api/fleet/close`.
   *
   * **Mounted here as well as in CodeSpace, and that gap was a real one.** The bridge
   * lived only on the CodeSpace route, so a request that arrived while the window sat
   * on the canvas went unanswered until Rust timed out — the operator got a truthful
   * 503 about a window not being on a workspace while looking straight at the agent
   * they had asked to close.
   *
   * Fleet pane ids from the canvas are `canvas:<projectId>:<nodeId>`, so the node id is
   * decoded rather than assumed, and a pane that belongs to some other surface answers
   * `false` — which the bridge turns into a named error instead of a silent no-op.
   */
  const handleMcpCloseNode = useCallback(
    (paneId: string) => {
      const nodeId = nodeIdFromPaneId(paneId);
      if (!nodeId || !nodes.some((n) => n.id === nodeId)) return false;
      handleClose(nodeId);
      return true;
    },
    [nodes, handleClose],
  );
  useMcpCloseBridge(handleMcpCloseNode);

  useMcpCanvasSpawnBridge({
    spawnAgent: (spec, opts) => {
      const taken = nodes
        .filter((n) => n.type === "agent")
        .map((n) => (typeof n.data?.name === "string" ? n.data.name : ""))
        .filter(Boolean);
      const def = buildSpawnFirstAgentDefinition(spec.runner, taken, {
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        pool: currentNamePool(),
      });
      // Through `runCanvasCommand`, not `addAgentNode` directly.
      //
      // That wrapper calls itself "the single chokepoint for NL-bar, toolbar, and
      // agent-issued node mutations", and it was — until this bridge reached past it to the
      // function the command center calls internally. Everything the wrapper adds was lost
      // for a remote spawn, silently and all at once: the auto-tidy (Settings → Canvas is
      // read in `requestTidy`, so the switch looked enabled and did nothing), the centred
      // spawn position, and the auto-focus.
      //
      // `brief` rather than an `initialTask` option, because that is the command's own word
      // for it — the command center maps it back (ADR-0030: peer-messaging goes in the
      // system prompt, so a briefed spawn stays a clean task).
      const result = runCanvasCommand({
        kind: "create-agent",
        definition: def,
        ...(opts.initialTask ? { brief: opts.initialTask } : {}),
        ...(opts.frameId || opts.spawnTask || opts.account
          ? { options: { ...(opts.frameId ? { frameId: opts.frameId } : {}), ...(opts.spawnTask ? { spawnTask: opts.spawnTask } : {}), ...(opts.account ? { account: opts.account } : {}) } }
          : {}),
      });
      return result?.nodeId ?? null;
    },
    resolveFrame: (ref) => resolveAgentFrameRef(nodes, ref),
    nodes,
    createFrame,
    // A remote spawn names the project it means, and until now this bridge ignored it and
    // used whatever board was mounted — so a phone that had switched to another project
    // still got its agent here. These four let the request decide instead.
    activeProjectId,
    knownProjectIds: projects.map((p) => p.id),
    switchToProject: (projectId: string) => void selectProject(projectId),
    // `loading` is the board mid-swap. Spawning then puts the node on a board that is
    // about to be replaced, which looks exactly like the bug being fixed.
    boardReady: !loading,
  });
  // Dispatch never reaches this process — Rust writes straight to the pane's PTY — so a
  // prompt sent from the phone to an agent in another project used to land correctly while
  // the desktop kept showing the wrong board. Rust emits `mcp://follow-pane` for the remote
  // operator's route only; agent-to-agent traffic is deliberately not followed.
  useCanvasFollowPaneBridge({
    activeProjectId,
    knownProjectIds: projects.map((p) => p.id),
    switchToProject: (projectId: string) => void selectProject(projectId),
  });
  // Artisan Theme Engine — the single source for canvas styling: the --ct-* surface/
  // palette/material layer, the backdrop pattern (below), and wallpaper (paper.media).
  // The legacy Background tab/system is retired from the canvas; the terminal-backdrop
  // feature keeps its own hook independently.
  const { theme: canvasTheme, effectiveTextSize } = useCanvasTheme();
  // Dot/line backdrop derived from the active theme's paper.pattern (Style owns it).
  const bgTheme = useMemo<CanvasBackgroundPattern | null>(() => {
    const pattern = canvasTheme.paper.pattern ?? "dots";
    if (pattern === "none") return null;
    return {
      variant: pattern === "lines" ? BackgroundVariant.Lines : BackgroundVariant.Dots,
      gap: 24,
      size: pattern === "lines" ? 0.5 : 1,
      color: canvasTheme.surface.border,
    };
  }, [canvasTheme]);
  const { open: settingsOpen, openSettings } = useLotusSettings();
  const [canvasesOpen, setCanvasesOpen] = useState(false);

  const handleCanvasKeyDownCapture = useCanvasKeyboardControls();
  const handleConnectStart = useCallback(() => setConnectingWire(true), []);
  const handleConnectEnd = useCallback(() => setConnectingWire(false), []);
  const { nodeCountsByProject, showEmptyState, showRestoringState, handleCloseProject, handleCopyProjectPath } = useCanvasProjectSidebarActions({
    projects, activeProjectId, activeProject, loading, booted, showPicker, nodes, edges, closeProject,
  });
  const canvasSuspended = showEmptyState || showRestoringState;

  // Resolve $HOME once so the empty-state history can show tildified paths ("~/workspace/…").
  const [homeDir, setHomeDir] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    getHomedir().then((home) => { if (alive) setHomeDir(home ?? null); }).catch(() => { /* no home default */ });
    return () => { alive = false; };
  }, []);
  // Most-recent projects for one-click resume from the "No project open" portal.
  const recentProjects = useMemo(
    () => buildRecentProjects(projects, { home: homeDir, excludeId: activeProjectId, limit: 3 }),
    [projects, homeDir, activeProjectId],
  );

  const shellStyle = useMemo(() => ({
    ...toCanvasThemeStyle(canvasTheme),
    // Effective node text size (user override ?? theme default ?? md) layered on
    // top of whatever the theme emitted — the orthogonal axis wins.
    "--ct-canvas-node-text-size": TEXT_SIZE_REM[effectiveTextSize],
  } as CSSProperties), [canvasTheme, effectiveTextSize]);

  // Lotus Settings lives in the app shell, outside this shell, so it is handed the Canvas Style to
  // look the way it always did over the canvas — and told the canvas is the mode on screen.
  const settingsHost = useMemo<LotusSettingsHost>(() => ({
    mode: "canvas",
    themeStyle: shellStyle,
    themeAttributes: { "data-canvas-theme": canvasTheme.id, "data-canvas-material": canvasTheme.material, "data-canvas-mode": canvasTheme.mode },
  }), [shellStyle, canvasTheme]);
  useLotusSettingsHost(settingsHost);
  // Park every Canvas Browser Node's native WebView while settings is open over the canvas — it would
  // otherwise paint above the modal (native child webviews ignore DOM stacking).
  useCanvasOcclusionLock(settingsOpen, "lotus-settings-modal");

  // Where the project/canvas controls live. The user preference can dock them into the command
  // bar, but the empty state (no command bar without a project) forces the top pill back so
  // nothing becomes unreachable.
  const topControlsMode = resolveTopControlsMode({
    pref: topControls,
    emptyState: showEmptyState,
  });
  const dockTopControls = topControlsMode === "command-bar";
  // Command-bar layout: the corner's zoom/memory/sessions draw into the docked bar (one control
  // island instead of a second panel in the same corner). Elements, not refs: a portal needs to
  // re-render when its target mounts, and the ⋯ menu's slot mounts only while that menu is open.
  const [cornerBarSlot, setCornerBarSlot] = useState<HTMLElement | null>(null);
  const [cornerMenuSlot, setCornerMenuSlot] = useState<HTMLElement | null>(null);
  const canvasProjectTransition = loading && booted ? "fast" : undefined;
  // Frame chips for the shared control cluster: the command bar and the Top Bar render the same props.
  const frameSwitcherProps = {
    chips: frameSwitcher.chips,
    overflow: frameSwitcher.overflow,
    onGoToFrame: goToFrame,
    onCreateFrame: handleCreateFrameAtCentre,
    activeFrameId: resolveActiveFrameId(nodes, activeFrameId),
  };

  // The NL/voice app-effect channel: switch project, open Settings/Canvases, start/close a project.
  // Built once here so it reaches CanvasNlCommandBar's `appNav` (always wired) and `docked` (only when
  // the top controls are docked into the bar) from the same source — see recommendation to decouple
  // the app-effect channel from the docked *layout* preference.
  const canvasAppNav = useMemo(
    () => ({
      projects,
      activeProjectId,
      onSelectProject: (projectId: string) => void selectProject(projectId),
      onOpenCanvases: () => setCanvasesOpen(true),
      onOpenSettings: () => openSettings(),
      onStopAllSpeech: voice.stopAll,
      onNewProject: () => setAddProjectOpen(true),
      onCloseProject: (projectId?: string) => { const id = projectId ?? activeProjectId; if (id) void closeProject(id); },
      // Adoption, not spawning: the cell keeps running where it is, and the node comes to it.
      //
      // Which node depends on whether the cell has a terminal at all — ticket 12's one branch.
      // A `tui` cell runs under tmux and an adopted Terminal attaches to it over ssh; a headless
      // one is run in memory by the host and has no bytes to attach to, so it is drawn as the
      // conversation it actually is. Guessing wrong in the second direction is what ticket 11
      // shipped: an empty xterm beside a working agent.
      onAdoptHostCell: (cell: RemoteHostCell) => {
        const at = centeredSpawnPosition(flowInstance);
        const label = cellLabel(cell);
        if (adoptionShapeFor(cell) === "chat") {
          addHostCellNode({ paneId: cell.paneId, cwd: cell.cwd, label, provider: cell.provider }, at);
          return;
        }
        addAdoptedCellNode({ paneId: cell.paneId, cwd: cell.cwd, label }, at);
      },
      onAddFactoryRun: (run: { repo: string; issue: number | string; title: string }) => {
        addFactoryNode({ repo: run.repo, issue: run.issue, title: run.title }, centeredSpawnPosition(flowInstance));
      },
      onOpenFile: (path: string) => {
        const id = addFileNode(path, centeredSpawnPosition(flowInstance));
        focusCanvasNode(id);
      },
      loadProjectFiles: indexProjectFiles,
      rootDir,
      onOpenFactoryRun: (run: { repo: string; issue: number | string }) => showFactoryRun(run.repo, run.issue),
      onNewFactoryRun: showFactoryNewRun,
      onToggleDock: toggleDock,
      onOpenAutomation: openAutomation,
      onOpenFleet: openFleet,
      trackerTasks: sheetTasks.trackerTasks,
      onPlaceTask: sheetTasks.placeTask,
      dockOpen,
      dockWaiting: dock.waiting,
      dockChord: dockChords.toggle,
      onToggleFrameOverview: frameOverview.toggle,
      frameOverviewOpen: frameOverview.active,
    }),
    [projects, activeProjectId, selectProject, closeProject, openSettings, voice.stopAll, toggleDock, openAutomation, openFleet, dockOpen, dock.waiting, dockChords.toggle, frameOverview.toggle, frameOverview.active, addAdoptedCellNode, addHostCellNode, addFactoryNode, addFileNode, focusCanvasNode, rootDir, showFactoryRun, showFactoryNewRun, flowInstance, sheetTasks.trackerTasks, sheetTasks.placeTask],
  );

  // The return path from Code (Dock) to the board, and the agent link (plans/canvas-code, S4).
  const fileBoardLinks = createFileBoardLinks({
    addFileNode: (path) => addFileNode(path, centeredSpawnPosition(flowInstance)),
    nodes: () => nodes,
    edges: () => edges,
    appendEdges: (added) => appendDispatch([], added),
    closeDock: dock.close,
    reveal: revealCanvasNodes,
  });
  // "Send to thread" from Code: the focused agent first, then the selected one, then whoever
  // changed state last. Typed into the agent's composer, never submitted.
  const sendSelectionToBoardAgent = (text: string) => {
    const roster = [...agentStatusRegistry.list()].sort((a, b) => (b.statusChangedAt ?? 0) - (a.statusChangedAt ?? 0)).map((a) => a.id);
    const candidates = [focusedNodeId, nodes.find((n) => n.selected)?.id, ...roster].filter((id, i, all): id is string => !!id && all.indexOf(id) === i);
    return routeSelectionToCanvasAgent({ text, candidates, insertInto: (id, value) => { const insert = agentReplyRegistry.get(id)?.insert; if (!insert) return false; insert(value); return true; } });
  };

  return (
    <LiveVoiceStatusProvider value={liveVoiceStatus.value}>
    <div className="codecanvas-shell" data-canvas-theme={canvasTheme.id} data-canvas-material={canvasTheme.material} data-canvas-mode={canvasTheme.mode} data-canvas-motion={canvasAnimations ? "on" : "off"} data-canvas-viewport-motion={viewportMotion.active ? "active" : undefined} data-canvas-project-transition={canvasProjectTransition} style={shellStyle}>
      {dockTopControls ? (
        // Command-bar mode: no top pill, so keep a slim click-through drag strip along the top
        // edge (the pill carried data-tauri-drag-region). It's pointer-transparent to canvas
        // gestures below it — only the OS window-drag consumes it.
        <div className="canvas-drag-strip" data-tauri-drag-region aria-hidden />
      ) : (
        <CanvasTopBar projectName={activeProject?.alias || rootDir} onOpenSettings={() => openSettings({ from: "canvas-gear" })}
          machine={machineStatus}
          onOpenCanvases={() => setCanvasesOpen(true)}
          projects={projects}
          activeProjectId={activeProjectId}
          onSelectProject={(projectId) => void selectProject(projectId)}
          onNewProject={() => setAddProjectOpen(true)}
          onCloseProject={() => { if (activeProjectId) void closeProject(activeProjectId); }}
          onAddAgent={(def, options) => runCanvasCommand({ kind: "create-agent", definition: def, at: centeredSpawnPosition(flowInstance), options: { isolate: options?.isolate, teamLabel: activeProject?.alias ?? undefined } })}
          takenAgentNames={takenAgentNames}
          projectRestoring={showRestoringState}
          frameSwitcher={frameSwitcherProps}
          dock={{ onToggleDock: toggleDock, dockOpen: dock.open, dockWaiting: dock.waiting, dockChord: dockChords.toggle }}
          onToggleFrameOverview={frameOverview.toggle}
          frameOverviewOpen={frameOverview.active}
 />
      )}
      {/* ⌘K used to render a centred modal here. It is now a sheet inside CanvasNlCommandBar —
          one input, one catalog, and the shortcut no longer strips the user's half-typed words away
          from the bar. See useCanvasCommandSheet. */}
      <CanvasesModal
        open={canvasesOpen}
        projects={projects}
        activeProjectId={activeProjectId}
        nodeCountsByProject={nodeCountsByProject}
        onOpen={(projectId) => { void selectProject(projectId); setCanvasesOpen(false); }}
        onCreate={() => { setCanvasesOpen(false); void handleNewProjectViaDialog(); }}
        onClose={() => setCanvasesOpen(false)}
        onRenameProject={(projectId, alias) => void renameProject(projectId, alias)}
        onCopyProjectPath={handleCopyProjectPath}
        onCloseProject={handleCloseProject}
      />

      <div className="canvas-layout">
        {/* Left workspace sidebar removed for a cleaner CNVS-style full-bleed canvas.
            Workspace switching/creation lives in the Canvases modal (⊞ in the top bar)
            and the ⌘K command palette. */}
        <div
          className="canvas-center"
          data-canvas-theme={canvasTheme.id}
          data-canvas-material={canvasTheme.material}
          data-canvas-mode={canvasTheme.mode}
          data-canvas-paper-media={canvasTheme.paper.media ? "true" : undefined}
          data-connecting={connectingWire ? "true" : undefined}
          onKeyDownCapture={handleCanvasKeyDownCapture}
        >
          {canvasTheme.paper.media && <CanvasPaperMedia media={canvasTheme.paper.media} />}
          {showRestoringState ? (
            <CanvasProjectRestoringState />
          ) : showEmptyState ? (
            <CanvasProjectEmptyState
              onOpen={() => { void handleNewProjectViaDialog(); }}
              recents={recentProjects}
              onSelectRecent={(projectId) => void selectProject(projectId)}
            />
          ) : (
          <CanvasGraphRunProvider
            nodes={nodes}
            edges={edges}
            projectId={activeProjectId}
          >
          <DndContext
            sensors={skillDnd.sensors}
            collisionDetection={skillDnd.collisionDetection}
            onDragStart={skillDnd.onDragStart}
            onDragEnd={skillDnd.onDragEnd}
            onDragCancel={skillDnd.onDragCancel}
          >
            <FrameActionsContext.Provider value={frameActions}>
            <CanvasTaskLinksContext.Provider value={canvasTaskLinks}>
            <ReactFlow
              nodes={flowInjector.nodes(applySelectionElevation(nodes, true), edges, {
                dispatchNodeCommand,
                activeProjectId,
                isSkillApplied: isSkillAppliedNow,
                listAppliedSkills: listApplied,
                hasBrowserNode: hasBrowserNodeCb,
                persistAgentSession,
                switchAgentSession,
                switchAgentAccount,
              })}
              edges={flowInjector.edges(edges, { onDelete: removeEdge, onLabelChange: updateEdgeLabel })}
              nodeTypes={CANVAS_NODE_TYPES}
              edgeTypes={CANVAS_EDGE_TYPES}
              onNodesChange={onNodesChange}
              onBeforeDelete={onBeforeDelete}
              onEdgesChange={onEdgesChange}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onConnectStart={handleConnectStart}
              onConnectEnd={handleConnectEnd}
              onReconnect={onReconnect}
              onReconnectStart={handleConnectStart}
              onReconnectEnd={handleConnectEnd}
              onNodeDragStart={handleNodeDragStart}
              onNodeDrag={handleShapeNodeDrag}
              onNodeDragStop={handleShapeNodeDragStop}
              onNodeMouseEnter={(_, node) => { hoveredIntakeTargetRef.current = nodeToIntakeTarget(node); }}
              onNodeMouseLeave={(_, node) => {
                if (hoveredIntakeTargetRef.current?.id === node.id) hoveredIntakeTargetRef.current = null;
              }}
              onDragOver={intake.handleCanvasDragOver}
              onDrop={intake.handleCanvasDrop}
              onMove={(_evt, viewport) => { canvasSnapStore.config.zoom = viewport.zoom; }}
              onMoveEnd={handleMoveEnd}
              onInit={setFlowInstance}
              connectionMode={ConnectionMode.Loose}
              connectionLineComponent={CanvasConnectionLine}
              connectionRadius={32}
              reconnectRadius={18}
              connectionDragThreshold={4}
              autoPanOnConnect
              autoPanSpeed={12}
              edgesReconnectable
              selectionMode={SelectionMode.Partial}
              // Paint order is governed purely by node array position (see reorderNodes). The
              // default elevateNodesOnSelect=true bumps EVERY selected node's z-index, which masks
              // array-order Arrange ("send to back" looked broken while a shape stays selected) and
              // sinks text drawn over a shape the moment that shape is clicked. Always false here;
              // applySelectionElevation (always on), which elevates
              // only windowed (non-shape) nodes.
              elevateNodesOnSelect={false}
              panOnDrag={panOnDrag}
              selectionOnDrag={selectionOnDrag}
              defaultViewport={initialViewport}
              minZoom={viewportZoomBounds.minZoom}
              maxZoom={viewportZoomBounds.maxZoom}
              ariaLabelConfig={{
                "node.a11yDescription.default": "CodeCanvas node. Press Enter to select, Delete to remove, or drag handles to connect.",
                "edge.a11yDescription.default": "CodeCanvas wire. Select it to reveal the delete action or drag endpoints to reconnect.",
                "controls.ariaLabel": "Canvas viewport controls",
                "controls.zoomIn.ariaLabel": "Zoom in canvas",
                "controls.zoomOut.ariaLabel": "Zoom out canvas",
                "controls.fitView.ariaLabel": "Fit canvas nodes",
                "handle.ariaLabel": "Canvas node connection port",
              }}
              deleteKeyCode={["Delete", "Backspace"]}
              proOptions={{ hideAttribution: true }}
            >
              {bgTheme && <CanvasAdaptiveBackground theme={bgTheme} />}
              <CanvasSnapGuides />
              <CanvasJumpLabels nodes={canvasSuspended ? [] : nodes} />
              <CanvasLodViewportMarker />
              <CanvasFrameChromeMarker />
              {activeTool === "select" ? <CanvasFrameSelectionToolbar nodeIds={frameSelectionIds} onCreateFrame={handleGroup} /> : null}
              {frameOverview.active ? (
                <CanvasFrameOverviewLayer nodes={nodes} onFocus={frameOverview.focus} onFlyIn={frameOverview.flyIn} onSwap={frameOverview.swap} onExit={frameOverview.exit} />
              ) : null}
              <CanvasCornerControls
                bounds={viewportZoomBounds}
                nodeCount={nodes.length}
                projectId={activeProjectId}
                agentNames={agentNamesByNodeId}
                onFocusNode={focusCanvasNode}
                onDispatchSession={dispatchSession}
                sessionConfirm={sessionConfirm}
                docked={dockTopControls ? { bar: cornerBarSlot, menu: cornerMenuSlot } : undefined}
              />
            </ReactFlow>
            </CanvasTaskLinksContext.Provider>
            </FrameActionsContext.Provider>
            {activeTool === "frame" && flowInstance ? (
              <CanvasFrameDrawCapture flowInstance={flowInstance} onCreate={handleFrameToolCreate} onCancel={handleFrameToolCancel} />
            ) : null}
            {showFirstFrameHint ? <CanvasFrameHint onDismiss={dismissFirstFrameHint} /> : null}
            {frameSuggestion ? (
              <CanvasFrameSuggestion suggestion={frameSuggestion} onAccept={acceptFrameSuggestion} onDismiss={() => dismissFrameSuggestion(frameSuggestion.key)} />
            ) : null}
            {frameDeleteTarget && frameDeleteSummary ? (
              <CanvasFrameDeleteDialog
                frameTitle={frameDeleteTitle}
                summary={frameDeleteSummary}
                onCancel={cancelFrameDelete}
                onDeleteFrameOnly={deleteFrameOnly}
                onDeleteAll={confirmDeleteWithContents}
              />
            ) : null}
            {activeShapeTool && flowInstance ? (
              <CanvasDrawCapture shape={activeShapeTool} flowInstance={flowInstance} onCreate={handleCreateShape} />
            ) : null}
            {activeTool === "eraser" && flowInstance ? (
              <CanvasEraseCapture
                nodes={nodes.filter((n) => n.type === "shape").map((n) => ({
                  id: n.id,
                  position: n.position,
                  width: n.width ?? undefined,
                  height: n.height ?? undefined,
                  // Linear shapes get stroke-based hit testing instead of their (mostly empty) bbox.
                  shape: (n.data as CanvasShapeNodeData).shape,
                  points: (n.data as CanvasShapeNodeData).points,
                }))}
                flowInstance={flowInstance}
                onErase={removeNode}
              />
            ) : null}
            {showToolRail ? <CanvasToolRail activeTool={activeTool} onSelectTool={setActiveTool} /> : null}
            <AgentDraftPill onApply={applyDraftBatch} onDiscard={discardDraftBatch} />
            {primaryShape ? (
              <InspectorPanel
                shape={(primaryShape.data as CanvasShapeNodeData).shape}
                text={multiSelect ? undefined : (primaryShape.data as CanvasShapeNodeData).text}
                areaLabel={multiSelect ? undefined : (primaryShape.data as CanvasShapeNodeData).areaLabel}
                style={multiSelect ? selectionShared : (primaryShape.data as CanvasShapeNodeData).style}
                sections={multiSelect ? selectionSections(selectedShapes.map((n) => (n.data as CanvasShapeNodeData).shape)) : undefined}
                mixed={multiSelect ? selectionMixed : undefined}
                onPatch={handleShapePatch}
                onArrange={handleShapeArrange}
                canGroup={groupEligible}
                canUngroup={ungroupEligible}
                onGroup={handleGroup}
                onUngroup={handleUngroup}
              />
            ) : null}
            <CanvasNlCommandBar
              runCommand={runCanvasCommand}
              nodes={nodes}
              edges={edges}
              cwd={rootDir}
              speak={voice.speak}
              stopSpeaking={voice.stop}
              onCommandDelivery={commandDelivery.enqueue}
              // The app-effect channel (switch project / open a page / new / close project) is
              // always wired, independent of the docked-layout preference below — so switch_project
              // etc. resolve for typed NL AND voice regardless of where the top controls live.
              appNav={canvasAppNav}
              onDispatchSession={dispatchSession}
              frameSwitcher={frameSwitcherProps}
              machine={machineStatus}
              docked={dockTopControls ? { ...canvasAppNav, fallbackName: activeProject?.alias || rootDir } : undefined}
              cornerSlots={dockTopControls ? { bar: setCornerBarSlot, menu: setCornerMenuSlot } : undefined}
            />
            <CanvasDock
              dock={dock}
              onCreateWithAgent={createAutomationWithAgent}
              agentWatch={automationAgentWatch}
              taskSpawner={canvasTaskSpawner}
              factoryBrainstorm={factoryBrainstorm}
              boardFolder={rootDir}
              canvasTasks={dockCanvasTasks}
              fleet={{
                nodes: canvasSuspended ? [] : nodes,
                heroId: focusedNodeId ?? nodes.find((node) => node.selected)?.id ?? null,
                onFocusNode: focusFromDockFleet,
                onCloseNode: (nodeId) => runCanvasCommand({ kind: "close-node", nodeId }),
                onRenameNode: (nodeId, label) => dispatchNodeCommand({ kind: "patch-terminal", nodeId, patch: { label } }),
                onAddTerminal: () => runCanvasCommand({ kind: "create-node", nodeType: "terminal" }),
              }}
              onShowFileOnBoard={fileBoardLinks.showOnBoard}
              onOpenFileFromAgent={fileBoardLinks.openFromAgent}
              onSendToAgent={sendSelectionToBoardAgent}
              toggleChord={dockChords.toggle}
              widenChord={dockChords.widen}
            />
            <CanvasCommandDeliveryOverlay
              deliveries={commandDelivery.deliveries}
              onDeliveryComplete={commandDelivery.complete}
            />
            <AgentCompletionToasts
              view={completionToasts.view}
              position={toastPosition}
              autoDismiss={completionToastAutoDismiss}
              onDismiss={completionToasts.dismiss}
              onActivate={(toast) => {
                // No dismiss here — the card animates itself out after activation (beginLeave),
                // so removal rides the same slide-out as every other dismissal path.
                if (toast.scope === "background" && toast.agentProjectId) {
                  void selectProject(toast.agentProjectId);
                } else {
                  runCanvasCommand({ kind: "focus-node", nodeId: toast.agentId });
                }
              }}
            />
            <CanvasCollaborationRunOverlay
              launch={collaborationLaunch}
              participants={collaborationParticipants}
              task={collaborationTask.task}
              taskLoading={collaborationTask.loading}
              taskError={collaborationTask.error}
              mailboxMessages={collaborationMailboxMessages}
              storageStatus={collaborationStorageStatus}
              projectId={activeProjectId}
              runId={canvasCollaborationRunId(collaborationLaunch)}
              onSpawnMissing={spawnMissingCollaborationAgents}
              onFocusParticipant={(nodeId) => runCanvasCommand({ kind: "focus-node", nodeId })}
              onRecordEvidence={recordManualCollaborationEvidence}
              onMarkBlocked={markManualCollaborationBlocked}
            />
            {frameToast ? <CanvasFrameToast text={frameToast.text} onUndo={frameToast.notice ? undefined : handleFrameToastUndo} /> : null}
            {intake.notice ? (
              <div className="canvas-intake-notice" role="status" onClick={intake.dismissNotice}>
                {intake.notice}
              </div>
            ) : null}
            {sessionNotice ? (
              <div
                className={`canvas-workflow-save-notice canvas-workflow-save-notice--${sessionNotice.kind}`}
                role={sessionNotice.kind === "error" ? "alert" : "status"}
                onClick={() => setSessionNotice(null)}
              >
                {sessionNotice.text}
              </div>
            ) : null}
            {addProjectOpen ? (
              <div
                className="canvas-picker-overlay"
                role="presentation"
                onClick={(event) => { if (event.target === event.currentTarget) setAddProjectOpen(false); }}
              >
                <CanvasAddProjectPanel
                  projects={projects}
                  onPickLocalFolder={() => { void handleNewProjectViaDialog(); }}
                  onOpenProject={(root, location) => { void openProject(root, location); }}
                  onClose={() => setAddProjectOpen(false)}
                />
              </div>
            ) : null}
            <DragOverlay dropAnimation={null}>
              {skillDnd.activeSkill ? (
                <div className="canvas-skill-drag-chip">/{skillDnd.activeSkill.name}</div>
              ) : null}
            </DragOverlay>
          </DndContext>
          </CanvasGraphRunProvider>
          )}
        </div>
      </div>
    </div>
    </LiveVoiceStatusProvider>
  );
}
