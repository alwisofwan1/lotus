"use client";
import { memo, useCallback, useMemo } from "react";
import type { KeyboardEvent } from "react";
import { writeTerminalSession } from "@/modules/codespace/services/terminal-session-registry";
import type { NodeProps } from "@xyflow/react";
import { useDroppable } from "@dnd-kit/core";
import { useCanvasTheme } from "@/modules/codecanvas/hooks/useCanvasTheme";
import { resolveCanvasTerminalTheme } from "@/modules/codecanvas/services/theme/canvas-terminal-theme";
import { resolveTerminalFloor } from "@/modules/codecanvas/services/theme/terminal-floor";
import { useCanvasTerminalNode } from "@/modules/codecanvas/hooks/useCanvasTerminalNode";
import { TERM_DROP_PREFIX } from "@/modules/codecanvas/hooks/useCanvasSkillDnd";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { useCanvasDropTarget } from "../../services/canvas-drop-target-store";
import { CanvasPtyViewport } from "./CanvasPtyViewport";
import { CanvasTerminalHeader } from "./CanvasTerminalHeader";
import { CanvasWorktreePanel } from "../panels/CanvasWorktreePanel";
import { useCanvasLodTier } from "@/modules/codecanvas/hooks/useCanvasLodTier";
import type { DispatchCanvasNodeCommand } from "../../services/nodes/canvas-node-command";
import { terminalDisplayName } from "../../services/terminal/terminal-node-identity";

export interface TerminalNodeData {
  cwd: string;
  terminalNumber: number;
  label?: string;
  assignedWorktree: string | null;
  assignedWorktreePath: string | null;
  runtimeScope?: string;
  runtimePaneId?: string;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  onCwdChange?: (nodeId: string, cwd: string) => void;
  onLabelChange?: (nodeId: string, label: string) => void;
  onWorktreeChange?: (nodeId: string, branch: string | null, path: string | null) => void;
  onAddSkillsNode?: (terminalId: string, cwd: string) => void;
  onSpawnTerminalForWorktree?: (terminalId: string, branch: string, path: string) => void;
  hasSkillsNode?: boolean;
  hasBrowserNode?: boolean;
  /** Set when this node adopted a cell the machine's Standalone Host already runs. */
  adoptedPaneId?: string;
  /** Run instead of a shell: a task delegated from the Dock (S4b). Session-only. */
  launchCommand?: string[];
  /** The Lotus Claude account `launchCommand` runs on (issues/07). Session-only. */
  claudeAccount?: string;
  onToggleBrowser?: (nodeId: string) => void;
  [key: string]: unknown;
}

export const TerminalNode = memo(function TerminalNode({ id, data, selected }: NodeProps) {
  const {
    cwd, terminalNumber, label, assignedWorktree, runtimeScope, runtimePaneId, dispatchCommand,
    onClose, onCwdChange, onLabelChange, onWorktreeChange, onAddSkillsNode, onSpawnTerminalForWorktree,
    hasSkillsNode = false, hasBrowserNode = false, onToggleBrowser, adoptedPaneId, launchCommand,
    claudeAccount,
  } = data as TerminalNodeData;
  const effectivePaneId = runtimePaneId ?? id;
  const dropActive = useCanvasDropTarget(id);

  // OPAQUE FLOOR (plans/canvas-terminal-opaque-floor) — the same ground, from the same resolver,
  // as the live Agent Node. This node used to run xterm transparent over a CSS ink-floor while the
  // agent ran opaque, and on the wallpaper themes it also carried its own blurred backdrop copy, so
  // the two families rendered as visibly different materials side by side. One resolver means the
  // colour cannot drift between them, or between xterm and the viewport underneath it.
  const { theme: canvasTheme } = useCanvasTheme();
  const terminalTheme = useMemo(
    () => resolveCanvasTerminalTheme({
      mode: canvasTheme.mode,
      background: resolveTerminalFloor(canvasTheme).background,
    }),
    [canvasTheme],
  );
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `${TERM_DROP_PREFIX}${id}` });
  // At collapsed LOD tiers the xterm host stays mounted (no DOM orphaning) but the
  // runtime pauses rendering — a solid block covers it. Hysteresis keeps it from thrashing.
  const lodTier = useCanvasLodTier();
  const collapsed = lodTier !== "full";

  const handleCwdChange = useCallback(
    (newCwd: string) => {
      if (dispatchCommand) dispatchCommand({ kind: "patch-terminal", nodeId: id, patch: { cwd: newCwd } });
      else onCwdChange?.(id, newCwd);
    },
    [dispatchCommand, id, onCwdChange],
  );
  const handleLabelChange = useCallback(
    (nextLabel: string) => {
      if (dispatchCommand) dispatchCommand({ kind: "patch-terminal", nodeId: id, patch: { label: nextLabel } });
      else onLabelChange?.(id, nextLabel);
    },
    [dispatchCommand, id, onLabelChange],
  );
  const handleWorktreeChange = useCallback(
    (branch: string | null, path: string | null) => {
      if (dispatchCommand) dispatchCommand({ kind: "patch-terminal", nodeId: id, patch: { assignedWorktree: branch, assignedWorktreePath: path } });
      else onWorktreeChange?.(id, branch, path);
    },
    [dispatchCommand, id, onWorktreeChange],
  );

  const {
    containerRef,
    runtimeStatus,
    activity,
    currentCwd: runtimeCwd,
    searchAPI,
    activePanel,
    toggleWT,
    closePanel,
    assignWorktree,
    unassignWorktree,
    searchVisible,
    openSearch,
    closeSearch,
  } = useCanvasTerminalNode({
    id, cwd, runtimeScope, runtimePaneId,
    onCwdChange: handleCwdChange,
    onWorktreeChange: handleWorktreeChange,
    terminalTheme,
    // False is what buys the render win: an opaque grid lets both the DOM and the WebGL renderer
    // take their background-run fast path instead of compositing alpha per cell.
    allowTransparency: false,
    active: !collapsed,
    canvasTerminalId: id,
    adoptedPaneId,
    launchCommand,
    claudeAccount,
  });

  // Auto-cd the PTY to the worktree directory on assignment.
  const handleAssignWorktree = useCallback(
    (branch: string, path: string) => {
      writeTerminalSession(effectivePaneId, `cd ${path}\n`);
      assignWorktree(branch, path);
    },
    [effectivePaneId, assignWorktree],
  );

  const writeToTerminal = useCallback(
    (cmd: string) => writeTerminalSession(effectivePaneId, cmd),
    [effectivePaneId],
  );

  const handleSpawnForWorktree = useCallback(
    (branch: string, path: string) => {
      if (dispatchCommand) dispatchCommand({ kind: "terminal-spawn-for-worktree", terminalId: id, branch, path });
      else onSpawnTerminalForWorktree?.(id, branch, path);
    },
    [dispatchCommand, id, onSpawnTerminalForWorktree],
  );

  const currentCwd = runtimeCwd || cwd;
  const needsRuntimeRecovery = runtimeStatus === "failed" || runtimeStatus === "exited";
  const recoverTerminal = useCallback(() => {
    if (dispatchCommand) dispatchCommand({ kind: "recover-terminal", nodeId: id });
  }, [dispatchCommand, id]);

  // Accent strip mirrors the header dot: green while running, gray when idle/exited,
  // amber while starting, red on failure.
  const isLive = runtimeStatus === "live";
  const statusTone =
    isLive && activity === "running" ? "running" :
    isLive ? "idle" :
    runtimeStatus === "starting" ? "starting" :
    runtimeStatus === "failed" ? "failed" :
    "idle";

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "f") {
      e.preventDefault();
      openSearch();
    }
  }, [openSearch]);

  const handleToggleSkills = useCallback(() => {
    if (activePanel === "wt") closePanel();
    if (dispatchCommand) dispatchCommand({ kind: "terminal-add-skills", terminalId: id, cwd: currentCwd });
    else onAddSkillsNode?.(id, currentCwd);
  }, [activePanel, closePanel, currentCwd, dispatchCommand, id, onAddSkillsNode]);

  const handleToggleBrowser = useCallback(
    () => {
      if (dispatchCommand) dispatchCommand({ kind: "toggle-browser", terminalId: id });
      else onToggleBrowser?.(id);
    },
    [dispatchCommand, onToggleBrowser, id],
  );

  const overlay =
    activePanel === "wt" ? (
      <CanvasWorktreePanel
        cwd={currentCwd}
        assignedWorktree={assignedWorktree ?? null}
        onAssign={handleAssignWorktree}
        onUnassign={unassignWorktree}
        onClose={closePanel}
        writeToTerminal={writeToTerminal}
        onSpawnTerminal={onSpawnTerminalForWorktree ? handleSpawnForWorktree : undefined}
      />
    ) : null;

  return (
    <CanvasNodeFrame
      kind="terminal"
      selected={!!selected}
      minWidth={300}
      minHeight={200}
      lodTier={lodTier}
      statusTone={statusTone}
      dropActive={dropActive}
      dropLabel={`Drop file into Terminal ${terminalNumber ?? 1}`}
      header={
        <CanvasTerminalHeader
          terminalNumber={terminalNumber ?? 1}
          label={label}
          runtimeStatus={runtimeStatus}
          activity={activity}
          currentCwd={currentCwd}
          assignedWorktree={assignedWorktree ?? null}
          worktreeActive={activePanel === "wt"}
          skillsActive={hasSkillsNode}
          browserActive={hasBrowserNode}
          onKill={() => {
            if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
            else onClose?.(id);
          }}
          onToggleWT={toggleWT}
          onToggleSK={handleToggleSkills}
          onToggleBrowser={handleToggleBrowser}
          onRename={dispatchCommand || onLabelChange ? handleLabelChange : undefined}
          onFocus={dispatchCommand ? () => dispatchCommand({ kind: "focus-node", nodeId: id }) : undefined}
        />
      }
      overlay={overlay}
    >
      {/*
       * nodrag/nopan/nowheel + onPointerDown stopPropagation — prevents ReactFlow's
       * setPointerCapture from intercepting xterm's mouse events and creating ghost selections.
       */}
      <div
        ref={setDropRef}
        className={`canvas-node-body nodrag nopan nowheel${isOver ? " canvas-node-body--drop-over" : ""}`}
        data-testid="canvas-terminal-body"
        data-canvas-command-delivery-target={id}
        onKeyDown={handleKeyDown}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <CanvasPtyViewport
          containerRef={containerRef}
          collapsed={collapsed}
          search={searchVisible && searchAPI ? { api: searchAPI, onClose: closeSearch } : null}
          recovery={
            needsRuntimeRecovery
              ? {
                  title: runtimeStatus === "failed" ? "Terminal needs recovery" : "Terminal exited",
                  sub: "Start a fresh runtime for this Canvas Terminal.",
                  recoverLabel: "Restart terminal",
                  onRecover: dispatchCommand ? recoverTerminal : undefined,
                }
              : null
          }
          glyph={{
            label: terminalDisplayName({ label, terminalNumber }),
            tone: activity === "running" ? "active" : "neutral",
            detail: currentCwd,
            testId: "canvas-terminal-glyph-cover",
          }}
        />
      </div>
    </CanvasNodeFrame>
  );
});
