"use client";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Panel } from "@xyflow/react";
import { codecanvasMemoryArchiveExpired } from "@/lib/tauri/codecanvas";
import { isTauri } from "@/lib/tauri/runtime";
import { useCanvasZoomActions } from "./CanvasZoomControl";
import { CanvasCornerControlBar } from "./CanvasCornerControlBar";
import { CanvasProjectMemoryPanel } from "./memory/CanvasProjectMemoryPanel";
import { CanvasSessionsPanel } from "./sessions/CanvasSessionsPanel";
import { SESSION_LIST_TOGGLE_ATTR } from "./sessions/CanvasSessionList";
import { useCanvasSessions } from "../hooks/useCanvasSessions";
import { useNeedsYouQueue } from "../hooks/useNeedsYouQueue";
import { useAgentStatusSnapshots } from "../hooks/useAgentStatusSnapshots";
import { needsYouConfirmText } from "../services/session-verdict-copy";
import type { CanvasSessionRecord } from "../services/session-record";
import { agentSessionControlRegistry } from "../services/session-control-registry";
import { useCodeCanvasProjectMemory } from "../hooks/useCodeCanvasProjectMemory";
import type { CanvasViewportZoomBounds } from "../services/canvas-viewport-store";

interface Props {
  bounds: CanvasViewportZoomBounds;
  nodeCount: number;
  projectId: string | null | undefined;
  /** Node handles by id, for naming session rows whose node is still on the board. */
  agentNames?: Record<string, string | undefined>;
  /** Takes the user to a node. Sessions use it to reach a running conversation. */
  onFocusNode?: (nodeId: string) => void;
  /**
   * Press a session row. The corner only decides where to look; what a press means belongs to the
   * single dispatcher (`hooks/useSessionDispatch.ts`).
   */
  onDispatchSession: (session: CanvasSessionRecord) => void | Promise<void>;
  /**
   * A switch the dispatcher is holding until the user answers. It opens the Sessions list and is
   * asked inside the pressed row, wherever the press came from (list, ⌘K, cycle hotkey).
   */
  sessionConfirm?: { session: CanvasSessionRecord; settle: (go: boolean) => void } | null;
  /**
   * Command-bar layout: zoom stays in the corner; the Memory / Sessions popovers portal into `bar`
   * and their rows into the ⋯ menu's `menu` (null while that menu is closed). Absent = the full
   * corner, as in the Top Bar layout.
   */
  docked?: { bar: HTMLElement | null; menu: HTMLElement | null };
}

/**
 * The unified bottom-right control instrument: one glass bar carrying zoom + project memory, with
 * the memory panel as a popover above it. Consolidates the old zoom pill and memory chip into a
 * single Panel so the corner reads as one system. Memory is hidden until a project is open.
 */
export function CanvasCornerControls({ bounds, nodeCount, projectId, agentNames, onFocusNode, onDispatchSession, sessionConfirm, docked }: Props) {
  const { zoom, handleFitAll, handleZoomIn, handleZoomOut } = useCanvasZoomActions(bounds, nodeCount);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const hasProject = typeof projectId === "string" && projectId.length > 0;
  const memory = useCodeCanvasProjectMemory(hasProject ? projectId : null);
  const { refresh } = memory;

  // Opportunistic retention hygiene, once per project open (moved here from the old memory dock).
  useEffect(() => {
    if (!hasProject || !isTauri()) return;
    let cancelled = false;
    void codecanvasMemoryArchiveExpired(projectId as string)
      .then((archived) => { if (!cancelled && archived > 0) void refresh(); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [hasProject, projectId, refresh]);

  const sessions = useCanvasSessions(hasProject ? projectId : null);
  const { refresh: refreshSessions } = sessions;

  // Read from the registry at press time, not at render: a node can mount or leave while the
  // popover is open, and a row must never promise something the board can no longer do.
  const board = useMemo(
    () => ({
      projectId: hasProject ? projectId : null,
      isRegistered: (nodeId: string) => Boolean(agentSessionControlRegistry.get(nodeId)),
      isDormant: (nodeId: string) => agentSessionControlRegistry.get(nodeId)?.isDormant() ?? false,
      activeSessionId: (nodeId: string) =>
        agentSessionControlRegistry.get(nodeId)?.activeSessionId() ?? null,
    }),
    [hasProject, projectId],
  );

  // Agents waiting on a human, by node — the same queue as the Needs-you lane, nothing persisted.
  const waiting = useNeedsYouQueue(useAgentStatusSnapshots());
  const needsYouByNode = new Map(
    waiting.filter((entry) => (entry.source ?? "agent") === "agent").map((entry) => [entry.id, entry]),
  );

  const open = memoryOpen && hasProject;
  const sessionsPopoverOpen = (sessionsOpen || Boolean(sessionConfirm)) && hasProject;
  const confirmNodeId = sessionConfirm?.session.nodeId;
  const confirm = sessionConfirm
    ? {
        sessionId: sessionConfirm.session.id,
        text: needsYouConfirmText(
          confirmNodeId ? agentNames?.[confirmNodeId] : undefined,
          confirmNodeId ? needsYouByNode.get(confirmNodeId)?.headline : undefined,
        ),
        onAnswer: (go: boolean) => {
          sessionConfirm.settle(go);
          // Stay keeps the list open, so another row can be picked; Switch closes it.
          setSessionsOpen(!go);
        },
      }
    : null;
  // Closing the list with a question pending is an answer: Stay.
  const closeSessions = () => {
    sessionConfirm?.settle(false);
    setSessionsOpen(false);
  };

  // Read on open rather than on a timer: sessions change when an agent launches or a capture lands,
  // which is rare next to how often this canvas re-renders.
  useEffect(() => {
    if (sessionsPopoverOpen) void refreshSessions();
  }, [sessionsPopoverOpen, refreshSessions]);

  const toggleMemory = () => { setMemoryOpen((value) => !value); setSessionsOpen(false); };
  const toggleSessions = () => {
    if (sessionsPopoverOpen) closeSessions();
    else setSessionsOpen(true);
    setMemoryOpen(false);
  };
  const popovers = (
    <>
      {sessionsPopoverOpen ? (
        <div className="canvas-corner-memory-pop">
          <CanvasSessionsPanel
            sessions={sessions.sessions}
            loading={sessions.loading}
            error={sessions.error}
            agentNames={agentNames}
            board={board}
            needsYouByNode={needsYouByNode}
            confirm={confirm}
            onTogglePinned={(session, pinned) => void sessions.setPinned(session, pinned)}
            onDeleteSession={sessions.deleteSession}
            onUndoDelete={sessions.undoDelete}
            pendingDelete={sessions.pendingDelete}
            onDispatchSession={(session) => {
              // Take the user there first: work they cannot see reads as nothing happening.
              if (session.nodeId && agentSessionControlRegistry.get(session.nodeId)) {
                onFocusNode?.(session.nodeId);
              }
              setSessionsOpen(false);
              void Promise.resolve(onDispatchSession(session)).then(() => refreshSessions());
            }}
            onClose={closeSessions}
          />
        </div>
      ) : null}
      {open ? (
        <div className="canvas-corner-memory-pop">
          <CanvasProjectMemoryPanel
            open
            items={memory.items}
            loading={memory.loading}
            error={memory.error}
            includeArchived={memory.includeArchived}
            onSearch={(query) => void memory.search(query)}
            onWrite={(input) => void memory.write(input)}
            onArchive={(itemId) => void memory.archive(itemId)}
            onRestore={(itemId) => void memory.restore(itemId)}
            onSetPinned={(itemId, pinned) => void memory.setPinned(itemId, pinned)}
            onIncludeArchivedChange={(next) => void memory.setIncludeArchived(next)}
            onRefresh={() => void memory.refresh()}
            onClose={() => setMemoryOpen(false)}
          />
        </div>
      ) : null}
    </>
  );

  // Command-bar layout: zoom stays in the corner (a bar that slides open under the pointer gets in
  // the way of the Frame and ⋯ buttons), Memory and Sessions move into the bar's ⋯ menu, and their
  // popovers open above the bar.
  // occlusion-exempt: the portals land inside the command bar and its ⋯ menu (which holds the lock), not over the canvas.
  const dockedExtras = docked ? (
    <>
      {docked.bar && (open || sessionsPopoverOpen)
        ? createPortal(<div className="canvas-docked-corner-pop">{popovers}</div>, docked.bar)
        : null}
      {docked.menu && hasProject
        ? createPortal(
            <>
              <button type="button" role="menuitemcheckbox" aria-checked={open} className="canvas-frame-menu-item" onClick={toggleMemory}>
                <span className="canvas-frame-menu-name">Memory</span>
                {memory.items.length > 0 ? <span className="canvas-docked-nav-kbd">{memory.items.length}</span> : null}
              </button>
              <button type="button" role="menuitemcheckbox" aria-checked={sessionsPopoverOpen} className="canvas-frame-menu-item" {...{ [SESSION_LIST_TOGGLE_ATTR]: "" }} onClick={toggleSessions}>
                <span className="canvas-frame-menu-name">Sessions</span>
                {needsYouByNode.size > 0 ? <span className="canvas-docked-nav-needs-you" role="img" aria-label="An agent needs you" /> : null}
                {sessions.sessions.length > 0 ? <span className="canvas-docked-nav-kbd">{sessions.sessions.length}</span> : null}
              </button>
            </>,
            docked.menu,
          )
        : null}
    </>
  ) : null;

  return (
    <Panel position="bottom-right" className="canvas-corner-panel">
      {docked ? dockedExtras : popovers}
      <CanvasCornerControlBar
        zoom={zoom}
        bounds={bounds}
        onFitAll={handleFitAll}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        showMemory={hasProject && !docked}
        memoryOpen={open}
        memoryCount={memory.items.length}
        onToggleMemory={toggleMemory}
        showSessions={hasProject && !docked}
        sessionsOpen={sessionsPopoverOpen}
        sessionCount={sessions.sessions.length}
        onToggleSessions={toggleSessions}
      />
    </Panel>
  );
}
