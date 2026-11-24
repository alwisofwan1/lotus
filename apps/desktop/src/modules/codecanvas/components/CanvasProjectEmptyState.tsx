"use client";
import { useEffect } from "react";
import { FolderOpen } from "lucide-react";

import type { RecentProject } from "../services/recent-projects";

interface CanvasProjectEmptyStateProps {
  /** Opens the native OS folder picker to choose a project root. */
  onOpen: () => void;
  /** Most-recently-opened projects (already shaped) for one-click resume; empty on first run. */
  recents?: RecentProject[];
  /** Reopen a recent project by id. */
  onSelectRecent?: (projectId: string) => void;
}

const IS_MAC = typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl";

/**
 * "No project open" portal. One self-contained glass surface — carrying its own contrast so it
 * stays legible over any wallpaper — with the primary "open a folder" action plus a short project
 * history for one-click resume. Chrome vocabulary matches the top pill. With no history it collapses
 * to a single action; the ⌘K hint points at the command palette. Native picker is wired by the parent.
 */
export function CanvasProjectEmptyState({ onOpen, recents = [], onSelectRecent }: CanvasProjectEmptyStateProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        onOpen();
        return;
      }
      const n = Number(event.key);
      if (Number.isInteger(n) && n >= 1 && n <= recents.length) {
        event.preventDefault();
        onSelectRecent?.(recents[n - 1].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpen, onSelectRecent, recents]);

  const hasRecents = recents.length > 0;

  return (
    <section className="canvas-project-empty" aria-label="No project open">
      <div className="canvas-empty-portal">
        <div className="canvas-empty-surface" data-collapsed={hasRecents ? undefined : ""}>
          <button type="button" onClick={onOpen} className="canvas-empty-row canvas-empty-row--primary">
            <FolderOpen size={15} aria-hidden className="canvas-empty-row-icon" />
            <span className="canvas-empty-row-label">Open a project</span>
            <kbd className="canvas-empty-kbd" aria-hidden>{MOD}O</kbd>
          </button>
          {hasRecents && (
            <>
              <div className="canvas-empty-sep" role="separator" aria-orientation="horizontal" />
              {recents.map((recent, index) => (
                <button
                  key={recent.id}
                  type="button"
                  onClick={() => onSelectRecent?.(recent.id)}
                  className="canvas-empty-row canvas-empty-row--recent"
                  aria-label={`Open ${recent.name}`}
                >
                  <span className="canvas-empty-recent-name">{recent.name}</span>
                  <span className="canvas-empty-recent-path">{recent.path}</span>
                  {index < 9 && <kbd className="canvas-empty-kbd" aria-hidden>{MOD}{index + 1}</kbd>}
                </button>
              ))}
            </>
          )}
        </div>
        <p className="canvas-empty-hint">or press {MOD}K</p>
      </div>
    </section>
  );
}
