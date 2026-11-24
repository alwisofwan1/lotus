"use client";
import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import type { NodeProps } from "@xyflow/react";
import { ArrowUpRight, Check, Copy, Folder, Github, ListChecks, PanelRight, Plus, Send, TerminalSquare, Users, X } from "lucide-react";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";
import { CanvasNodeGlyph } from "./CanvasNodeGlyph";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { useRunnerRegistry } from "@/lib/hooks/useRunnerRegistry";
import { cliToRunnerSpec } from "../../services/spawn-first-agent";
import { composeTaskPrompt } from "../../services/task-dispatch";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { DetectedCli } from "@/lib/tauri-api";
import type { AcceptanceCriterion, CanvasTaskNodeData, TaskClass, TaskDispatchMode, TaskWhen } from "../../types/canvas";
import { TaskPriorityGlyph } from "@/modules/tasks/components/TaskGlyphs";
import { LOTUS_VOCABULARY, taskPriorityLabel } from "@/modules/tasks/services/task-vocabulary";
import type { DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import type { TrackerTask } from "@/modules/tasks/types";
import { paneActivityLabel } from "@/modules/workspace-shell/services/pane-activity";
import { useCanvasTaskLinksContext, type CanvasTaskLinks } from "./canvas-task-links-context";
import { shortAge, TaskSplitButton, TaskStatusMenu, type SplitMenuItem } from "./TaskNodeParts";
import { isEditableCanvasKeyTarget } from "../../services/canvas-keyboard-guard";

const CLASS_META: Record<TaskClass, { label: string; color: string }> = {
  quick: { label: "Quick", color: "#4ade80" },
  "needs-research": { label: "Research", color: "#fb923c" },
  "deep-focus": { label: "Deep Focus", color: "#60a5fa" },
  benchmark: { label: "Benchmark", color: "#a78bfa" },
};

const WHEN_META: Record<TaskWhen, { label: string; color: string }> = {
  urgent: { label: "Urgent", color: "#f87171" },
  "this-week": { label: "This week", color: "#fb923c" },
  "this-month": { label: "This month", color: "#60a5fa" },
  whenever: { label: "Whenever", color: "#9ca3af" },
};

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback.
  }

  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

function Chip({ color, label }: { color: string; label: string }) {
  return (
    <span
      className="canvas-task-chip"
      style={{ "--canvas-task-chip-color": color } as CSSProperties}
    >
      {label}
    </span>
  );
}

function CriteriaList({ criteria, onChange }: {
  criteria: AcceptanceCriterion[];
  onChange: (next: AcceptanceCriterion[]) => void;
}) {
  const done = criteria.filter((c) => c.done).length;
  const toggle = (id: string) =>
    onChange(criteria.map((c) => (c.id === id ? { ...c, done: !c.done } : c)));

  return (
    <div className="canvas-task-criteria nodrag nowheel">
      <div className="canvas-task-section-head">
        <span className="canvas-task-section-label">Criteria</span>
        <span className="canvas-task-section-count">{done}/{criteria.length}</span>
      </div>
      {criteria.map((c) => (
        <label key={c.id} className={`canvas-task-criterion${c.done ? " canvas-task-criterion--done" : ""}`}>
          <input
            className="canvas-task-criterion-check"
            type="checkbox"
            checked={c.done}
            onChange={() => toggle(c.id)}
          />
          <span className="canvas-task-criterion-text">
            {c.text}
          </span>
        </label>
      ))}
    </div>
  );
}

/** The last preset a node delegated with, so the next Delegate is one click (per viewer). */
const PRESET_KEY = "lotus.canvas.taskNode.preset";
function rememberedPreset(): string | null {
  try {
    return window.localStorage.getItem(PRESET_KEY);
  } catch {
    return null;
  }
}
function rememberPreset(id: string) {
  try {
    window.localStorage.setItem(PRESET_KEY, id);
  } catch {
    // A private window keeps no preference; the first preset is the default then.
  }
}

/** `donisapu/e-coursetradding#18` → `#18`: the issue a task came from, for the header's badge. */
function githubIssueOf(sourceRef: string | undefined): string | null {
  const match = sourceRef?.match(/^[^/#\s]+\/[^/#\s]+#(\d+)$/);
  return match ? `#${match[1]}` : null;
}

/**
 * A Task node (`plans/canvas-dock/` board 18).
 *
 * Linked (`taskId` on the window's tracker board): the board's title, status and priority; the
 * pane's live line; one Delegate with the Tasks presets; "open ↗" to its Dock row. Local (made on
 * the canvas): the same chips from its own data, Run on this canvas, and "Add to Tasks". A link
 * whose task is gone from Tasks says so and offers Unlink or Close, never a stale copy.
 */
export const TaskNode = memo(function TaskNode({ id, data, selected }: NodeProps) {
  const { title, description, intent, status, priority, taskClass, when, acceptanceCriteria, taskId, taskWorkspaceId, dispatchedAgentIds, dispatchCommand, onChange, onDispatch, onClose } =
    data as CanvasTaskNodeData;
  const lodTier = useCanvasLodTier();
  const links = useCanvasTaskLinksContext();
  const linkedTask = taskId && links ? links.task(taskId) : undefined;
  const removed = Boolean(taskId && links?.loaded && !linkedTask);
  const statusMenuRequest = useStatusMenuKey(Boolean(selected) && !removed);
  const dispatched = dispatchedAgentIds?.length ?? 0;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimerRef = useRef<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Runner-first single run on this canvas (ADR-0027 Phase 6), for a local task.
  const { registry } = useRunnerRegistry();
  const runners = (registry?.runners ?? []).filter((r) => r.installed);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const handleCopyPrompt = async () => {
    // Copy Prompt omits the agent persona — just the task brief + completion callback.
    const ok = await copyToClipboard(composeTaskPrompt({ title, description, intent, when, acceptanceCriteria, taskId, taskWorkspaceId }));
    setCopyState(ok ? "copied" : "failed");
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1600);
  };

  const patchTask = (patch: Parameters<NonNullable<CanvasTaskNodeData["onChange"]>>[1]) => {
    if (dispatchCommand) dispatchCommand({ kind: "patch-task", nodeId: id, patch });
    else onChange?.(id, patch);
  };
  const closeTask = () => {
    if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
    else onClose?.(id);
  };
  const dispatchTask = (mode: TaskDispatchMode, runner?: AgentRunnerType, runnerCommand?: string) => {
    if (dispatchCommand) dispatchCommand({ kind: "dispatch-task", nodeId: id, mode, runner, runnerCommand });
    else onDispatch?.(id, mode, runner, runnerCommand);
  };
  const runAction = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setActionError(null);
    const message = await action().catch((cause: unknown) => String(cause));
    setBusy(false);
    setActionError(message);
  };

  const view = linkedTask
    ? { title: linkedTask.title, status: linkedTask.status, priority: linkedTask.priority }
    : { title, status, priority };
  const vocabulary = linkedTask && links ? links.vocabulary(linkedTask.projectId) : LOTUS_VOCABULARY;
  const key = linkedTask && links ? links.taskKey(linkedTask) : null;
  const issue = githubIssueOf(linkedTask?.sourceRef);
  const live = linkedTask && links ? links.live(linkedTask) : null;
  const copied = copyState === "copied";
  const copyLabel = copied ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy prompt";

  return (
    <CanvasNodeFrame
      kind="task"
      selected={!!selected}
      minWidth={260}
      minHeight={200}
      lodTier={lodTier}
      glyph={<CanvasNodeGlyph label={view.title || "Task"} tone={view.status === "complete" ? "active" : "neutral"} detail="task" />}
      header={
        <div className="canvas-node-header">
          <span className="canvas-node-header-label">
            <ListChecks aria-hidden />
            Task
            {key ? <span className="canvas-task-key">· {key}</span> : null}
          </span>
          {issue ? (
            <span className="canvas-task-source" title={linkedTask?.sourceRef}>
              <Github size={10} aria-hidden />
              {issue}
            </span>
          ) : null}
          <div className="canvas-node-actions">
            {dispatchCommand && (
              <CanvasNodeFocusAction
                onFocus={() => dispatchCommand({ kind: "focus-node", nodeId: id })}
                className="canvas-node-close canvas-node-focus"
              />
            )}
            <button className="canvas-node-close" aria-label="Close task" onClick={closeTask}>
              <X size={11} aria-hidden />
            </button>
          </div>
        </div>
      }
    >
      <div className="canvas-node-body canvas-task-node-body nodrag nowheel" data-link={linkedTask ? "linked" : removed ? "removed" : "local"}>
        <div className="canvas-task-scroll nodrag nowheel" data-testid="canvas-task-scroll">
          {linkedTask && links ? (
            <LinkedTitle task={linkedTask} onCommit={(next) => links.setTitle(linkedTask, next)} />
          ) : (
            <input
              className="canvas-task-title"
              value={title}
              placeholder="Task title…"
              readOnly={removed}
              onChange={(e) => e.target.value !== title && patchTask({ title: e.target.value })}
            />
          )}

          {removed ? (
            <div className="canvas-task-removed" role="status">
              <strong>Removed from Tasks</strong>
              <span>Keep it on this canvas as a local task, or close it.</span>
              <div className="canvas-task-removed-actions">
                <button type="button" className="canvas-task-button" onClick={() => patchTask({ taskId: undefined, taskWorkspaceId: undefined })}>
                  Unlink
                </button>
                <button type="button" className="canvas-task-button" onClick={closeTask}>
                  Close
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="canvas-task-chip-row">
                <TaskStatusMenu
                  status={view.status}
                  vocabulary={vocabulary}
                  openRequest={statusMenuRequest}
                  onPick={(next) => (linkedTask && links ? links.setStatus(linkedTask, next) : patchTask({ status: next }))}
                />
                {view.priority !== "none" ? (
                  <span className="canvas-task-chip canvas-task-chip--quiet" data-priority={view.priority}>
                    <TaskPriorityGlyph priority={view.priority} size={11} decorative />
                    {taskPriorityLabel(view.priority)}
                  </span>
                ) : null}
                {linkedTask && links ? (
                  <span className="canvas-task-chip canvas-task-chip--quiet">
                    <Folder size={11} aria-hidden />
                    {links.projectName(linkedTask.projectId) ?? "Workspace"}
                  </span>
                ) : (
                  <>
                    {taskClass && <Chip color={CLASS_META[taskClass].color} label={CLASS_META[taskClass].label} />}
                    {when && <Chip color={WHEN_META[when].color} label={WHEN_META[when].label} />}
                  </>
                )}
              </div>

              {live ? (
                <div className="canvas-task-live" data-activity={live.state.activity}>
                  <span className="canvas-task-live-dot" aria-hidden />
                  <span className="canvas-task-live-who">{live.label ?? "agent"}</span>
                  <span className="canvas-task-live-state">
                    {paneActivityLabel(live.state.activity)} · {shortAge(live.state.since)}
                  </span>
                </div>
              ) : null}

              {intent ? (
                <div className="canvas-task-intent">
                  <div className="canvas-task-section-head">
                    <span className="canvas-task-section-label">Intent</span>
                  </div>
                  <p className="canvas-task-intent-text">{intent}</p>
                </div>
              ) : linkedTask ? (
                description ? <p className="canvas-task-intent-text">{description}</p> : null
              ) : (
                <textarea
                  className="canvas-task-description"
                  value={description}
                  placeholder="Describe the work — pulled from Notion or written here…"
                  onChange={(e) => e.target.value !== description && patchTask({ description: e.target.value })}
                />
              )}

              {acceptanceCriteria && acceptanceCriteria.length > 0 && (
                <CriteriaList
                  criteria={acceptanceCriteria}
                  onChange={(next) => patchTask({ acceptanceCriteria: next })}
                />
              )}
            </>
          )}
        </div>

        {removed ? null : (
          <>
            <div className="canvas-task-actions">
              {linkedTask && links ? (
                <LinkedDelegate
                  task={linkedTask}
                  links={links}
                  busy={busy || links.inFlight(linkedTask.id)}
                  onDelegate={(preset) => void runAction(() => links.delegate(linkedTask, preset))}
                  onTeam={() => dispatchTask("team")}
                />
              ) : (
                <LocalActions
                  links={links}
                  linkPending={Boolean(taskId)}
                  busy={busy}
                  runners={runners}
                  onRun={(runner) => {
                    const spec = runner ? cliToRunnerSpec(runner) : { runner: "claude" as AgentRunnerType, runnerCommand: undefined };
                    dispatchTask("single", spec.runner, spec.runnerCommand);
                  }}
                  onTeam={() => dispatchTask("team")}
                  onAdd={() => links && void runAction(() => links.addToTasks(id))}
                />
              )}
              {live?.nodeId && dispatchCommand ? (
                <button
                  type="button"
                  className="canvas-task-icon-button"
                  aria-label="Show its agent"
                  title="Show its agent"
                  onClick={() => dispatchCommand({ kind: "focus-node", nodeId: live.nodeId! })}
                >
                  <PanelRight size={13} aria-hidden />
                </button>
              ) : null}
              <button
                type="button"
                className={`canvas-task-icon-button${copied ? " canvas-task-icon-button--done" : ""}`}
                onClick={() => void handleCopyPrompt()}
                aria-label="Copy task prompt"
                title={copyLabel}
              >
                {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                <span className="sr-only">{copyLabel}</span>
              </button>
            </div>
            {actionError ? <p className="canvas-task-error" role="alert">{actionError}</p> : null}

            <div className="canvas-task-meta">
              {linkedTask && links ? (
                <>
                  <span className="canvas-task-meta-text">
                    in Tasks · {links.projectName(linkedTask.projectId) ?? "Workspace"} · {shortAge(linkedTask.updatedAt)}
                  </span>
                  <button type="button" className="canvas-task-open" aria-label="Open in Tasks" onClick={() => links.openInDock(linkedTask.id)}>
                    open <ArrowUpRight size={11} aria-hidden />
                  </button>
                </>
              ) : (
                <span className="canvas-task-meta-text">
                  {taskId ? "linked · reading Tasks…" : "on this canvas only"}
                  {dispatched > 0 ? ` · ${dispatched} agent${dispatched > 1 ? "s" : ""}` : ""}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </CanvasNodeFrame>
  );
});

/** The board's title, edited in place; written to the task on Enter or leaving the field. */
function LinkedTitle({ task, onCommit }: { task: TrackerTask; onCommit: (title: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      className="canvas-task-title"
      value={draft ?? task.title}
      placeholder="Task title…"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function LinkedDelegate({
  task,
  links,
  busy,
  onDelegate,
  onTeam,
}: {
  task: TrackerTask;
  links: CanvasTaskLinks;
  busy: boolean;
  onDelegate: (preset: DelegationPreset) => void;
  onTeam: () => void;
}) {
  const [pickedId, setPickedId] = useState<string | null>(() => rememberedPreset());
  const preset = links.presets.find((candidate) => candidate.id === pickedId) ?? links.presets[0];
  const run = (chosen: DelegationPreset) => {
    setPickedId(chosen.id);
    rememberPreset(chosen.id);
    onDelegate(chosen);
  };
  const presetItems: SplitMenuItem[] = links.presets.map((candidate) => ({
    key: candidate.id,
    label: candidate.name,
    hint: candidate.agent,
    checked: candidate.id === preset?.id,
    onSelect: () => run(candidate),
  }));
  const otherItems: SplitMenuItem[] = [
    { key: "team", label: "Agent Team on this canvas", icon: <Users size={12} aria-hidden />, onSelect: onTeam },
    ...(preset ? [] : [{ key: "presets", label: "Make a preset in Tasks", icon: <Plus size={12} aria-hidden />, onSelect: () => links.openInDock(task.id) }]),
  ];
  return (
    <TaskSplitButton
      primary
      icon={<Send size={12} aria-hidden />}
      label={
        busy ? "Delegating…" : (
          <>
            Delegate{preset ? <>{" "}<span className="canvas-task-split-sub">· {preset.name}</span></> : null}
          </>
        )
      }
      disabled={busy || !preset || links.delegateUnavailable !== null}
      title={links.delegateUnavailable ?? (preset ? `Hand this task to ${preset.name}` : "No delegation preset yet")}
      onClick={preset ? () => run(preset) : undefined}
      menuLabel="Delegate with"
      groups={[presetItems, otherItems]}
    />
  );
}

function LocalActions({
  links,
  linkPending,
  busy,
  runners,
  onRun,
  onTeam,
  onAdd,
}: {
  links: CanvasTaskLinks | null;
  linkPending: boolean;
  busy: boolean;
  runners: readonly DetectedCli[];
  onRun: (runner?: DetectedCli) => void;
  onTeam: () => void;
  onAdd: () => void;
}) {
  const runItems: SplitMenuItem[] = runners.map((runner) => ({
    key: runner.id,
    label: `Run with ${runner.name}`,
    icon: <TerminalSquare size={12} aria-hidden />,
    onSelect: () => onRun(runner),
  }));
  const fallback: SplitMenuItem[] = runners.length === 0
    ? [{ key: "claude", label: "Run with Claude", icon: <TerminalSquare size={12} aria-hidden />, onSelect: () => onRun() }]
    : [];
  const canAdd = Boolean(links?.boardWorkspace) && !linkPending;
  return (
    <>
      {canAdd && links?.boardWorkspace ? (
        <button type="button" className="canvas-task-primary" disabled={busy} onClick={onAdd} title="File this task in Tasks and link this node to it">
          <Plus size={12} aria-hidden />
          <span className="canvas-task-split-label">
            {busy ? "Adding…" : "Add to Tasks"}{" "}
            <span className="canvas-task-split-sub">· {links.boardWorkspace.name}</span>
          </span>
        </button>
      ) : null}
      <TaskSplitButton
        primary={!canAdd}
        icon={<TerminalSquare size={12} aria-hidden />}
        label="Run on canvas"
        menuLabel="Run on canvas with"
        groups={[[...runItems, ...fallback], [{ key: "team", label: "Agent Team", icon: <Users size={12} aria-hidden />, onSelect: onTeam }]]}
      />
    </>
  );
}

/**
 * "S" on a selected Task node opens its status menu (board 18), then 1–6 picks. A bare key, so it
 * never fires while typing — in a field, the NL bar or a terminal — or with a modifier held.
 * Plain `s` is free: no canvas hotkey and no whiteboard tool takes it.
 */
function useStatusMenuKey(active: boolean): number {
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "s" || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (isEditableCanvasKeyTarget(event.target)) return;
      event.preventDefault();
      setRequest((was) => was + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  return request;
}
