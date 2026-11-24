"use client";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, FolderOpen, Pencil, Plus, X } from "lucide-react";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";
import { CanvasSphere } from "./CanvasSphere";
import { CanvasGallery } from "./CanvasGallery";
import { useCanvasOcclusionLock } from "../hooks/useCanvasOcclusionLock";

type ViewMode = "sphere" | "gallery" | "grid";

interface Props {
  open: boolean;
  projects: CodeCanvasProjectMeta[];
  activeProjectId: string | null;
  nodeCountsByProject: Map<string, number>;
  onOpen: (projectId: string) => void;
  onCreate: () => void;
  onClose: () => void;
  /** Workspace management (formerly the left sidebar context menu). */
  onRenameProject: (projectId: string, alias: string | null) => void;
  onCopyProjectPath: (projectId: string) => void;
  onCloseProject: (projectId: string) => void;
}

const WS_MENU_W = 188;
const WS_MENU_H = 132;
const WS_MENU_MARGIN = 10;

function wsMenuStyle(x: number, y: number): CSSProperties {
  if (typeof window === "undefined") return { position: "fixed", left: x, top: y };
  return {
    position: "fixed",
    left: Math.max(WS_MENU_MARGIN, Math.min(x + 8, window.innerWidth - WS_MENU_W - WS_MENU_MARGIN)),
    top: Math.max(WS_MENU_MARGIN, Math.min(y - 6, window.innerHeight - WS_MENU_H - WS_MENU_MARGIN)),
    zIndex: 9999,
  };
}

function CanvasWorkspaceMenu({
  project, position, onCloseMenu, onOpen, onRename, onCopyPath, onCloseProject,
}: {
  project: CodeCanvasProjectMeta;
  position: { x: number; y: number };
  onCloseMenu: () => void;
  onOpen: (id: string) => void;
  onRename: (project: CodeCanvasProjectMeta) => void;
  onCopyPath: (id: string) => void;
  onCloseProject: (id: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointer = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) onCloseMenu(); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseMenu(); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onPointer); document.removeEventListener("keydown", onEsc); };
  }, [onCloseMenu]);

  const content = (
    <div ref={menuRef} role="menu" className="canvas-workspace-context-menu" style={wsMenuStyle(position.x, position.y)}>
      <button type="button" role="menuitem" className="canvas-workspace-context-menu-item" onClick={() => { onOpen(project.id); onCloseMenu(); }}>
        <FolderOpen size={13} aria-hidden /> Open canvas
      </button>
      <button type="button" role="menuitem" className="canvas-workspace-context-menu-item" onClick={() => { onRename(project); onCloseMenu(); }}>
        <Pencil size={13} aria-hidden /> Rename
      </button>
      <button type="button" role="menuitem" className="canvas-workspace-context-menu-item" onClick={() => { onCopyPath(project.id); onCloseMenu(); }}>
        <Copy size={13} aria-hidden /> Copy path
      </button>
      <div role="separator" className="canvas-workspace-context-menu-separator" />
      <button type="button" role="menuitem" className="canvas-workspace-context-menu-item is-danger" onClick={() => { onCloseProject(project.id); onCloseMenu(); }}>
        <X size={13} aria-hidden /> Close canvas
      </button>
    </div>
  );
  if (typeof document === "undefined") return content;
  return createPortal(content, document.body);
}

function projectLabel(project: CodeCanvasProjectMeta): string {
  return project.alias || project.rootDir.split(/[\\/]/).filter(Boolean).at(-1) || project.rootDir;
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}

export function CanvasesModal({
  open,
  projects,
  activeProjectId,
  nodeCountsByProject,
  onOpen,
  onCreate,
  onClose,
  onRenameProject,
  onCopyProjectPath,
  onCloseProject,
}: Props) {
  const [mode, setMode] = useState<ViewMode>("sphere");
  const [menu, setMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useCanvasOcclusionLock(open, "canvases-modal");

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Closing the modal must not leave a context menu / rename in flight.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (!open) { setMenu(null); setEditingId(null); } }, [open]);

  if (!open || typeof document === "undefined") return null;

  const beginRename = (project: CodeCanvasProjectMeta) => {
    setMenu(null);
    setEditingId(project.id);
    setDraft(project.alias ?? projectLabel(project));
  };
  const commitRename = (projectId: string) => {
    onRenameProject(projectId, draft.trim() || null);
    setEditingId(null);
  };
  const openContextMenu = (event: ReactMouseEvent<HTMLElement>, projectId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ projectId, x: event.clientX, y: event.clientY });
  };
  const menuProject = menu ? projects.find((p) => p.id === menu.projectId) ?? null : null;

  const ordered = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);

  const content = (
    <div className="canvases-modal" role="dialog" aria-modal="true" aria-label="Canvases" onClick={onClose}>
      <button type="button" className="canvases-modal-close" aria-label="Close canvases" onClick={onClose}>
        <X size={16} strokeWidth={1.75} />
      </button>

      <div className="canvases-modal-inner" onClick={(event) => event.stopPropagation()}>
        <header className="canvases-modal-head">
          <div className="canvases-head-row">
            <div>
              <h1 className="canvases-modal-title">Canvases</h1>
              <p className="canvases-modal-subtitle">
                {ordered.length} {ordered.length === 1 ? "canvas" : "canvases"} · click one to dive in
              </p>
            </div>
            <div className="canvases-head-controls">
              {mode !== "grid" ? (
                <button type="button" className="canvas-sphere-new" onClick={onCreate} aria-label="New canvas">
                  <Plus size={14} strokeWidth={1.75} />
                  New canvas
                </button>
              ) : null}
              <div className="canvases-mode-toggle" role="tablist" aria-label="Canvas view mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "sphere"}
                  className={`canvases-mode-btn${mode === "sphere" ? " is-active" : ""}`}
                  onClick={() => setMode("sphere")}
                >
                  Sphere
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "gallery"}
                  className={`canvases-mode-btn${mode === "gallery" ? " is-active" : ""}`}
                  onClick={() => setMode("gallery")}
                >
                  Gallery
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "grid"}
                  className={`canvases-mode-btn${mode === "grid" ? " is-active" : ""}`}
                  onClick={() => setMode("grid")}
                >
                  Grid
                </button>
              </div>
            </div>
          </div>
        </header>

        {mode === "sphere" ? (
          <CanvasSphere
            projects={projects}
            activeProjectId={activeProjectId}
            nodeCountsByProject={nodeCountsByProject}
            onOpen={onOpen}
          />
        ) : mode === "gallery" ? (
          <CanvasGallery
            projects={projects}
            activeProjectId={activeProjectId}
            nodeCountsByProject={nodeCountsByProject}
            onOpen={onOpen}
            onCreate={onCreate}
          />
        ) : (
        <div className="canvases-grid">
          {ordered.map((project) => {
            const active = project.id === activeProjectId;
            const count = nodeCountsByProject.get(project.id) ?? 0;
            return (
              <button
                key={project.id}
                type="button"
                className={`canvas-card${active ? " is-current" : ""}`}
                aria-current={active ? "page" : undefined}
                aria-label={`Open ${projectLabel(project)}`}
                title={project.rootDir}
                onClick={() => { if (editingId !== project.id) onOpen(project.id); }}
                onContextMenu={(event) => openContextMenu(event, project.id)}
                onDoubleClick={(event) => { event.preventDefault(); beginRename(project); }}
              >
                <div className="canvas-card-thumb" aria-hidden>
                  {active ? <span className="canvas-card-current">● Current</span> : null}
                  <span className="canvas-card-thumb-pane" />
                  {count > 0 ? <span className="canvas-card-count">{count}</span> : null}
                </div>
                <div className="canvas-card-meta">
                  {editingId === project.id ? (
                    <input
                      className="canvas-card-rename"
                      value={draft}
                      autoFocus
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => commitRename(project.id)}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") commitRename(project.id);
                        if (event.key === "Escape") setEditingId(null);
                      }}
                    />
                  ) : (
                    <span className="canvas-card-name">{projectLabel(project)}</span>
                  )}
                  <span className="canvas-card-row">
                    <span className="canvas-card-path">{project.rootDir}</span>
                    <span className="canvas-card-time">{relativeTime(project.updatedAt)}</span>
                  </span>
                </div>
              </button>
            );
          })}

          <button type="button" className="canvas-card canvas-card-new" onClick={onCreate} aria-label="New canvas">
            <span className="canvas-card-new-icon">
              <Plus size={22} strokeWidth={1.5} />
            </span>
            <span className="canvas-card-new-label">New canvas</span>
          </button>
        </div>
        )}
      </div>

      {menu && menuProject ? (
        <CanvasWorkspaceMenu
          project={menuProject}
          position={{ x: menu.x, y: menu.y }}
          onCloseMenu={() => setMenu(null)}
          onOpen={onOpen}
          onRename={beginRename}
          onCopyPath={onCopyProjectPath}
          onCloseProject={onCloseProject}
        />
      ) : null}
    </div>
  );

  return createPortal(content, document.body);
}
