"use client";

import type { ReactNode } from "react";
import { useState, useSyncExternalStore } from "react";
import { Circle, CircleAlert, CircleCheck, CircleDashed, RotateCcw } from "lucide-react";
import { ageClock } from "@/modules/workspace-shell/services/age-clock";
import { DelegateMenu } from "@/modules/tasks/components/DelegateMenu";
import { EditableTitle } from "@/modules/tasks/components/EditableTitle";
import { TicketSectionEditor } from "@/modules/tasks/editor/TicketSectionEditor";
import { useAutosavedField } from "@/modules/tasks/hooks/useAutosavedField";
import {
  TASK_GOAL_CAP,
  TASK_KNOWLEDGE_CAP,
  TASK_TITLE_CAP,
  taskDraftRefusalMessage,
  utf8Length,
} from "@/modules/tasks/services/task-draft";
import { TicketSourceMark } from "@/modules/tasks/components/TicketSourceMark";
import { ticketSourceKindOfTask } from "@/modules/tasks/services/ticket-sources";
import { TaskDetailBar } from "@/modules/tasks/components/TaskDetailBar";
import { TaskMarkdown } from "@/modules/tasks/components/TaskMarkdown";
import { TaskPropertyMenu } from "@/modules/tasks/components/TaskPropertyMenu";
import type { DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import {
  blockerLine,
  formatTaskEventAge,
  intakeLine,
  stripRepeatedTitle,
  subTaskProgress,
  type ListPosition,
  taskActivityRows,
  taskHasRecord,
} from "@/modules/tasks/services/task-detail";
import {
  LOTUS_VOCABULARY,
  statusLabel,
  subTaskStatusLabel,
} from "@/modules/tasks/services/task-vocabulary";
import type {
  BridgePriority,
  BridgeTask,
  BridgeTaskStatus,
  SubTaskStatus,
} from "@/modules/codespace/services/bridge/task-store";
import type { TrackerProject } from "@/modules/tasks/types";

/**
 * One task, and everything that has happened to it.
 *
 * The record this draws — the director's intake, a blocker, an agent's result, a reviewer's verdict
 * — has been written by the MCP tools since they shipped and has never once been visible: the
 * desktop's `BridgeTask` type did not declare the fields, so no surface could read them. Nothing
 * new is being recorded here; a room is being given to what was already being said.
 *
 * Status and priority are the same controls the list row uses, so changing them from here and from
 * there are the same act, not two similar ones.
 *
 * Laid out the way `bb` lays out an issue: a reading column for what the task SAYS (title, brief,
 * sub-tasks, what happened), and a narrow Properties column for what it IS (status, priority,
 * project) and what can be done with it (Delegate). The brief is markdown — agents write it as
 * markdown — so it is rendered, not printed.
 */

export interface TaskDetailPanelProps {
  task: BridgeTask;
  taskKey: string | null;
  project: TrackerProject | undefined;
  onBack: () => void;
  /** Where this task sits in the list as drawn; `null` hides the ↑ ↓. */
  position?: ListPosition | null;
  onStep?: (taskId: string) => void;
  /** Surface controls drawn at the right end of the detail bar. */
  barTrailing?: ReactNode;
  /** Absent when this surface cannot delegate — then the control is not drawn at all. */
  delegation?: {
    presets: readonly DelegationPreset[];
    ready: boolean;
    busy: boolean;
    /** Why the last Delegate failed. Shown on the panel: the list, where it was shown before, is covered by it. */
    error?: string | null;
    onDelegate: (preset: DelegationPreset) => void;
    /** Both open the shared preset editor — the one the Tasks sidebar opens too. */
    onNewPreset: () => void;
    onEditPreset: (preset: DelegationPreset) => void;
  };
  /** Open a pane back in a recorded session. Absent where this surface cannot spawn. */
  onResume?: (command: string) => void;
  /** Open the vault ticket this task was made from, by its file name. */
  onOpenSource?: (ref: string) => void;
  onEdit: (
    taskId: string,
    patch: Partial<{ title: string; status: BridgeTaskStatus; priority: BridgePriority }>,
  ) => void;
  /**
   * Save the brief or the knowledge. Present where the task's text can be edited — then the title,
   * brief and knowledge are editable in place, as a vault ticket's page already was.
   */
  onEditBody?: (patch: { goal?: string; knowledge?: string }) => void;
}

const SUBTASK_ICON: Record<SubTaskStatus, typeof Circle> = {
  pending: Circle,
  "in-progress": CircleDashed,
  completed: CircleCheck,
};

export function TaskDetailPanel({
  task,
  taskKey,
  project,
  position = null,
  onStep,
  barTrailing,
  delegation,
  onResume,
  onOpenSource,
  onBack,
  onEdit,
  onEditBody,
}: TaskDetailPanelProps) {
  /*
    The shell's one clock, not `Date.now()` during render.

    A render that reads the clock is not idempotent — React may render twice and get two answers —
    and this repo has already been through the two shapes that look easier: a ticking parent that
    repaints the grid, and a per-badge interval that sets state from an effect. `age-clock.ts`
    carries the full reasoning; the ages here are printed in whole minutes, so one shared stamp is
    exactly enough.
  */
  const now = useSyncExternalStore(subscribeToAgeClock, readAgeClock, readAgeClock);
  const vocabulary = project?.vocabulary ?? LOTUS_VOCABULARY;
  const blocker = blockerLine(task.blocker);
  const intake = intakeLine(task.intake);
  const progress = subTaskProgress(task.subtasks);
  const activity = taskActivityRows(task.feedbackEvents);
  const brief = stripRepeatedTitle(task.goal ?? "", task.title).trim();
  const [titleRefusal, setTitleRefusal] = useState<string | null>(null);
  /*
    The brief as the editor shows it is the goal minus a repeated title — a task typed as one line
    stores its title AS its goal, and showing it twice is noise. Cleared entirely, the goal goes
    back to being the title: the store refuses an empty goal (`validate_create`), and the goal of a
    one-line task is its title.
  */
  const briefField = useAutosavedField({
    value: brief,
    cap: TASK_GOAL_CAP,
    save: (text) => onEditBody?.({ goal: text.trim() || task.title }),
  });
  const knowledgeField = useAutosavedField({
    value: task.knowledge ?? "",
    cap: TASK_KNOWLEDGE_CAP,
    save: (text) => onEditBody?.({ knowledge: text }),
  });

  return (
    <div className="tk-detail">
      <TaskDetailBar
        mark={
          <span
            className="tk-nav-dot"
            style={project?.color ? { background: project.color } : undefined}
            aria-hidden
          />
        }
        projectName={project?.name ?? "Tasks"}
        taskKey={taskKey}
        position={position}
        onBack={onBack}
        onStep={onStep}
        trailing={barTrailing}
      />

      <div className="tk-detail-scroll">
        <div className="tk-detail-page">
          <article className="tk-detail-main">
            {progress ? (
              <p className="tk-detail-progress">
                <span
                  className="tk-progress-ring"
                  style={{ ["--tk-progress" as string]: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }}
                  aria-hidden
                />
                {progress.done}/{progress.total} sub-tasks
              </p>
            ) : null}

            {onEditBody ? (
              <>
                <EditableTitle
                  key={`${task.id}:${task.title}`}
                  title={task.title}
                  label="Task title"
                  onCommit={(next) => {
                    if (utf8Length(next) > TASK_TITLE_CAP) {
                      setTitleRefusal(taskDraftRefusalMessage("title-too-long"));
                      return false;
                    }
                    setTitleRefusal(null);
                    onEdit(task.id, { title: next });
                  }}
                />
                {titleRefusal ? <p className="tk-error">{titleRefusal}</p> : null}
              </>
            ) : (
              <h2 className="tk-detail-title">{task.title}</h2>
            )}
            {delegation?.error ? (
              <p className="tk-callout tk-callout--blocked tk-notion-notice" role="alert">
                {delegation.error}
              </p>
            ) : null}

            {/* Where the work came from, when it came from somewhere. One-way: this opens the
                ticket, and the ticket knows nothing about this task. */}
            {task.source ? (
              <p className="tk-detail-source">
                <TicketSourceMark kind={ticketSourceKindOfTask(task.source.kind)} size={12} />
                From{" "}
                {onOpenSource ? (
                  <button type="button" onClick={() => onOpenSource(task.source!.ref)}>
                    {task.source.label}
                  </button>
                ) : (
                  <span>{task.source.label}</span>
                )}
              </p>
            ) : null}

            {/* A blocker is the one thing on this page that changes what you should do next, so
                it is the first thing under the title rather than a row in the history. */}
            {blocker ? (
              <p className="tk-callout tk-callout--blocked">
                <CircleAlert size={15} strokeWidth={2} aria-hidden />
                <span>{blocker}</span>
              </p>
            ) : null}

            {onEditBody ? (
              <>
                <section className="tk-detail-section" aria-label="Brief">
                  <TicketSectionEditor
                    key={`${task.id}:brief`}
                    body={brief}
                    resetKey={briefField.resetKey}
                    placeholder="Write a brief — what done looks like…"
                    onChange={briefField.onChange}
                  />
                  {briefField.refusal ? <p className="tk-error">{briefField.refusal}</p> : null}
                </section>
                <section className="tk-detail-section" aria-label="Knowledge">
                  <h3 className="tk-detail-h">Knowledge</h3>
                  <TicketSectionEditor
                    key={`${task.id}:knowledge`}
                    body={task.knowledge ?? ""}
                    resetKey={knowledgeField.resetKey}
                    placeholder="What the worker should know…"
                    onChange={knowledgeField.onChange}
                  />
                  {knowledgeField.refusal ? <p className="tk-error">{knowledgeField.refusal}</p> : null}
                </section>
              </>
            ) : (
              <>
                {brief ? (
                  <TaskMarkdown>{brief}</TaskMarkdown>
                ) : (
                  <p className="tk-detail-empty">No description was written beyond the title.</p>
                )}

                {task.knowledge?.trim() ? (
                  <section className="tk-detail-section">
                    <h3 className="tk-detail-h">Knowledge</h3>
                    <TaskMarkdown>{task.knowledge}</TaskMarkdown>
                  </section>
                ) : null}
              </>
            )}

            {task.subtasks?.length ? (
              <section className="tk-detail-section">
                <h3 className="tk-detail-h">Sub-tasks</h3>
                <ul className="tk-subtasks">
                  {task.subtasks.map((subtask) => {
                    const Icon = SUBTASK_ICON[subtask.status] ?? Circle;
                    return (
                      <li key={subtask.id} data-status={subtask.status}>
                        <Icon
                          size={15}
                          strokeWidth={1.75}
                          className="tk-subtask-mark"
                          aria-label={subTaskStatusLabel(subtask.status)}
                        />
                        <span className="tk-subtask-title">{subtask.title}</span>
                        {subtask.assignedTo ? <span className="tk-subtask-who">{subtask.assignedTo}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {task.lastError ? (
              <section className="tk-detail-section">
                <h3 className="tk-detail-h">Last error</h3>
                <pre className="tk-callout tk-callout--error">{task.lastError}</pre>
              </section>
            ) : null}

            <section className="tk-detail-section tk-detail-activity-section">
              <h3 className="tk-detail-h">Activity</h3>
              {activity.length === 0 ? (
                <p className="tk-detail-empty">
                  {taskHasRecord(task)
                    ? "Nothing has been recorded against this task yet."
                    : "Nothing has happened to this task yet."}
                </p>
              ) : (
                <ol className="tk-timeline">
                  {activity.map((row) => (
                    <li key={row.id}>
                      <p className="tk-timeline-line">
                        <span className="tk-timeline-who">{row.actor}</span>{" "}
                        <span className="tk-timeline-what">{row.action}</span>
                        <span className="tk-timeline-when"> · {formatTaskEventAge(now - row.at)}</span>
                        {/* Only on a dispatch that recorded a session it can be walked back into.
                            A row that offers to resume something it cannot is worse than none. */}
                        {row.resume && onResume ? (
                          <button
                            type="button"
                            className="tk-detail-resume"
                            onClick={() => onResume(row.resume!.command)}
                            title={row.resume.command}
                          >
                            <RotateCcw size={11} strokeWidth={2} aria-hidden />
                            Resume
                          </button>
                        ) : null}
                      </p>
                      {row.summary ? <p className="tk-timeline-summary">{row.summary}</p> : null}
                      {row.resume ? (
                        <p className="tk-timeline-meta">
                          {row.resume.presetName ? `${row.resume.presetName} · ` : ""}
                          session {row.resume.sessionId.slice(0, 8)}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </article>

          <aside className="tk-props" aria-label="Properties">
            <h3 className="tk-props-h">Properties</h3>
            <div className="tk-props-list">
              <TaskPropertyMenu
                kind="status"
                vocabulary={vocabulary}
                value={task.status}
                showLabel
                onChange={(status) => onEdit(task.id, { status: status as BridgeTaskStatus })}
              />
              <TaskPropertyMenu
                kind="priority"
                vocabulary={vocabulary}
                value={task.priority}
                showLabel
                onChange={(priority) => onEdit(task.id, { priority: priority as BridgePriority })}
              />
            </div>

            {project ? (
              <>
                <h3 className="tk-props-h">Project</h3>
                <p className="tk-props-value">
                  <span
                    className="tk-nav-dot"
                    style={project.color ? { background: project.color } : undefined}
                    aria-hidden
                  />
                  {project.name}
                </p>
              </>
            ) : null}

            {delegation ? (
              <>
                <h3 className="tk-props-h">Agent</h3>
                <DelegateMenu
                  presets={delegation.presets}
                  ready={delegation.ready}
                  busy={delegation.busy}
                  onDelegate={delegation.onDelegate}
                  onNewPreset={delegation.onNewPreset}
                  onEditPreset={delegation.onEditPreset}
                />
              </>
            ) : null}

            {intake ? (
              <>
                <h3 className="tk-props-h">Intake</h3>
                <p className="tk-props-note">{intake}</p>
              </>
            ) : null}

            <p className="tk-props-foot">
              {statusLabel(vocabulary, task.status)} · updated {formatTaskEventAge(now - task.updatedAt)}
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}

const subscribeToAgeClock = (onChange: () => void) => ageClock.subscribe(onChange);
const readAgeClock = () => ageClock.now();
