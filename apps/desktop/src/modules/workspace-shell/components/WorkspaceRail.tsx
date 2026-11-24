"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Ellipsis, Pencil, Pin, PinOff, Plus, Search } from "lucide-react";
import { RailFooter } from "./RailFooter";
import { useLotusSettings } from "@/modules/lotus-settings/lotus-settings-context";
import { useSectionReturn } from "@/modules/workspace-shell/hooks/useSectionReturn";
import { ActivityBadge, useAgeNow } from "@/modules/workspace-shell/components/ActivityBadge";
import { DitherStatus } from "@/modules/workspace-shell/components/DitherStatus";
import { formatPaneActivityAge } from "@/modules/workspace-shell/services/pane-activity";
import { KindIcon } from "@/modules/workspace-shell/components/kind-glyph";
import { RunnerMark } from "@/modules/workspace-shell/components/PaneCard";
import { RailPaneMenu, railPaneActions, regroupOptions, type RailPaneAction, type RegroupAction } from "@/modules/workspace-shell/components/RailPaneMenu";
import { beginPaneDrag, LOOSE_DROP } from "@/modules/workspace-shell/services/pane-drag";
import { RailFrameMenu, type RailFrameAction } from "@/modules/workspace-shell/components/RailFrameMenu";
import type { FrameColor } from "@/modules/codespace/components/types";
import { railSections } from "@/modules/workspace-shell/services/rail-order";
import { paneCountLabel } from "@/modules/workspace-shell/services/cell-mapping";
import type { RailFrame, RailPane, RailWorkspace } from "@/modules/workspace-shell/types";

interface WorkspaceRailProps {
  workspaces: RailWorkspace[];
  /** Expanded folders — plural, and independent of which one is showing. */
  openWorkspaceIds: string[];
  activePaneId: string | null;
  /** The chevron: expand or collapse, and nothing else. */
  onToggleWorkspace: (workspaceId: string) => void;
  /** The row: show this folder's panes. It expands too — a folder you open is not collapsed. */
  onOpenWorkspace?: (workspaceId: string) => void;
  onSelectPane: (pane: RailPane, workspace: RailWorkspace) => void;
  /** The Frame on screen, if the screen shows one. */
  activeFrameId?: string | null;
  onRenameFrame?: (workspaceId: string, frameId: string, name: string) => void;
  /** A pane's menu: into a new group (returns its id, so its name opens for typing), another group, or out. */
  onRegroupPane?: (action: RegroupAction, pane: RailPane, workspace: RailWorkspace) => string | null;
  onRecolorFrame?: (workspaceId: string, frameId: string, color: FrameColor) => void;
  /** Delete Frame: the panes stay open (loose); the caller offers the Undo. */
  onDeleteFrame?: (frame: RailFrame, workspace: RailWorkspace) => void;
  onAddWorkspace?: () => void;
  onTogglePin?: (workspaceId: string) => void;
  onRenameWorkspace?: (workspaceId: string, name: string) => void;
  /** Anchored at the trigger so the menu opens where the click happened. */
  onAddPane?: (workspace: RailWorkspace, anchor: { x: number; y: number }) => void;
  /** A pane row's ••• menu (and right-click). `title` comes with "rename" only. */
  onPaneAction?: (action: RailPaneAction, pane: RailPane, workspace: RailWorkspace, title?: string) => void;
  /** The window's nav rows, drawn above the workspace list. */
  navSlot?: React.ReactNode;
  /**
   * A section's own sidebar content (Automations), drawn in place of this rail's nav rows, header
   * and list while that section is open. Only the footer stays, so the window keeps one sidebar.
   */
  sectionSlot?: React.ReactNode;
}

/**
 * Folders, and what is running inside them.
 *
 * Terminals and threads share one list on purpose: a thread belongs to a folder the same way a
 * terminal does, and splitting them into two lists would put the merge back the way it was.
 *
 * Three things a folder row can do beyond opening — pin, rename, add — appear only while the row
 * is hovered or focused. A rail that shows six icons per row at rest is a toolbar, not a list.
 */
export function WorkspaceRail({
  workspaces,
  openWorkspaceIds,
  activePaneId,
  onToggleWorkspace,
  onOpenWorkspace,
  onSelectPane,
  activeFrameId = null,
  onRenameFrame,
  onRegroupPane,
  onRecolorFrame,
  onDeleteFrame,
  onAddWorkspace,
  onTogglePin,
  onRenameWorkspace,
  onAddPane,
  onPaneAction,
  navSlot,
  sectionSlot,
}: WorkspaceRailProps) {
  const { openSettings } = useLotusSettings();
  const returned = useSectionReturn(Boolean(sectionSlot));
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null);
  const [renamingFrameId, setRenamingFrameId] = useState<string | null>(null);
  const [paneMenu, setPaneMenu] = useState<{ pane: RailPane; workspace: RailWorkspace; x: number; y: number } | null>(null);
  const closePaneMenu = useCallback(() => setPaneMenu(null), []);
  const actOnPane = (action: RailPaneAction, pane: RailPane, workspace: RailWorkspace) => {
    setPaneMenu(null);
    if (action === "rename") setRenamingPaneId(pane.id);
    else onPaneAction?.(action, pane, workspace);
  };
  const [frameMenu, setFrameMenu] = useState<{ frame: RailFrame; workspace: RailWorkspace; x: number; y: number } | null>(null);
  const closeFrameMenu = useCallback(() => setFrameMenu(null), []);
  const hasFrameMenu = Boolean(onRenameFrame || onRecolorFrame || onDeleteFrame);
  const actOnFrame = (action: RailFrameAction, frame: RailFrame, workspace: RailWorkspace) => {
    setFrameMenu(null);
    if (action.kind === "rename") setRenamingFrameId(frame.id);
    else if (action.kind === "color") onRecolorFrame?.(workspace.id, frame.id, action.color);
    else onDeleteFrame?.(frame, workspace);
  };
  const navRef = useRef<HTMLElement>(null);
  /** What a pane's menu offers for regrouping: only in a workspace that has Frames. */
  const regroupProps = (pane: RailPane, workspace: RailWorkspace) => {
    if (!onRegroupPane || !workspace.frames) return {};
    return {
      ...regroupOptions(pane, workspace),
      onRegroup: (action: RegroupAction) => {
        setPaneMenu(null);
        const made = onRegroupPane(action, pane, workspace);
        if (made) setRenamingFrameId(made);
      },
    };
  };
  /* Drag a pane row onto a group card to move it there, or onto the folder's loose rows to take
     it out (services/pane-drag.ts: pointer events; the rows and cards only carry data attributes). */
  const dragHandlers = (pane: RailPane, workspace: RailWorkspace) =>
    onRegroupPane && workspace.frames
      ? {
          onPointerDown: (event: React.PointerEvent<HTMLElement>) =>
            beginPaneDrag(event, {
              label: pane.title,
              paneId: pane.id,
              workspaceId: workspace.id,
              fromFrameId: workspace.frames?.find((frame) => frame.paneIds.includes(pane.id))?.id ?? null,
              onDrop: (drop) => drop.kind !== "swap" && onRegroupPane(drop, pane, workspace),
            }),
        }
      : {};
  /** Marks a drop target: a Frame's id, or LOOSE_DROP for the folder's loose rows. */
  const dropTarget = (target: string, workspace: RailWorkspace) =>
    onRegroupPane && workspace.frames ? { "data-pane-drop": target, "data-pane-drop-ws": workspace.id } : {};
  // shortcut: folded groups live in memory and unfold on restart; persist them if anyone misses it.
  const [foldedFrames, setFoldedFrames] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFold = (frameId: string) =>
    setFoldedFrames((prev) => (prev.has(frameId) ? new Set([...prev].filter((id) => id !== frameId)) : new Set([...prev, frameId])));
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();

  // One shared clock: pin every halo to the timeline origin, so eight working rows turn as one
  // group instead of eight spinners out of phase (mockups/rail-working-indicator-v2.html, C2).
  useEffect(() => {
    for (const anim of listRef.current?.getAnimations?.({ subtree: true }) ?? []) {
      if ((anim as CSSAnimation).animationName === "ws-rail-halo-spin" && anim.startTime !== 0) anim.startTime = 0;
    }
  });

  // A turn that just ended gets ~600ms of `data-done`: the halo closes and releases (CSS).
  const lastActivity = useRef(new Map<string, RailPane["activity"]>());
  const [justDone, setJustDone] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const finished: string[] = [];
    const seen = new Map<string, RailPane["activity"]>();
    for (const workspace of workspaces) {
      for (const pane of workspace.panes) {
        seen.set(pane.id, pane.activity);
        if (lastActivity.current.get(pane.id) === "working" && (pane.activity === "idle" || pane.activity === "done")) {
          finished.push(pane.id);
        }
      }
    }
    lastActivity.current = seen;
    if (!finished.length) return;
    setJustDone((prev) => new Set([...prev, ...finished]));
    // Not cleared on re-run: a rail update inside the 600ms must not leave the flag stuck.
    setTimeout(() => {
      setJustDone((prev) => new Set([...prev].filter((id) => !finished.includes(id))));
    }, 600);
  }, [workspaces]);

  /** One pane row: a loose pane, or a member inside its group's card. */
  const paneRow = (pane: RailPane, workspace: RailWorkspace, index: number) => (
renamingPaneId === pane.id ? (
                        <div key={pane.id} className="ws-rail-item" data-active={pane.id === activePaneId ? "true" : undefined}>
                          <span className="ws-rail-item-mark">
                            {pane.runner ? <RunnerMark runner={pane.runner} /> : <KindIcon kind={pane.kind} size={14} className="ws-rail-item-icon" />}
                          </span>
                          <RenameField
                            name={pane.title}
                            label={`Pane name ${pane.title}`}
                            onCommit={(next) => {
                              onPaneAction?.("rename", pane, workspace, next);
                              setRenamingPaneId(null);
                            }}
                            onCancel={() => setRenamingPaneId(null)}
                          />
                        </div>
                      ) : (
                        <div key={pane.id} className="ws-rail-row" data-menu-open={paneMenu?.pane.id === pane.id ? "" : undefined}>
                        <button
                          type="button"
                          className="ws-rail-item"
                          data-kind={pane.kind}
                          data-activity={pane.activity}
                          data-done={justDone.has(pane.id) ? "true" : undefined}
                          data-unread={pane.unread ? "true" : undefined}
                          data-active={pane.id === activePaneId ? "true" : undefined}
                          aria-current={pane.id === activePaneId ? "true" : undefined}
                          style={{ ["--ws-row-index" as string]: Math.min(index, 8) }}
                          /* One line means the rest of what identifies a pane has to live somewhere:
                             here. Hovering a row tells you the folder and the command. */
                          title={pane.meta ? `${pane.title} — ${pane.meta}` : pane.title}
                          onClick={() => onSelectPane(pane, workspace)}
                          {...dragHandlers(pane, workspace)}
                          onContextMenu={(event) => {
                            if (!onPaneAction) return;
                            event.preventDefault();
                            setPaneMenu({ pane, workspace, x: event.clientX, y: event.clientY });
                          }}
                          onKeyDown={(event) => {
                            // The menu key, or ⇧F10: the keyboard's right-click.
                            if (!onPaneAction || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
                            event.preventDefault();
                            const rect = event.currentTarget.getBoundingClientRect();
                            setPaneMenu({ pane, workspace, x: rect.right - 24, y: rect.bottom + 4 });
                          }}
                        >
                          {/* The agent's own logo, in its brand colour, or the kind glyph when no
                              agent runs. No dot on its corner: a halo turns around the mark while
                              working and the mark dims at rest (CSS); line two says the rest. */}
                          <span className="ws-rail-item-mark">
                            {pane.runner ? (
                              <RunnerMark runner={pane.runner} />
                            ) : (
                              <KindIcon kind={pane.kind} size={14} className="ws-rail-item-icon" />
                            )}
                          </span>
                          <span className="ws-rail-item-body">
                            <span className="ws-rail-item-title">{pane.title}</span>
                            <span className="ws-rail-item-meta">
                              {pane.runner?.label || pane.meta ? (
                                <span className="ws-rail-item-who">{pane.runner?.label || pane.meta}</span>
                              ) : null}
                              {pane.activity === "needs-you" || pane.activity === "working" || pane.activity === "failed" ? (
                                <ActivityBadge
                                  activity={pane.activity}
                                  // Working's age sits at the right end, beside its ring.
                                  since={pane.activity === "working" ? undefined : pane.activitySince}
                                  className="ws-rail-item-activity"
                                />
                              ) : pane.unread ? (
                                <UnreadLabel since={pane.unreadSince} />
                              ) : typeof pane.badge === "number" ? (
                                <span className="ws-rail-count" data-quiet="true">{pane.badge}</span>
                              ) : null}
                            </span>
                          </span>
                          {/* The status slot (mockups/rail-dither-done.html, X): a dither ring and the
                              age while working, which collapses into the "done" dot in place. Kept
                              mounted through `justDone`, so the hand-over from working always animates. */}
                          {pane.activity === "working" || pane.unread || justDone.has(pane.id) ? (
                            <span className="ws-rail-item-status">
                              {pane.activity === "working" ? <WorkingAge since={pane.activitySince} /> : null}
                              <DitherStatus state={pane.activity === "working" ? "working" : pane.unread ? "done" : "settle"} />
                            </span>
                          ) : null}
                        </button>
                        {onPaneAction && railPaneActions(pane).length ? (
                          <button
                            type="button"
                            className="ws-rail-row-more"
                            aria-label={`Actions for ${pane.title}`}
                            aria-haspopup="menu"
                            aria-expanded={paneMenu?.pane.id === pane.id}
                            onClick={(event) => {
                              const rect = event.currentTarget.getBoundingClientRect();
                              setPaneMenu({ pane, workspace, x: rect.right - 24, y: rect.bottom + 4 });
                            }}
                          >
                            <Ellipsis size={14} strokeWidth={1.75} aria-hidden />
                          </button>
                        ) : null}
                        </div>
                      )
  );

  return (
    <nav ref={navRef} className="ws-card ws-rail" aria-label={sectionSlot ? "Sidebar" : "Workspaces"}>
      {/* The window's own nav rows — Tasks today — above the list this rail is named for. That
          is `bb`'s sidebar shape: what the window can show, then what it is showing. */}
      {/* A section (Automations, today) takes the nav rows' and the list's place: one sidebar,
          one context. Its own back row is the way out. The list is HIDDEN, not unmounted, so
          going back shows the same rows at once — rebuilding them from nothing was the blink. */}
      {sectionSlot}
      <div
        className="ws-rail-main"
        data-enter={returned ? "back" : undefined}
        hidden={Boolean(sectionSlot)}
        inert={Boolean(sectionSlot)}
      >
        {navSlot ? <div className="ws-rail-nav">{navSlot}</div> : null}
        <h2 className="sr-only">Workspaces</h2>
        {/* Chat's search row (`.ws-cmd-search`): the line a bare "Workspaces" title used to take
            now finds a pane, and the + beside it adds a workspace. */}
        <div className="ws-cmd-search">
          <Search size={14} strokeWidth={1.75} aria-hidden />
          <input
            type="search"
            value={query}
            placeholder="Search panes"
            aria-label="Search panes"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                listRef.current?.querySelector<HTMLElement>(".ws-rail-item")?.focus();
              } else if (event.key === "Escape" && query) {
                setQuery("");
              }
            }}
          />
          <button type="button" className="ws-cmd-new" onClick={onAddWorkspace} aria-label="Add workspace" title="Add workspace">
            <Plus size={14} strokeWidth={2} aria-hidden />
          </button>
        </div>

        <div className="ws-rail-list" ref={listRef}>
          {needle && !workspaces.some((workspace) => matchingWorkspace(workspace, needle)) ? (
            <p className="ws-cmd-empty">No pane matches “{query.trim()}”</p>
          ) : null}
          {railSections(workspaces).map((section) => ({
            ...section,
            workspaces: needle
              ? section.workspaces.flatMap((workspace) => matchingWorkspace(workspace, needle) ?? [])
              : section.workspaces,
          })).filter((section) => section.workspaces.length > 0).map((section) => (
          <div key={section.label || "all"} className="ws-rail-sectioned">
          {section.label ? <p className="ws-rail-section">{section.label}</p> : null}
          {section.workspaces.map((workspace) => {
            // A search shows every match, so a folded folder opens while it is on.
            const open = Boolean(needle) || openWorkspaceIds.includes(workspace.id);
            const renaming = renamingId === workspace.id;
            return (
              <div className="ws-rail-folder" key={workspace.id} data-open={open ? "true" : undefined}>
                {/* A row, not a button: the disclosure and the add trigger are siblings. Nesting one
                    interactive element inside another is invalid HTML and makes the row ambiguous
                    to a screen reader — and to a test asking for "the pocket button". */}
                <div
                  className="ws-rail-group"
                  data-open={open ? "true" : undefined}
                  data-active={workspace.active ? "true" : undefined}
                >
                  <button
                    type="button"
                    className="ws-rail-group-chevron"
                    aria-expanded={open}
                    aria-label={`${open ? "Collapse" : "Expand"} ${workspace.name}`}
                    onClick={() => onToggleWorkspace(workspace.id)}
                  >
                    <ChevronRight size={14} strokeWidth={2} />
                  </button>

                  {renaming ? (
                    <RenameField
                      name={workspace.name}
                      onCommit={(next) => {
                        onRenameWorkspace?.(workspace.id, next);
                        setRenamingId(null);
                      }}
                      onCancel={() => setRenamingId(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="ws-rail-group-name"
                      /* Showing a folder is the row's job; the chevron beside it only expands. That
                         split is what lets two folders stay open at once without one of them
                         hijacking the screen. */
                      onClick={() => (onOpenWorkspace ?? onToggleWorkspace)(workspace.id)}
                      onDoubleClick={() => onRenameWorkspace && setRenamingId(workspace.id)}
                      title={workspace.name}
                    >
                      {workspace.name}
                    </button>
                  )}

                  {/* What the row says at rest — pin, asks, live count — in one group, so hover can
                      trade the whole group for the actions in the same place instead of squeezing
                      the name between both. */}
                  <span className="ws-rail-group-meta">
                    {/* A folded folder still has to be able to say someone is waiting on a human —
                        otherwise the one state worth acting on is the one a fold can hide. It sits
                        before the live count because it outranks it. */}
                    {workspace.needsYouCount ? (
                      <span
                        className="ws-rail-count"
                        data-tone="ask"
                        title={`${workspace.needsYouCount} pane${workspace.needsYouCount === 1 ? "" : "s"} waiting for you`}
                      >
                        {workspace.needsYouCount}
                      </span>
                    ) : null}
                    {workspace.unreadCount && !open ? <StatusCount tone="result" count={workspace.unreadCount} what="finished, not opened" /> : null}
                    {/* An open folder lists its rows, which already say these two. */}
                    {workspace.workingCount && !open ? (
                      <span
                        className="ws-rail-group-working"
                        role="img"
                        aria-label={`${workspace.workingCount} working`}
                        title={`${workspace.workingCount} working`}
                      />
                    ) : null}
                    {workspace.liveCount && !open ? (
                      <span className="ws-rail-count" title={`${workspace.liveCount} running`}>
                        {workspace.liveCount}
                      </span>
                    ) : null}
                  </span>

                  <span className="ws-rail-group-actions">
                    {onRenameWorkspace ? (
                      <button
                        type="button"
                        className="ws-rail-group-action"
                        aria-label={`Rename ${workspace.name}`}
                        onClick={() => setRenamingId(workspace.id)}
                      >
                        <Pencil size={13} strokeWidth={1.75} />
                      </button>
                    ) : null}
                    {onTogglePin ? (
                      <button
                        type="button"
                        className="ws-rail-group-action"
                        data-on={workspace.pinned ? "true" : undefined}
                        aria-pressed={Boolean(workspace.pinned)}
                        aria-label={`${workspace.pinned ? "Unpin" : "Pin"} ${workspace.name}`}
                        onClick={() => onTogglePin(workspace.id)}
                      >
                        {workspace.pinned ? <PinOff size={13} strokeWidth={1.75} /> : <Pin size={13} strokeWidth={1.75} />}
                      </button>
                    ) : null}
                    {/* A new pane on its own, like a browser's new tab: no group needed. */}
                    <button
                      type="button"
                      className="ws-rail-group-action"
                      aria-label={`Add pane in ${workspace.name}`}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        onAddPane?.(workspace, { x: rect.left - 8, y: rect.bottom + 6 });
                      }}
                    >
                      <Plus size={14} strokeWidth={1.75} />
                    </button>
                  </span>
                </div>

                {/*
                  The panes stay in the DOM while the folder is collapsed so the fold can ANIMATE —
                  a list that is unmounted has no height to travel from. `inert` plus `aria-hidden`
                  is what keeps a collapsed folder out of the tab order and out of a screen reader,
                  which is the part that would otherwise be quietly lost.
                */}
                <div className="ws-rail-panes" aria-hidden={!open} inert={!open}>
                  <div className="ws-rail-panes-inner" {...dropTarget(LOOSE_DROP, workspace)}>
                    {workspace.frames?.map((frame) => {
                      const frameName = frame.split ? "split" : frame.name;
                      const menuKeys = (event: React.KeyboardEvent<HTMLElement>) => {
                        // The menu key, or ⇧F10: the keyboard's right-click.
                        if (!hasFrameMenu || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
                        event.preventDefault();
                        const rect = event.currentTarget.getBoundingClientRect();
                        setFrameMenu({ frame, workspace, x: rect.right - 24, y: rect.bottom + 4 });
                      };
                      const menuOnRightClick = (event: React.MouseEvent) => {
                        if (!hasFrameMenu || (event.target as HTMLElement).closest(".ws-rail-row:not(.ws-rail-card-head-row)")) return;
                        event.preventDefault();
                        setFrameMenu({ frame, workspace, x: event.clientX, y: event.clientY });
                      };
                      const menuButton = hasFrameMenu ? (
                        <button
                          type="button"
                          className="ws-rail-row-more"
                          aria-label={`Actions for ${frameName}`}
                          aria-haspopup="menu"
                          aria-expanded={frameMenu?.frame.id === frame.id}
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            setFrameMenu({ frame, workspace, x: rect.right - 24, y: rect.bottom + 4 });
                          }}
                        >
                          <Ellipsis size={14} strokeWidth={1.75} aria-hidden />
                        </button>
                      ) : null;
                      if (renamingFrameId === frame.id) {
                        return (
                          <div key={frame.id} className="ws-rail-item ws-rail-frame" data-color={frame.color}>
                            <span className="ws-rail-frame-dot" aria-hidden />
                            <RenameField
                              name={frame.name}
                              label={frame.split ? "Name this split" : `Group name ${frame.name}`}
                              onCommit={(next) => {
                                onRenameFrame?.(workspace.id, frame.id, next);
                                setRenamingFrameId(null);
                              }}
                              onCancel={() => setRenamingFrameId(null)}
                            />
                          </div>
                        );
                      }
                      if (frame.split) {
                        // A split lists its panes as ordinary rows, like loose panes: full names, no card,
                        // no colour, no name, no line (mockups/rail-split-vertical.html, A without its line).
                        return (
                          <div
                            key={frame.id}
                            className="ws-rail-split"
                            role="group"
                            aria-label={`Split: ${frame.panes.map((pane) => pane.title).join(", ")}`}
                            data-active={frame.id === activeFrameId ? "true" : undefined}
                            {...dropTarget(frame.id, workspace)}
                          >
                            {frame.panes.map((pane, index) => paneRow(pane, workspace, index))}
                          </div>
                        );
                      }
                      const folded = foldedFrames.has(frame.id);
                      // A named group is a card around its panes (Dia): the region says what belongs together.
                      return (
                        <div
                          key={frame.id}
                          className="ws-rail-card ws-rail-frame"
                          data-color={frame.color}
                          data-active={frame.id === activeFrameId ? "true" : undefined}
                          data-folded={folded ? "true" : undefined}
                          onContextMenu={menuOnRightClick}
                          {...dropTarget(frame.id, workspace)}
                        >
                          <div className="ws-rail-row ws-rail-card-head-row" data-menu-open={frameMenu?.frame.id === frame.id ? "" : undefined}>
                            <button
                              type="button"
                              className="ws-rail-item ws-rail-card-head"
                              aria-current={frame.id === activeFrameId ? "true" : undefined}
                              aria-expanded={!folded}
                              aria-label={frameLabel(frame)}
                              data-status={frame.status}
                              onClick={() => toggleFold(frame.id)}
                              onKeyDown={menuKeys}
                            >
                              {/* The whole head folds the card (Dia); on hover the dot turns into the chevron that says so. */}
                              <span className="ws-rail-card-toggle" aria-hidden>
                                <span className="ws-rail-frame-dot" />
                                <ChevronRight size={13} strokeWidth={2.25} className="ws-rail-card-chevron" />
                              </span>
                              <span className="ws-rail-item-title" onDoubleClick={onRenameFrame ? () => setRenamingFrameId(frame.id) : undefined}>
                                {frame.name}
                              </span>
                              {/* Folded, the card still says what waits inside: the asks, failures and unread results. */}
                              {folded ? <FrameCounts panes={frame.panes} /> : null}
                              {/* Folded, the card still says who is inside: marks with their halos (they fade in). */}
                              {frame.marks.length ? (
                                <span className="ws-rail-frame-logos" aria-hidden>
                                  {frame.marks.map((pane) => (
                                    <span key={pane.id} className="ws-rail-item-mark" data-activity={pane.activity}>
                                      {pane.runner ? <RunnerMark runner={pane.runner} /> : <KindIcon kind={pane.kind} size={12} className="ws-rail-item-icon" />}
                                    </span>
                                  ))}
                                  {frame.moreCount ? <span className="ws-rail-frame-more">+{frame.moreCount}</span> : null}
                                </span>
                              ) : null}
                            </button>
                            {menuButton}
                          </div>
                          {/* Kept mounted so the fold can animate, like a folder's rows; inert while folded. */}
                          <div className="ws-rail-card-body" aria-hidden={folded} inert={folded}>
                            <div className="ws-rail-card-body-inner">
                              {frame.panes.map((pane, index) => paneRow(pane, workspace, index))}
                              {frame.panes.length === 0 ? <p className="ws-rail-card-empty">Empty — move a pane here</p> : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {workspace.panes.length === 0 && !workspace.frames?.length ? (
                      /* One quiet row in the rows' own shape: the folder being empty is what the
                         row says, and opening a pane is what it does. */
                      <button
                        type="button"
                        className="ws-rail-item ws-rail-item--empty"
                        title="Nothing is running in this folder"
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          onAddPane?.(workspace, { x: rect.left, y: rect.bottom + 6 });
                        }}
                      >
                        <span className="ws-rail-item-mark">
                          <Plus size={13} strokeWidth={1.75} className="ws-rail-item-icon" />
                        </span>
                        <span className="ws-rail-item-title">Open a pane</span>
                      </button>
                    ) : (
                      // With Frames, a framed pane is reached through its Frame row: only loose panes list.
                      (workspace.loosePanes ?? workspace.panes).map((pane, index) => paneRow(pane, workspace, index))
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          </div>
          ))}
        </div>
      </div>

      <RailFooter onOpenSettings={() => openSettings({ from: "code-rail" })} />
      {paneMenu ? (
        <RailPaneMenu
          pane={paneMenu.pane}
          folder={paneMenu.workspace.name}
          at={paneMenu}
          onAct={(action) => actOnPane(action, paneMenu.pane, paneMenu.workspace)}
          onClose={closePaneMenu}
          {...regroupProps(paneMenu.pane, paneMenu.workspace)}
        />
      ) : null}
      {frameMenu ? (
        <RailFrameMenu
          frame={frameMenu.frame}
          folder={frameMenu.workspace.name}
          at={frameMenu}
          container={navRef.current?.closest(".ws-shell") ?? null}
          onAct={(action) => actOnFrame(action, frameMenu.frame, frameMenu.workspace)}
          onClose={closeFrameMenu}
        />
      ) : null}
    </nav>
  );
}

/** "done · 2m": a finished turn nobody opened, and how long it has waited. */
function UnreadLabel({ since }: { since?: number }) {
  const now = useAgeNow(typeof since === "number");
  const age = now !== null && since !== undefined ? formatPaneActivityAge(now - since) : null;
  const text = age ? `done · ${age}` : "done";
  return (
    <span className="ws-rail-unread" title={`Turn finished${age ? ` ${age} ago` : ""} — not opened yet`}>
      {text}
    </span>
  );
}

/** "4m" beside the working ring; nothing under a minute. */
function WorkingAge({ since }: { since?: number }) {
  const now = useAgeNow(typeof since === "number");
  const age = now !== null && since !== undefined ? formatPaneActivityAge(now - since) : null;
  return age ? <span className="ws-rail-item-age">{age}</span> : null;
}

/** A lit dot and a number in one state's hue: what a collapsed folder or group still has to say. */
function StatusCount({ tone, count, what }: { tone: "ask" | "warn" | "result"; count: number; what: string }) {
  const label = `${count} ${what}`;
  return (
    <span className="ws-rail-count" data-tone={tone} title={label} aria-label={label}>
      {count}
    </span>
  );
}

function FrameCounts({ panes }: { panes: RailPane[] }) {
  const asks = panes.filter((pane) => pane.activity === "needs-you").length;
  const failed = panes.filter((pane) => pane.activity === "failed").length;
  const unread = panes.filter((pane) => pane.unread).length;
  if (!asks && !failed && !unread) return null;
  return (
    <span className="ws-rail-frame-counts">
      {asks ? <StatusCount tone="ask" count={asks} what="waiting for you" /> : null}
      {failed ? <StatusCount tone="warn" count={failed} what="failed" /> : null}
      {unread ? <StatusCount tone="result" count={unread} what="finished, not opened" /> : null}
    </span>
  );
}


const FRAME_STATUS_LABEL: Record<RailFrame["status"], string | null> = {
  "needs-you": "Needs you",
  failed: "Failed",
  working: "Working",
  unread: "New result",
  idle: null,
};

/** What a screen reader hears: name, status (when there is one) and count. */
function frameLabel(frame: RailFrame): string {
  return [frame.name, FRAME_STATUS_LABEL[frame.status], paneCountLabel(frame.paneCount)].filter(Boolean).join(", ");
}

/** The folder as a search shows it: all of it when its name matches, else only the matching rows. */
function matchingWorkspace(workspace: RailWorkspace, needle: string): RailWorkspace | null {
  if (workspace.name.toLowerCase().includes(needle)) return workspace;
  const matches = (pane: RailPane) => `${pane.title} ${pane.meta} ${pane.runner?.label ?? ""}`.toLowerCase().includes(needle);
  const panes = workspace.panes.filter(matches);
  // A Frame matches by its own name or by a member's; the rail then shows it as one row.
  const frames = workspace.frames?.filter((frame) =>
    frame.name.toLowerCase().includes(needle) || panes.some((pane) => frame.paneIds.includes(pane.id)),
  );
  const loosePanes = workspace.loosePanes?.filter(matches);
  if (!panes.length && !frames?.length) return null;
  return { ...workspace, panes, ...(workspace.frames ? { frames, loosePanes } : {}) };
}

/**
 * Renaming happens in place, on the row itself.
 *
 * A dialog for one short string is a dialog that has to be dismissed; the row already shows the
 * name in the right place and at the right width. Enter and blur commit, Escape restores — the
 * three keys anyone tries. An empty or unchanged name is simply not a rename, which is why the
 * commit is filtered here rather than leaving the engine to guess.
 */
function RenameField({
  name,
  label,
  onCommit,
  onCancel,
}: {
  name: string;
  label?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(name);
  // Selecting the whole name is what makes "type over it" work, which is what a rename usually is.
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = () => {
    const next = value.trim();
    if (!next || next === name) {
      onCancel();
      return;
    }
    onCommit(next);
  };

  return (
    <input
      ref={inputRef}
      className="ws-rail-group-input"
      aria-label={label ?? `Workspace name ${name}`}
      value={value}
      autoFocus
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
        // The rail's own shortcuts must not fire while someone is typing a folder name.
        event.stopPropagation();
      }}
    />
  );
}
