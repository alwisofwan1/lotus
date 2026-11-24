"use client";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import Link from "next/link";
import { MoreHorizontal, PanelRight } from "lucide-react";
import { describeDockWaiting } from "../hooks/useCanvasDock";
import { useCanvasOcclusionLock } from "../hooks/useCanvasOcclusionLock";
import type { CanvasAppNav } from "./CanvasControlCluster";
import { CanvasFrameSwitcher } from "./CanvasFrameSwitcher";
import { CanvasProjectMenu } from "./CanvasProjectMenu";

interface Props {
  nav: CanvasAppNav & { fallbackName?: string | null };
  frameSwitcher?: ComponentProps<typeof CanvasFrameSwitcher>;
  /** Beside the project name (the remote machine chip). */
  projectAdornment?: ReactNode;
  /**
   * Where CanvasCornerControls portals the Memory / Sessions popovers and their menu rows. Portals,
   * not lifted state: those hooks already live there, so only the drawing moves into the bar.
   */
  cornerSlots?: { bar: (el: HTMLElement | null) => void; menu: (el: HTMLElement | null) => void };
}

/**
 * The navigation half of the docked command bar: [project] [1 ▾] [Dock n] [⋯]. The Top Bar keeps the
 * full CanvasControlCluster; docked into the bar it is folded down so the prompt stays the loudest thing.
 * The Dock stays a button with its waiting count as plain text — what waits is the one thing here you
 * act on, so it is not hidden behind ⋯. Overview, Settings and Home live in the ⋯ menu as text rows.
 */
export function CanvasDockedNav({ nav, frameSwitcher, projectAdornment, cornerSlots }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  useCanvasOcclusionLock(open, "docked-nav-menu");

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [open]);

  // Any row closes the menu, including the corner rows (Memory, Sessions) portalled into it. Those
  // are React children of CanvasCornerControls, so a React onClick here never sees their clicks —
  // React bubbles through the component tree, not the DOM. A native listener does see them.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    const close = (e: MouseEvent) => {
      if ((e.target as Element).closest('[role^="menuitem"]')) setOpen(false);
    };
    menu.addEventListener("click", close);
    return () => menu.removeEventListener("click", close);
  }, [open]);

  const waiting = nav.dockWaiting ?? [];
  const total = waiting.reduce((sum, item) => sum + item.count, 0);
  const run = (action?: () => void) => () => {
    setOpen(false);
    action?.();
  };

  return (
    <div className="canvas-docked-nav">
      <CanvasProjectMenu
        projects={nav.projects}
        activeProjectId={nav.activeProjectId}
        fallbackName={nav.fallbackName}
        onSelectProject={nav.onSelectProject}
        onOpenCanvases={nav.onOpenCanvases}
        onNewProject={nav.onNewProject}
        onCloseProject={nav.onCloseProject}
        placement="up"
      />
      {projectAdornment}
      {frameSwitcher ? <CanvasFrameSwitcher {...frameSwitcher} compact /> : null}
      {cornerSlots ? <span ref={cornerSlots.bar} className="canvas-docked-corner" /> : null}
      {nav.onToggleDock ? (
        <button
          type="button"
          className="canvas-nl-icon canvas-cc-btn canvas-docked-dock"
          aria-label={`${nav.dockOpen ? "Hide" : "Show"} the Dock${total > 0 ? `, ${total} waiting` : ""}`}
          title={`Dock${total > 0 ? ` · ${describeDockWaiting(waiting)}` : ""}${nav.dockChord ? ` · ${nav.dockChord}` : ""}`}
          aria-pressed={!!nav.dockOpen}
          data-active={nav.dockOpen ? "true" : undefined}
          onClick={nav.onToggleDock}
        >
          <PanelRight size={15} strokeWidth={1.75} />
          {total > 0 ? <span className="canvas-docked-dock-count">{total > 99 ? "99+" : total}</span> : null}
        </button>
      ) : null}
      <span
        ref={rootRef}
        className="canvas-frame-overflow"
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) setOpen(false);
        }}
      >
        <button
          type="button"
          className="canvas-nl-icon canvas-cc-btn"
          aria-label="More"
          title="More"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <MoreHorizontal size={16} strokeWidth={1.75} />
        </button>
        {open ? (
          <div ref={menuRef} className="canvas-frame-menu" role="menu">
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={!!nav.frameOverviewOpen}
              className="canvas-frame-menu-item"
              onClick={run(nav.onToggleFrameOverview)}
            >
              <span className="canvas-frame-menu-name">Frame overview</span>
            </button>
            <span className="canvas-docked-nav-sep" aria-hidden />
            {cornerSlots ? <div ref={cornerSlots.menu} role="none" className="canvas-docked-nav-slot" /> : null}
            <span className="canvas-docked-nav-sep" aria-hidden />
            <button type="button" role="menuitem" className="canvas-frame-menu-item" onClick={run(nav.onOpenSettings)}>
              <span className="canvas-frame-menu-name">Canvas settings</span>
            </button>
            <Link href="/" role="menuitem" className="canvas-frame-menu-item" onClick={() => setOpen(false)}>
              <span className="canvas-frame-menu-name">Lotus Home</span>
            </Link>
          </div>
        ) : null}
      </span>
    </div>
  );
}
