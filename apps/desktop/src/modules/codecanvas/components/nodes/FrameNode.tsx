"use client";
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { NodeResizer, useStore, type NodeProps } from "@xyflow/react";
import { MoreHorizontal, Plus } from "lucide-react";
import { useFrameDropTarget } from "../../services/canvas-frame-drop-store";
import { canvasFrameEditStore, useFrameEditRequest } from "../../services/canvas-frame-edit-store";
import { frameColorCss, frameColorOf } from "../../services/canvas-frame-palette";
import { frameChromeForced } from "../../services/canvas-frame-space";
import { overviewTitleScale } from "../../services/canvas-frame-overview";
import { useFrameOverviewLabel, useFrameOverviewMode, useFrameOverviewNeedsYou } from "../../services/canvas-frame-overview-store";
import { useFrameActions } from "./frame-actions-context";
import { FrameTabMenu } from "./FrameTabMenu";

/**
 * A Frame: a titled region painted behind its members (array order). The node wrapper is
 * pointer-transparent (canvas-node-factory), so the empty inside passes clicks and drags to the
 * canvas (pan, marquee) and to the members on top. Only the title tab and the four border strips
 * re-enable the pointer: that is how a Frame is selected and moved.
 *
 * Chrome (decision 32): zoomed in, none of this is drawn (CanvasFrameChromeMarker + the CSS); it shows
 * zoomed out, in the Overview, as a drop target, and while renaming or with a menu open.
 *
 * Overview (decision 44): the tab gives way to a clean header card above the box (colour dot, name, "01 · 4
 * nodes" or "needs you"), counter-scaled so it reads at the Overview zoom and capped to the Frame's own width so
 * it never touches its neighbours; an empty Frame shows a calm "Empty Frame" state. Hover lifts the Frame with
 * an accent ring (the others are dimmed by the Overview layer).
 *
 * Look (decision 7, mockups in plans/codecanvas-frames/mockup): a thin faint border and a faint
 * tint in the Frame's colour; the strong border only on hover, selected or while it is the drop
 * target. Colour comes from the --canvas-frame-* theme tokens (styles/canvas/canvas-frame-node.css).
 */
const MIN_W = 160;
const MIN_H = 100;

type MenuKind = "add" | "more";

export const FrameNode = memo(function FrameNode({ id, data, selected, width }: NodeProps) {
  const title = typeof data.title === "string" ? data.title : "";
  const colorId = typeof data.colorId === "string" ? data.colorId : undefined;
  const actions = useFrameActions();
  const armedByDrop = useFrameDropTarget(id);
  const overview = useFrameOverviewMode(id);
  const overviewLabel = useFrameOverviewLabel(id);
  const needsYou = useFrameOverviewNeedsYou(id);
  const editRequested = useFrameEditRequest(id);
  const memberCount = useStore((s) => {
    let count = 0;
    for (const n of s.nodeLookup.values()) if ((n.data as { frameId?: unknown } | undefined)?.frameId === id) count += 1;
    return count;
  });
  // Selector returns 1 outside the overview so panning/zooming normally never re-renders a Frame.
  const zoom = useStore((s) => (overview === "off" ? 1 : s.transform[2]));
  const minZoom = useStore((s) => s.minZoom);
  const focused = overview === "focus";
  const armed = armedByDrop;
  const inOverview = overview !== "off";
  // Counter-scale the card around its bottom-left corner so it keeps a readable on-screen size.
  const cardScale = inOverview ? overviewTitleScale(zoom, minZoom) : 1;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<{ kind: MenuKind; anchor: DOMRect } | null>(null);

  const startEditing = useCallback(() => {
    setDraft(title);
    setEditing(true);
  }, [title]);

  // A request from Cmd+G / F2 opens the title for typing, then clears so it fires once.
  useEffect(() => {
    if (!editRequested) return;
    canvasFrameEditStore.request(null);
    startEditing();
  }, [editRequested, startEditing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== title) actions.rename(id, draft);
  };
  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // typing must never reach canvas shortcuts
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") setEditing(false);
  };

  const openMenu = (kind: MenuKind) => (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setMenu({ kind, anchor: e.currentTarget.getBoundingClientRect() });
  };
  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <div
      className="canvas-frame-node"
      data-drop-target={armed ? "true" : undefined}
      data-overview={inOverview ? overview : undefined}
      data-empty={inOverview && memberCount === 0 ? "true" : undefined}
      data-chrome-force={frameChromeForced({ overview: overview !== "off", dropTarget: armedByDrop, editing, menuOpen: menu !== null }) ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-needs-you={needsYou ? "true" : undefined}
      data-frame-color={frameColorOf(colorId).id}
      style={{ "--frame-color": frameColorCss(colorId), ...(inOverview ? { "--ov-zoom": zoom } : null) } as React.CSSProperties}
    >
      <NodeResizer
        minWidth={MIN_W}
        minHeight={MIN_H}
        isVisible={Boolean(selected)}
        handleClassName="canvas-frame-resize-handle"
        lineClassName="canvas-frame-resize-line"
      />
      <div className="canvas-frame-edge canvas-frame-edge--top" />
      <div className="canvas-frame-edge canvas-frame-edge--bottom" />
      <div className="canvas-frame-edge canvas-frame-edge--left" />
      <div className="canvas-frame-edge canvas-frame-edge--right" />
      {inOverview ? (
        <>
          <div
            className="canvas-frame-overview-card"
            data-testid="frame-overview-card"
            style={{
              transform: `scale(${cardScale})`,
              bottom: `calc(100% + ${8 / Math.max(zoom, 0.01)}px)`,
              maxWidth: width ? width / cardScale : undefined,
            }}
          >
            <i className="canvas-frame-overview-card-dot" aria-hidden="true" />
            <span className="canvas-frame-overview-card-title">{title || "Frame"}</span>
            {overviewLabel ? <span className="canvas-frame-overview-card-label">{overviewLabel}</span> : null}
            {focused ? (
              <span data-testid="frame-overview-enter" className="canvas-frame-overview-card-enter">
                Enter ↵
              </span>
            ) : null}
          </div>
          {memberCount === 0 ? (
            <div className="canvas-frame-overview-empty" data-testid="frame-overview-empty" style={{ transform: `translate(-50%, -50%) scale(${cardScale})` }}>
              Empty Frame
            </div>
          ) : null}
        </>
      ) : (
      <div
        className="canvas-frame-tab"
        data-testid="frame-title-tab"
        tabIndex={0}
        role="group"
        aria-label={`Frame ${title || ""}. Enter or F2 to rename.`}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return; // keys typed in the rename input or tab buttons are theirs
          if (e.key === "Enter" || e.key === "F2") {
            e.preventDefault();
            e.stopPropagation();
            startEditing();
          }
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          startEditing();
        }}
      >
        <i className="canvas-frame-tab-dot" aria-hidden="true" />
        {editing ? (
          <input
            ref={inputRef}
            className="canvas-frame-tab-input nodrag nopan"
            value={draft}
            aria-label="Frame name"
            maxLength={80}
            size={Math.max(8, draft.length + 1)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onInputKeyDown}
            onBlur={commit}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="canvas-frame-tab-title">{title}</span>
        )}
        {!editing ? <span className="canvas-frame-tab-count">{memberCount}</span> : null}
        {!editing ? (
          <span className="canvas-frame-tab-actions">
            <button
              type="button"
              className="canvas-frame-tab-btn nodrag nopan"
              aria-label={`Add to ${title || "Frame"}`}
              aria-haspopup="menu"
              title="Add a terminal or agent here"
              onClick={openMenu("add")}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Plus size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="canvas-frame-tab-btn nodrag nopan"
              aria-label={`${title || "Frame"} menu`}
              aria-haspopup="menu"
              title="Frame menu"
              onClick={openMenu("more")}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <MoreHorizontal size={14} aria-hidden="true" />
            </button>
          </span>
        ) : null}
      </div>
      )}
      {menu ? (
        <FrameTabMenu
          kind={menu.kind}
          anchor={menu.anchor}
          frameId={id}
          colorId={colorId}
          memberCount={memberCount}
          onRename={startEditing}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  );
});
