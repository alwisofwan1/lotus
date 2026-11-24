"use client";

import { useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { TasksModal } from "@/modules/tasks/components/TasksModal";
import { TaskPriorityGlyph, TaskStatusGlyph } from "@/modules/tasks/components/TaskGlyphs";
import {
  LOTUS_VOCABULARY,
  TASK_PRIORITY_ORDER,
  statusLabel,
  taskPriorityLabel,
} from "@/modules/tasks/services/task-vocabulary";
import { TASK_GOAL_CAP, TASK_TITLE_CAP, type TaskDraft } from "@/modules/tasks/services/task-draft";
import type { BridgePriority, BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";
import type { TrackerProject } from "@/modules/tasks/types";

/**
 * New task, as a modal — the shape `bb` uses.
 *
 * It replaced a one-line row at the top of the list. The row could only take a title, so every
 * task was born with its title copied into its goal and had to be opened again to be given a
 * real brief. The modal takes the brief at birth, because the description IS what a delegated
 * agent is handed.
 *
 * Only what the store keeps is offered: project, status, priority, title, description. `bb` also
 * has labels, a due date and attachments; Lotus stores none of them, and a field that is
 * accepted and then silently dropped is a setting that lies.
 *
 * Enter in the title (or ⌘Enter anywhere) creates. "Create more" keeps the modal open and empty,
 * because tasks arrive in handfuls.
 */

export interface TaskComposerModalProps {
  projects: readonly TrackerProject[];
  /** The project the tracker is scoped to, if any — the obvious home for a new task. */
  defaultProjectId: string | null;
  onCreate: (draft: TaskDraft) => Promise<string | null>;
  onClose: () => void;
}

/** A new task can be born in any OPEN state. Done and cancelled are outcomes, not starting points. */
const START_STATUSES = LOTUS_VOCABULARY.order.filter((status) =>
  LOTUS_VOCABULARY.open.includes(status),
) as BridgeTaskStatus[];

export function TaskComposerModal({
  projects,
  defaultProjectId,
  onCreate,
  onClose,
}: TaskComposerModalProps) {
  const headingId = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId ?? projects[0]?.id ?? "");
  const [status, setStatus] = useState<BridgeTaskStatus>("todo");
  const [priority, setPriority] = useState<BridgePriority>("none");
  const [createMore, setCreateMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const project = projects.find((candidate) => candidate.id === projectId);

  async function submit() {
    if (busy) return;
    setBusy(true);
    const message = await onCreate({ title, description, projectId, priority, status });
    setBusy(false);
    setRefusal(message);
    if (message) return;
    if (!createMore) {
      onClose();
      return;
    }
    // Emptied, not reset: the project, status and priority usually hold for the next one too.
    setTitle("");
    setDescription("");
    titleRef.current?.focus();
  }

  return (
    <TasksModal labelledBy={headingId} onClose={onClose} size="lg" className="tk-compose">
      <div
        className="tk-compose-body"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <p className="tk-compose-crumb" id={headingId}>
          <span
            className="tk-nav-dot"
            style={project?.color ? { background: project.color } : undefined}
            aria-hidden
          />
          New task{project ? <span className="tk-compose-crumb-project"> · {project.name}</span> : null}
        </p>

        <input
          ref={titleRef}
          autoFocus
          className="tk-compose-title"
          value={title}
          maxLength={TASK_TITLE_CAP}
          placeholder="Task title"
          aria-label="Task title"
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <textarea
          className="tk-compose-description"
          value={description}
          maxLength={TASK_GOAL_CAP}
          rows={4}
          placeholder="Description — what an agent needs to know to do this"
          aria-label="Description"
          disabled={busy}
          onChange={(event) => setDescription(event.target.value)}
        />

        <div className="tk-compose-props">
          {projects.length > 1 ? (
            <label className="tk-select-chip">
              <span
                className="tk-nav-dot"
                style={project?.color ? { background: project.color } : undefined}
                aria-hidden
              />
              <span className="tk-select-chip-value">{project?.name ?? "Project"}</span>
              <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
              <select value={projectId} aria-label="Project" onChange={(event) => setProjectId(event.target.value)}>
                {projects.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="tk-select-chip">
            <TaskStatusGlyph status={status} vocabulary={LOTUS_VOCABULARY} size={13} decorative />
            <span className="tk-select-chip-value">{statusLabel(LOTUS_VOCABULARY, status)}</span>
            <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
            <select
              value={status}
              aria-label="Status"
              onChange={(event) => setStatus(event.target.value as BridgeTaskStatus)}
            >
              {START_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(LOTUS_VOCABULARY, value)}
                </option>
              ))}
            </select>
          </label>

          <label className="tk-select-chip">
            <TaskPriorityGlyph priority={priority} size={13} decorative />
            <span className="tk-select-chip-value">{taskPriorityLabel(priority)}</span>
            <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
            <select
              value={priority}
              aria-label="Priority"
              onChange={(event) => setPriority(event.target.value as BridgePriority)}
            >
              {TASK_PRIORITY_ORDER.map((value) => (
                <option key={value} value={value}>
                  {taskPriorityLabel(value)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {refusal ? <p className="tk-modal-refusal">{refusal}</p> : null}
      </div>

      <footer className="tk-compose-foot">
        <label className="tk-check">
          <input type="checkbox" checked={createMore} onChange={(event) => setCreateMore(event.target.checked)} />
          Create more
        </label>
        <span className="tk-compose-hint" aria-hidden>
          ⌘↵
        </span>
        <button
          type="button"
          className="tk-button tk-button--primary"
          onClick={() => void submit()}
          disabled={busy || !title.trim()}
        >
          {busy ? "Creating…" : "Create task"}
        </button>
      </footer>
    </TasksModal>
  );
}
