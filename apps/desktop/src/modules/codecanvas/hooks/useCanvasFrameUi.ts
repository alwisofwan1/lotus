"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { Node, ReactFlowInstance } from "@xyflow/react";
import { getTerminalActivity } from "@/modules/codespace/services/terminal-activity-registry";
import type { FrameActions } from "../components/nodes/frame-actions-context";
import { canvasFrameDropStore } from "../services/canvas-frame-drop-store";
import { canvasFrameNoticeStore } from "../services/canvas-frame-notice-store";
import { markFirstFrameHintSeen, readFirstFrameHintSeen, shouldShowFirstFrameHint } from "../services/canvas-frame-hint";
import { pickFrameSuggestion, readDismissedSuggestions, writeDismissedSuggestions } from "../services/canvas-frame-suggestion";
import { buildFrameSwitcher } from "../services/canvas-frame-switcher";
import {
  canAddFrame,
  canCreateFrame,
  frameDeletionSummary,
  frameIdOf,
  frameTitleOf,
  framesInOrder,
  isFrameNode,
  membershipChangesForDrop,
  membershipToastText,
  tryCreateFrameFromSelection,
  type FrameMoveResult,
  type FrameSeed,
  type LiveSessions,
  type MembershipChange,
} from "../services/canvas-frames";
import type { AgentStatusSnapshot } from "../services/agent-status-registry";
import type { CanvasCommand, CanvasCommandResult } from "../services/commands/canvas-command";
import { buildSpawnFirstAgentDefinition } from "../services/spawn-first-agent";
import { currentNamePool } from "@/lib/agent-naming";

type FrameCommand = Extract<CanvasCommand, { kind: "create-frame" | "move-to-frame" | "fly-to-frame" }>;

interface FrameUiDeps {
  nodes: Node[];
  nodesLatestRef: MutableRefObject<Node[]>;
  flowInstance: ReactFlowInstance | null;
  /**
   * Focus a Frame (decision 35): arrange its members to fill the screen and fit the camera to them.
   * The ONE function every fly-to-Frame path calls (chips, ⌥1–9, Overview, NL "buka X").
   */
  focusFrame: (frameId: string) => void;
  /** Make a Frame the active one (decision 36) without moving the camera: title-tab interaction. */
  activateFrame: (frameId: string) => void;
  /** Live agent roster (the switcher chips, the Overview labels and the delete summary read it). */
  liveAgentStatuses: AgentStatusSnapshot[];
  applyFrameMembership: (changes: readonly MembershipChange[], direction: "forward" | "reverse") => void;
  sendNodesToFrame: (ids: readonly string[], frameId: string | undefined) => Pick<FrameMoveResult, "changes"> & { undo: () => void };
  createFrame: (ids: string[], seed?: FrameSeed) => string | null;
  addEmptyFrame: (centre: { x: number; y: number }) => string | null;
  addFrameInBox: (box: { x: number; y: number; w: number; h: number }) => string | null;
  renameFrameNode: FrameActions["rename"];
  recolorFrameNode: FrameActions["recolor"];
  fitFrameNode: FrameActions["fit"];
  dissolveFrame: (ids: string[]) => void;
  deleteFrameAndContents: (frameId: string) => void | Promise<void>;
  spawnCentreRef: { readonly current: (() => { x: number; y: number } | null) | null };
  runCanvasCommand: (command: CanvasCommand) => CanvasCommandResult | undefined;
  teamLabel: string | undefined;
  undoHistory: () => void;
  clearHistory: () => void;
  resetTerminal: (nodeId: string) => void;
  onToolDone: () => void;
  /** Receives the NL / voice Frame commands (the command center routes them here). */
  frameCommandRef: MutableRefObject<(command: FrameCommand) => CanvasCommandResult>;
}

/**
 * The Frame UI around the canvas (ADR-0050): the membership toast with its Undo, switcher / ⌥N
 * navigation, the NL and voice Frame commands, the title-tab actions, the delete-with-contents
 * dialog, the first-Frame hint and the Frame Suggestion. Lifted out of CanvasPage, which only
 * wires the result into the tree.
 */
export function useCanvasFrameUi(deps: FrameUiDeps) {
  const {
    nodes, nodesLatestRef, focusFrame, activateFrame, liveAgentStatuses, applyFrameMembership, sendNodesToFrame, createFrame,
    addEmptyFrame, addFrameInBox, renameFrameNode, recolorFrameNode, fitFrameNode, dissolveFrame, deleteFrameAndContents,
    spawnCentreRef, runCanvasCommand, teamLabel, undoHistory, clearHistory, resetTerminal, onToolDone, frameCommandRef,
  } = deps;

  // ── Membership toast ──
  const [frameToast, setFrameToast] = useState<{ text: string; changes: MembershipChange[]; undo?: () => void; notice?: boolean } | null>(null);
  const frameToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissFrameToast = useCallback(() => {
    if (frameToastTimerRef.current) clearTimeout(frameToastTimerRef.current);
    frameToastTimerRef.current = null;
    setFrameToast(null);
  }, []);
  useEffect(() => () => { if (frameToastTimerRef.current) clearTimeout(frameToastTimerRef.current); }, []);
  const offerMembershipToast = useCallback((changes: MembershipChange[], extra?: { text?: string; undo?: () => void }) => {
    if (frameToastTimerRef.current) clearTimeout(frameToastTimerRef.current);
    setFrameToast({ text: extra?.text ?? membershipToastText(nodesLatestRef.current, changes[0]), changes, undo: extra?.undo });
    frameToastTimerRef.current = setTimeout(() => setFrameToast(null), 6000);
  }, [nodesLatestRef]);
  // Refusals raised by the Frame operations (limit, overlap): a text-only toast, no Undo.
  useEffect(() => canvasFrameNoticeStore.subscribe((text) => {
    if (frameToastTimerRef.current) clearTimeout(frameToastTimerRef.current);
    setFrameToast({ text, changes: [], notice: true });
    frameToastTimerRef.current = setTimeout(() => setFrameToast(null), 4000);
  }), []);
  const commitFrameDrop = useCallback((dragged: Node[]) => {
    canvasFrameDropStore.set(null);
    const changes = membershipChangesForDrop(nodesLatestRef.current, dragged);
    if (changes.length === 0) return;
    applyFrameMembership(changes, "forward");
    offerMembershipToast(changes);
  }, [applyFrameMembership, offerMembershipToast, nodesLatestRef]);
  const handleFrameToastUndo = useCallback(() => {
    const undo = frameToast?.undo;
    dismissFrameToast();
    if (undo) undo();
    else undoHistory();
  }, [dismissFrameToast, undoHistory, frameToast]);

  // ── Switcher, navigation, send-selection ──
  const frameSwitcher = useMemo(() => buildFrameSwitcher(nodes, liveAgentStatuses), [nodes, liveAgentStatuses]);
  const goToFrame = useCallback((frameId: string) => {
    if (!nodesLatestRef.current.some((n) => n.id === frameId && isFrameNode(n))) return;
    focusFrame(frameId);
  }, [focusFrame, nodesLatestRef]);
  // Numbered like the switcher chips and the Overview labels: array order, one shared function.
  const frameIdAt = (index: number): string | undefined => framesInOrder(nodesLatestRef.current)[index - 1]?.id;
  const goToFrameAt = (index: number) => {
    const id = frameIdAt(index);
    if (id) goToFrame(id);
  };
  // The nodes move INSIDE the Frame too (it grows to fit), and the toast's Undo restores all of it.
  const moveIntoFrameWithToast = (ids: readonly string[], frameId: string | undefined, text?: string): boolean => {
    const result = sendNodesToFrame(ids, frameId);
    if (result.changes.length === 0) return false;
    offerMembershipToast([...result.changes], { text, undo: result.undo });
    return true;
  };
  const moveSelectionToFrameAt = (index: number) => {
    const id = frameIdAt(index);
    if (!id) return;
    moveIntoFrameWithToast(nodesLatestRef.current.filter((n) => n.selected).map((n) => n.id), id);
  };

  // NL bar + voice Frame commands. Safe ops: apply at once, offer the toast with an exact Undo. An op
  // that would change nothing reports why instead of toasting.
  useEffect(() => {
    frameCommandRef.current = (command) => {
      const current = nodesLatestRef.current;
      if (command.kind === "fly-to-frame") {
        goToFrame(command.frameId);
        return {};
      }
      if (command.kind === "move-to-frame") {
        if (!moveIntoFrameWithToast(command.nodeIds, command.frameId)) {
          return { error: command.frameId ? "Already in that Frame." : "Not in a Frame." };
        }
        return {};
      }
      const members = current.filter((n) => command.nodeIds.includes(n.id));
      if (!canCreateFrame(members)) return { error: "Nothing there can go in a Frame." };
      // Ask first, so a refusal is reported for what it is (Frame limit, overlap), not as "nothing there".
      const dry = tryCreateFrameFromSelection(current, members.map((n) => n.id), "dry-run", { title: command.title });
      if (!dry.ok) return { error: dry.message };
      const frameId = createFrame(members.map((n) => n.id), { title: command.title });
      if (!frameId) return { error: "Nothing there can go in a Frame." };
      const changes: MembershipChange[] = members
        .filter((n) => !isFrameNode(n))
        .map((n) => ({ nodeId: n.id, from: frameIdOf(n), to: frameId }));
      offerMembershipToast(changes, {
        text: command.title ? `Frame ${command.title} dibuat` : "Frame dibuat",
        undo: () => {
          dissolveFrame([frameId]);
          applyFrameMembership(changes.filter((c) => c.from), "reverse");
        },
      });
      return { nodeId: frameId };
    };
  });

  const handleCreateFrameAtCentre = useCallback(() => {
    addEmptyFrame(spawnCentreRef.current?.() ?? { x: 0, y: 0 });
  }, [addEmptyFrame, spawnCentreRef]);
  // Frame tool (press N, drag): an empty Frame filling the dragged box, then back to select.
  const handleFrameToolCreate = useCallback((box: { x: number; y: number; w: number; h: number }) => {
    addFrameInBox(box);
    onToolDone();
  }, [addFrameInBox, onToolDone]);

  // ── Title-tab actions and delete-with-contents ──
  const [requestedDeleteTarget, setFrameDeleteTarget] = useState<string | null>(null);
  // The Frame vanishing (undo, agent) while the dialog is open closes it: no target, no dialog.
  const frameDeleteTarget = requestedDeleteTarget && nodes.some((n) => n.id === requestedDeleteTarget) ? requestedDeleteTarget : null;
  // Every title-tab action is an interaction with that Frame, so it becomes the active one (decision 36).
  const frameActions = useMemo<FrameActions>(() => ({
    rename: (frameId, title) => { activateFrame(frameId); renameFrameNode(frameId, title); },
    recolor: (frameId, colorId) => { activateFrame(frameId); recolorFrameNode(frameId, colorId); },
    fit: (frameId) => { activateFrame(frameId); fitFrameNode(frameId); },
    deleteKeepMembers: (frameId) => dissolveFrame([frameId]),
    requestDeleteWithContents: setFrameDeleteTarget,
    spawn: (frameId, kind) => {
      activateFrame(frameId);
      if (kind === "terminal") {
        runCanvasCommand({ kind: "create-node", nodeType: "terminal", frameId });
        return;
      }
      const takenNames = nodesLatestRef.current
        .filter((n) => n.type === "agent")
        .map((n) => String((n.data as { name?: string }).name ?? ""));
      runCanvasCommand({
        kind: "create-agent",
        definition: buildSpawnFirstAgentDefinition("claude", takenNames, { pool: currentNamePool() }),
        options: { teamLabel, frameId },
      });
    },
  }), [activateFrame, renameFrameNode, recolorFrameNode, fitFrameNode, dissolveFrame, runCanvasCommand, teamLabel, nodesLatestRef]);
  // What would actually stop: agents with a live session, terminals executing something.
  const liveSessions = useMemo<LiveSessions>(() => {
    const byId = new Map(liveAgentStatuses.map((s) => [s.id, s.status]));
    return {
      agentStatus: (id) => byId.get(id),
      terminalRunning: (id) => {
        const data = nodes.find((n) => n.id === id)?.data as { runtimePaneId?: unknown } | undefined;
        return getTerminalActivity(typeof data?.runtimePaneId === "string" ? data.runtimePaneId : id) === "running";
      },
    };
  }, [liveAgentStatuses, nodes]);
  const frameDeleteSummary = useMemo(
    () => (frameDeleteTarget ? frameDeletionSummary(nodes, frameDeleteTarget, liveSessions) : null),
    [frameDeleteTarget, nodes, liveSessions],
  );
  const frameDeleteTitle = frameDeleteTarget ? frameTitleOf(nodes.find((n) => n.id === frameDeleteTarget) ?? ({} as Node)) : "";
  const confirmDeleteWithContents = useCallback(() => {
    if (!frameDeleteTarget) return;
    const { memberIds } = frameDeletionSummary(nodesLatestRef.current, frameDeleteTarget, liveSessions);
    for (const id of memberIds) resetTerminal(id);
    setFrameDeleteTarget(null);
    // Sessions ended: nothing left for Undo to bring back, so the history is dropped too. Only once the removal
    // has landed: the members close one by one, and clearing first left the Frame's own removal on the stack.
    void Promise.resolve(deleteFrameAndContents(frameDeleteTarget)).finally(clearHistory);
  }, [frameDeleteTarget, deleteFrameAndContents, clearHistory, resetTerminal, liveSessions, nodesLatestRef]);
  const deleteFrameOnly = useCallback(() => {
    if (!frameDeleteTarget) return;
    dissolveFrame([frameDeleteTarget]);
    setFrameDeleteTarget(null);
  }, [frameDeleteTarget, dissolveFrame]);

  // ── First-Frame hint and Frame Suggestion ──
  const [firstFrameHintSeen, setFirstFrameHintSeen] = useState(true); // true until storage is read: no flash
  // Storage is only readable after mount (static export / SSR render with the default).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setFirstFrameHintSeen(readFirstFrameHintSeen()); }, []);
  const dismissFirstFrameHint = useCallback(() => {
    markFirstFrameHintSeen();
    setFirstFrameHintSeen(true);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!firstFrameHintSeen && nodes.some(isFrameNode)) dismissFirstFrameHint();
  }, [firstFrameHintSeen, nodes, dismissFirstFrameHint]);
  const showFirstFrameHint = shouldShowFirstFrameHint(nodes, firstFrameHintSeen);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<ReadonlySet<string> | null>(null); // null until storage is read
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setDismissedSuggestions(readDismissedSuggestions()); }, []);
  const frameSuggestion = useMemo(
    () => (showFirstFrameHint || !dismissedSuggestions || !canAddFrame(nodes) ? null : pickFrameSuggestion(nodes, dismissedSuggestions)),
    [nodes, showFirstFrameHint, dismissedSuggestions],
  );
  const dismissFrameSuggestion = useCallback((key: string) => {
    setDismissedSuggestions((prev) => {
      const next = new Set(prev ?? []);
      next.add(key);
      writeDismissedSuggestions(next);
      return next;
    });
  }, []);
  const acceptFrameSuggestion = useCallback(() => {
    if (!frameSuggestion) return;
    createFrame(frameSuggestion.memberIds, {
      title: frameSuggestion.context,
      ...(frameSuggestion.taskKey ? { taskKey: frameSuggestion.taskKey } : {}),
    });
  }, [frameSuggestion, createFrame]);
  const frameSelectionIds = useMemo(
    () => nodes.filter((n) => n.selected && !isFrameNode(n) && n.type !== "skill" && n.type !== "skills").map((n) => n.id),
    [nodes],
  );

  return {
    frameToast, handleFrameToastUndo, commitFrameDrop,
    frameSwitcher, goToFrame, goToFrameAt, moveSelectionToFrameAt,
    handleCreateFrameAtCentre, handleFrameToolCreate,
    frameActions, frameDeleteTarget, frameDeleteSummary, frameDeleteTitle, cancelFrameDelete: () => setFrameDeleteTarget(null),
    confirmDeleteWithContents, deleteFrameOnly,
    showFirstFrameHint, dismissFirstFrameHint,
    frameSuggestion, dismissFrameSuggestion, acceptFrameSuggestion,
    frameSelectionIds,
  };
}
