"use client";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Folder, LayoutGrid, LogOut, Plus } from "lucide-react";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";
import { useDockedOccluder } from "../hooks/useDockedOccluder";
import { headTrimProjectName } from "../services/project-label";

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function displayNameFor(project: Pick<CodeCanvasProjectMeta, "alias" | "rootDir">): string {
  return project.alias?.trim() || basename(project.rootDir);
}

interface Props {
  projects: CodeCanvasProjectMeta[];
  activeProjectId: string | null;
  /** Fallback label (the resolved project path) used when no project matches activeProjectId. */
  fallbackName?: string | null;
  onSelectProject: (projectId: string) => void;
  onOpenCanvases: () => void;
  onNewProject: () => void;
  onCloseProject: () => void;
  /** Shows a neutral boot/open label while project metadata is still being restored. */
  restoring?: boolean;
  /** Which way the dropdown opens. "down" (default) suits the top bar; "up" suits the docked
   *  command bar at the bottom of the viewport, where a downward menu would fall off-screen. */
  placement?: "down" | "up";
}

/**
 * Project switcher that replaces the static app label in the canvas top bar: the trigger shows the
 * active project's name; the dropdown lists every project in the codebase (active one checked) plus
 * actions to browse all, add a new project, or close the current one.
 */
export function CanvasProjectMenu({
  projects,
  activeProjectId,
  fallbackName,
  onSelectProject,
  onOpenCanvases,
  onNewProject,
  onCloseProject,
  restoring = false,
  placement = "down",
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // The dropdown floats over the canvas, where a browser node's native child
  // WebView paints above the DOM and would clip the menu. Register it as a docked
  // occluder while open: the browser clips its native bounds around the menu and
  // stays *live* — no full-WebView park / "Paused" blackout.
  //   • edge: anchor to the menu's docking edge ("up" opens from the bottom bar →
  //     "bottom") so the clip is a clean, deterministic full-edge cut, never a
  //     corner rect whose ambiguous cut leaves the menu half-covered.
  //   • force: apply even when the cut exceeds the area-fraction cap (a menu over
  //     a large browser would otherwise be ignored and stay covered).
  useDockedOccluder(dropdownRef, open, { force: true, edge: placement === "up" ? "bottom" : "top" });

  const active = projects.find((project) => project.id === activeProjectId) ?? null;
  const triggerName = restoring
    ? "Restoring…"
    : active
      ? displayNameFor(active)
      : fallbackName
        ? basename(fallbackName)
        : "No project";
  // The chip trims from the HEAD, not the tail: a project slug's identifying part is its
  // end (e.g. "…claude-agent-teams"), so a tail-ellipsis truncation would keep the half
  // that identifies nothing. The full, untrimmed name is still reachable via `title` below.
  const triggerDisplayName = headTrimProjectName(triggerName);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="canvas-project-menu" ref={ref}>
      <button
        type="button"
        className="canvas-project-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch project"
        aria-busy={restoring || undefined}
        title={restoring ? "Restoring canvas" : active?.rootDir ?? fallbackName ?? triggerName}
        onClick={() => setOpen((value) => !value)}
      >
        {/* Name leads, chevron trails: a leading chevron reads as a bullet, not a disclosure
            control, and the name is the informative half of this trigger. */}
        <span className="canvas-project-trigger-name">{triggerDisplayName}</span>
        <ChevronDown size={12} strokeWidth={2.25} className="canvas-project-trigger-chev" data-open={open || undefined} aria-hidden />
      </button>

      {open && (
        <div
          ref={dropdownRef}
          className={`canvas-project-dropdown${placement === "up" ? " canvas-project-dropdown--up" : ""}`}
          role="menu"
          aria-label="Projects"
        >
          {projects.length > 0 && (
            <div className="canvas-project-group">
              {projects.map((project) => {
                const isActive = project.id === activeProjectId;
                return (
                  <button
                    key={project.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    className="canvas-project-item"
                    data-active={isActive || undefined}
                    title={project.rootDir}
                    onClick={() => run(() => onSelectProject(project.id))}
                  >
                    <span className="canvas-project-item-icon">
                      {isActive ? <Check size={13} strokeWidth={2.25} /> : <Folder size={13} strokeWidth={1.9} />}
                    </span>
                    <span className="canvas-project-item-name">{displayNameFor(project)}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="canvas-project-sep" role="separator" />

          <button type="button" role="menuitem" className="canvas-project-action" onClick={() => run(onOpenCanvases)}>
            <LayoutGrid size={13} strokeWidth={1.9} aria-hidden />
            <span>All projects…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="canvas-project-action canvas-project-action--primary"
            onClick={() => run(onNewProject)}
          >
            <Plus size={13} strokeWidth={2.25} aria-hidden />
            <span>New project…</span>
          </button>
          {active && (
            <button type="button" role="menuitem" className="canvas-project-action" onClick={() => run(onCloseProject)}>
              <LogOut size={13} strokeWidth={1.9} aria-hidden />
              <span>Close project</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
