"use client";

import type { ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import type { ListPosition } from "@/modules/tasks/services/task-detail";

/**
 * The strip above an open task: the way back, where this task lives, and the way to its
 * neighbours — `bb`'s shape.
 *
 * ↑ ↓ walk the list as it is currently drawn, so reading a run of tasks does not mean going back
 * to the list between each one.
 */
export function TaskDetailBar({
  mark,
  projectName,
  taskKey,
  position,
  onBack,
  onStep,
  trailing,
}: {
  mark: ReactNode;
  projectName: string;
  taskKey: string | null;
  position: ListPosition | null;
  onBack: () => void;
  onStep?: (taskId: string) => void;
  /** Controls that belong to the surface rather than the task — the sidebar toggle. */
  trailing?: ReactNode;
}) {
  return (
    <header className="tk-dbar">
      <button type="button" className="tk-icon-button" onClick={onBack} aria-label="Back to list" title="Back (Esc)">
        <ChevronLeft size={16} strokeWidth={1.75} />
      </button>
      <nav className="tk-dbar-crumb" aria-label="Breadcrumb">
        <button type="button" className="tk-dbar-project" onClick={onBack}>
          {mark}
          <span>{projectName}</span>
        </button>
        {taskKey ? (
          <>
            <ChevronRight size={13} strokeWidth={1.75} className="tk-dbar-sep" aria-hidden />
            <span className="tk-dbar-key" aria-current="page">
              {taskKey}
            </span>
          </>
        ) : null}
      </nav>

      {position && onStep ? (
        <div className="tk-dbar-step">
          <span className="tk-dbar-count">
            {position.index} / {position.total}
          </span>
          <button
            type="button"
            className="tk-icon-button"
            aria-label="Previous task"
            disabled={!position.prev}
            onClick={() => position.prev && onStep(position.prev)}
          >
            <ChevronUp size={15} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="tk-icon-button"
            aria-label="Next task"
            disabled={!position.next}
            onClick={() => position.next && onStep(position.next)}
          >
            <ChevronDown size={15} strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
      {trailing ? <div className="tk-dbar-trailing">{trailing}</div> : null}
    </header>
  );
}
