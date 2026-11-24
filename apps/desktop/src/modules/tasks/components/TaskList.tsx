"use client";

import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowUpRight, Check, ChevronDown, LocateFixed } from "lucide-react";
import { TaskStatusGlyph } from "@/modules/tasks/components/TaskGlyphs";
import { TaskPropertyMenu } from "@/modules/tasks/components/TaskPropertyMenu";
import { TicketSourceMark } from "@/modules/tasks/components/TicketSourceMark";
import type { TicketSourceKind } from "@/modules/tasks/services/ticket-sources";
import { ActivityBadge } from "@/modules/workspace-shell/components/ActivityBadge";
import { paneActivityLabel, type PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";
import type { PaneActivity } from "@/modules/workspace-shell/types";
import { taskLiveness } from "@/modules/tasks/services/task-liveness";
import { TASK_TITLE_CAP } from "@/modules/tasks/services/task-draft";
import type { BridgePriority, BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";
import type { TaskSection } from "@/modules/tasks/services/task-list";
import { LOTUS_VOCABULARY, type StatusVocabulary } from "@/modules/tasks/services/task-vocabulary";
import { capabilitiesOf, type TrackerProject, type TrackerTask } from "@/modules/tasks/types";

/**
 * The list itself: sections that say what state their rows are in, and rows that say what they
 * are — status, key, title, then the quiet facts and priority at the right edge (Tasks revamp
 * D2, `mockups/tasks-revamp.html`).
 *
 * Status leads because it is the mark people reach for most. Priority used to lead, but with no
 * priority set (most rows) its glyph is invisible, so the left edge read as a ragged hole; at the
 * right edge it is always drawn and lines up as a column.
 */

export interface TaskRowProps {
  task: TrackerTask;
  taskKey: string | null;
  project: TrackerProject | undefined;
  selected?: boolean;
  /**
   * This ticket has a note written about it elsewhere, matched by its key (PLAN S37) — the "notes"
   * badge. Absent everywhere unless a source asked for its tickets to be matched.
   */
  hasNotes?: boolean;
  /** The kind of source those notes live in, whose mark the badge wears. */
  notesKind?: TicketSourceKind;
  /**
   * What the pane on this task is doing, when there is one worth saying. Primitives rather than
   * the pane's state object, so a row is redrawn when ITS pane moves and not when any pane does.
   */
  liveActivity?: PaneActivity;
  liveSince?: number;
  /**
   * The live badge is the way to the agent (LOT2-220, board 20 option A): present only where this
   * host can show that pane, so a badge that cannot go anywhere stays a label.
   */
  onShowAgent?: (task: TrackerTask) => void;
  /** What pressing the badge does, said as its tooltip: "Show agent on canvas" / "Show agent pane". */
  showAgentLabel?: string;
  /**
   * The task has a node on the canvas board beside this list (the Canvas Dock, board 18): the row
   * wears "on canvas", and pressing it shows that node.
   */
  onCanvas?: boolean;
  onRevealOnCanvas?: (task: TrackerTask) => void;
  /** Present only where the order is the person's to set: Alt+↑ / Alt+↓ move this row one place. */
  onNudge?: (taskId: string, delta: -1 | 1) => void;
  onSelect?: (task: TrackerTask) => void;
  /** The keyboard cursor sits here (J/K). Drawn like a selection, with a lead bar. */
  cursor?: boolean;
  /** Ticked for a bulk action. */
  picked?: boolean;
  /** Present where rows can be written: draws the tick box. `range` is Shift held. */
  onTogglePick?: (task: TrackerTask, range: boolean) => void;
  /** Absent on a read-only list — then the row draws its marks without offering to change them. */
  onEdit?: (
    taskId: string,
    patch: Partial<Pick<TrackerTask, "title" | "status" | "priority">>,
  ) => void;
}

/**
 * The row is a container, not a button.
 *
 * It was a `<button>` while the list only read; now that the status mark, the priority mark and
 * the title each do something of their own, nesting them inside one would be three controls inside
 * a control — invalid HTML, and a screen reader that announces one target where there are four.
 * The title is the button that selects, which is what was really being clicked all along.
 */
function TaskRowImpl({
  task,
  taskKey,
  project,
  selected,
  hasNotes,
  notesKind,
  liveActivity,
  liveSince,
  onShowAgent,
  showAgentLabel = "Show agent",
  onCanvas,
  onRevealOnCanvas,
  onNudge,
  onSelect,
  cursor,
  picked,
  onTogglePick,
  onEdit,
}: TaskRowProps) {
  // The row asks its own project, never a global list: a vault ticket must never be offered
  // Lotus's statuses, and a Lotus task must never be offered the vault's.
  const vocabulary = project?.vocabulary ?? LOTUS_VOCABULARY;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commit() {
    const next = draft.trim();
    setEditing(false);
    // An empty title is a slip, not an instruction: the row keeps the name it had.
    if (!next || next === task.title) return;
    onEdit?.(task.id, { title: next });
  }

  return (
    <div
      className="tk-row"
      data-task-id={task.id}
      data-selected={selected || cursor ? "true" : undefined}
      data-cursor={cursor ? "true" : undefined}
      data-picked={picked ? "true" : undefined}
      // The row is one line, so what does not fit goes here — the same trick the workspace rail
      // uses for a pane's folder and command.
      title={project ? `${project.name} · ${task.title}` : task.title}
    >
      {onTogglePick ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={picked ? "true" : "false"}
          aria-label={`Select ${taskKey ?? task.title}`}
          className="tk-row-pick"
          onClick={(event) => onTogglePick(task, event.shiftKey)}
        >
          {picked ? <Check size={11} strokeWidth={3} aria-hidden /> : null}
        </button>
      ) : null}
      <TaskPropertyMenu
        kind="status"
        vocabulary={vocabulary}
        value={task.status}
        disabled={!onEdit}
        onChange={(status) => onEdit?.(task.id, { status: status as BridgeTaskStatus })}
      />
      {/* A task with no key yet keeps the column: rows whose ids slid left and right as the store
          caught up would make the list look like it was rearranging itself. */}
      <span className="tk-row-key">{taskKey ?? ""}</span>
      {editing ? (
        <input
          ref={inputRef}
          className="tk-row-edit"
          value={draft}
          maxLength={TASK_TITLE_CAP}
          aria-label="Task title"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDraft(task.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="tk-row-title"
          onClick={() => onSelect?.(task)}
          onKeyDown={(event) => {
            if (!onNudge || !event.altKey) return;
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            onNudge(task.id, event.key === "ArrowUp" ? -1 : 1);
          }}
          onDoubleClick={() => {
            if (!onEdit) return;
            setDraft(task.title);
            setEditing(true);
          }}
        >
          {task.title}
        </button>
      )}
      {hasNotes ? (
        <span className="tk-row-notes" title="Has a note with the same key">
          {notesKind ? <TicketSourceMark kind={notesKind} size={10} /> : null}
          notes
        </span>
      ) : null}
      {liveActivity && onShowAgent ? (
        <button
          type="button"
          className="tk-row-live tk-row-live-jump"
          aria-label={`Agent ${paneActivityLabel(liveActivity)}: ${showAgentLabel.toLowerCase()}`}
          title={showAgentLabel}
          onClick={() => onShowAgent(task)}
        >
          <ActivityBadge activity={liveActivity} since={liveSince} compact />
          <ArrowUpRight size={10} aria-hidden />
        </button>
      ) : liveActivity ? (
        // The rail's own badge, so a working agent looks the same here as beside its pane. `img`
        // with a label of its own: the badge's words are for the rail, this says whose they are.
        <span className="tk-row-live" role="img" aria-label={`Agent ${paneActivityLabel(liveActivity)}`}>
          <ActivityBadge activity={liveActivity} since={liveSince} compact />
        </span>
      ) : null}
      {onCanvas && onRevealOnCanvas ? (
        <button
          type="button"
          className="tk-row-canvas"
          aria-label="On canvas: show its node"
          title="On canvas · show its node"
          onClick={() => onRevealOnCanvas(task)}
        >
          <LocateFixed size={10} aria-hidden />
          on canvas
        </button>
      ) : null}
      {project?.color ? (
        <span className="tk-row-project" style={{ background: project.color }} aria-hidden />
      ) : null}
      {/* Only where rows carry a priority at all: a Notion, GitHub or vault ticket has none, and an
          empty mark at the end of every one of its rows read as a stray dot. */}
      {capabilitiesOf(project).hasPriority ? (
        <TaskPropertyMenu
          kind="priority"
          vocabulary={vocabulary}
          value={task.priority}
          disabled={!onEdit}
          onChange={(priority) => onEdit?.(task.id, { priority: priority as BridgePriority })}
        />
      ) : null}
    </div>
  );
}

export const TaskRow = memo(TaskRowImpl);

/**
 * A row that can be picked up.
 *
 * The pointer listeners sit on a wrapper, and the drag starts only after 5px of movement, so a
 * click still selects, a double-click still renames and the status mark still opens its menu.
 * The sortable's own `role="button"` and `tabIndex` are left off: the row already holds four
 * controls, and a fifth wrapped around them would be a control inside a control. The keyboard
 * path is Alt+↑ / Alt+↓ on the title, which says exactly what it does.
 */
function SortableRow({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, listeners, transform, transition, isDragging, attributes } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      className="tk-row-sortable"
      data-dragging={isDragging ? "true" : undefined}
      aria-roledescription={attributes["aria-roledescription"]}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...listeners}
    >
      {children}
    </div>
  );
}

/** One section's rows, draggable among themselves. A section is its own context: rows never cross. */
function SortableSection({
  tasks,
  onMove,
  children,
}: {
  tasks: readonly TrackerTask[];
  onMove: (section: readonly TrackerTask[], taskId: string, toIndex: number) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const to = tasks.findIndex((task) => task.id === over.id);
    if (to !== -1) onMove(tasks, String(active.id), to);
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export interface TaskListProps {
  sections: TaskSection[];
  /** The words the SECTION HEADERS speak — one list, one project's vocabulary. */
  vocabulary?: StatusVocabulary;
  projectsById: ReadonlyMap<string, TrackerProject>;
  keyOf: (task: TrackerTask) => string | null;
  selectedTaskId?: string | null;
  /** Rows that have a note matched by key (the "notes" badge). Absent: none do. */
  withNotes?: ReadonlySet<string>;
  /** Where those notes live — the badge wears that source's mark. */
  notesKind?: TicketSourceKind;
  onSelect?: (task: TrackerTask) => void;
  onEdit?: (
    taskId: string,
    patch: Partial<Pick<TrackerTask, "title" | "status" | "priority">>,
  ) => void;
  /** Drawn when nothing survived the filter — which is not the same as having no tasks. */
  empty: React.ReactNode;
  /** What every pane in the window is doing, so a row can say what its agent is up to. */
  activities?: ReadonlyMap<string, PaneActivityState>;
  /**
   * Showing a row's agent from its live badge: `has` says whether this host can reach the pane on
   * the task's `cellId`, `show` goes there. Absent: badges stay labels.
   */
  agentJump?: { label: string; has: (cellId: string) => boolean; show: (task: TrackerTask) => void };
  /** Tasks with a node on the canvas board beside this list, and showing that node (board 18). */
  onCanvasIds?: ReadonlySet<string>;
  onRevealOnCanvas?: (task: TrackerTask) => void;
  /**
   * Move a row to `toIndex` within its section — given only where the list is ordered by hand and
   * its rows can be written. Rows never leave their section this way: that is a status change,
   * and the status menu is where that is said.
   */
  onMove?: (section: readonly TrackerTask[], taskId: string, toIndex: number) => void;
  /** The keyboard cursor's row (J/K). */
  cursorId?: string | null;
  /** Rows ticked for a bulk action, and ticking one. Absent: no tick boxes. */
  pickedIds?: ReadonlySet<string>;
  onTogglePick?: (task: TrackerTask, range: boolean) => void;
  /** Section statuses folded shut, and folding one. Absent: sections cannot fold. */
  collapsed?: ReadonlySet<string>;
  onToggleSection?: (status: string) => void;
}

/** One section's rows — sortable among themselves when the list is ordered by hand. */
function SectionRows({
  tasks,
  projectsById,
  keyOf,
  selectedTaskId,
  withNotes,
  notesKind,
  activities,
  agentJump,
  onCanvasIds,
  onRevealOnCanvas,
  onNudge,
  onSelect,
  onEdit,
  onMove,
  cursorId,
  pickedIds,
  onTogglePick,
}: Pick<TaskListProps, "projectsById" | "keyOf" | "selectedTaskId" | "withNotes" | "notesKind" | "activities" | "agentJump" | "onCanvasIds" | "onRevealOnCanvas" | "onSelect" | "onEdit" | "onMove" | "cursorId" | "pickedIds" | "onTogglePick"> & {
  tasks: readonly TrackerTask[];
  onNudge?: TaskRowProps["onNudge"];
}) {
  const rows = tasks.map((task) => {
    const live = liveOf(task, activities);
    const row = (
      <TaskRow
        key={task.id}
        task={task}
        taskKey={keyOf(task)}
        project={projectsById.get(task.projectId)}
        selected={task.id === selectedTaskId}
        hasNotes={withNotes?.has(task.id) || undefined}
        notesKind={notesKind}
        liveActivity={live?.activity}
        liveSince={live?.since}
        onShowAgent={live && agentJump?.has(task.cellId!) ? agentJump.show : undefined}
        showAgentLabel={agentJump?.label}
        onCanvas={onCanvasIds?.has(task.id) || undefined}
        onRevealOnCanvas={onRevealOnCanvas}
        onNudge={onNudge}
        onSelect={onSelect}
        onEdit={onEdit}
        cursor={task.id === cursorId || undefined}
        picked={pickedIds?.has(task.id) || undefined}
        onTogglePick={onTogglePick}
      />
    );
    return onMove ? (
      <SortableRow key={task.id} id={task.id}>
        {row}
      </SortableRow>
    ) : (
      row
    );
  });

  if (!onMove) return <>{rows}</>;
  return (
    <SortableSection tasks={tasks} onMove={onMove}>
      {rows}
    </SortableSection>
  );
}

/**
 * The states a row mentions. `done` and `offline` are not among them: a finished pane is about to
 * be released from its task, and saying "done" beside a task the list still calls open would be
 * one word too many.
 */
const MENTIONED: ReadonlySet<PaneActivity> = new Set(["starting", "working", "needs-you", "failed", "idle"]);

function liveOf(
  task: TrackerTask,
  activities: ReadonlyMap<string, PaneActivityState> | undefined,
): PaneActivityState | null {
  if (!activities) return null;
  const liveness = taskLiveness(task, activities);
  if (liveness.kind !== "running" || !MENTIONED.has(liveness.activity)) return null;
  return activities.get(task.cellId!) ?? null;
}

export function TaskList({
  sections,
  projectsById,
  vocabulary: sectionVocabulary = LOTUS_VOCABULARY,
  keyOf,
  selectedTaskId,
  withNotes,
  notesKind,
  onSelect,
  onEdit,
  empty,
  activities,
  agentJump,
  onCanvasIds,
  onRevealOnCanvas,
  onMove,
  cursorId,
  pickedIds,
  onTogglePick,
  collapsed,
  onToggleSection,
}: TaskListProps) {
  if (sections.length === 0) return <div className="tk-empty">{empty}</div>;

  const nudge = onMove
    ? (taskId: string, delta: -1 | 1) => {
        const section = sections.find((candidate) => candidate.tasks.some((task) => task.id === taskId));
        if (!section) return;
        const from = section.tasks.findIndex((task) => task.id === taskId);
        const to = from + delta;
        if (to < 0 || to >= section.tasks.length) return;
        onMove(section.tasks, taskId, to);
      }
    : undefined;

  return (
    <div className="tk-list">
      {sections.map((section) => {
        const folded = collapsed?.has(section.status) ?? false;
        return (
        <section key={section.status} className="tk-section" data-tone={section.tone} data-collapsed={folded ? "true" : undefined}>
          <header className="tk-section-head">
            {onToggleSection ? (
              <button
                type="button"
                className="tk-section-fold"
                aria-expanded={!folded}
                aria-label={`${folded ? "Show" : "Hide"} ${section.label}`}
                onClick={() => onToggleSection(section.status)}
              >
                <ChevronDown size={12} strokeWidth={2} aria-hidden />
              </button>
            ) : null}
            {/* Decorative here: the label is the next element, and saying it twice is what made
                the workspace rail's ask chip unlistenable. */}
            <TaskStatusGlyph
              status={section.status as BridgeTaskStatus}
              vocabulary={sectionVocabulary}
              size={13}
              decorative
            />
            <span className="tk-section-label">{section.label}</span>
            <span className="tk-section-count">{section.tasks.length}</span>
          </header>
          {folded ? null : (
          <SectionRows
            tasks={section.tasks}
            projectsById={projectsById}
            keyOf={keyOf}
            selectedTaskId={selectedTaskId}
            withNotes={withNotes}
            notesKind={notesKind}
            activities={activities}
            agentJump={agentJump}
            onCanvasIds={onCanvasIds}
            onRevealOnCanvas={onRevealOnCanvas}
            onNudge={nudge}
            onSelect={onSelect}
            onEdit={onEdit}
            onMove={onMove}
            cursorId={cursorId}
            pickedIds={pickedIds}
            onTogglePick={onTogglePick}
          />
          )}
        </section>
        );
      })}
    </div>
  );
}
