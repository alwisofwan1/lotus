"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelRight, PanelRightClose, Plus, X } from "lucide-react";
import "@/styles/tasks.css";
import { EmptyState, SkeletonDetail } from "@/components/resource/resource-kit";
import { TaskComposerModal } from "@/modules/tasks/components/TaskComposerModal";
import { PresetEditorModal } from "@/modules/tasks/components/PresetEditorModal";
import { AddTicketSourceModal } from "@/modules/tasks/components/AddTicketSourceModal";
import { NotionFieldsSheet } from "@/modules/tasks/components/NotionFieldsSheet";
import { SourceHealthBanner } from "@/modules/tasks/components/SourceHealthBanner";
import { GitHubIssuePanel } from "@/modules/tasks/components/GitHubIssuePanel";
import { TasksToast } from "@/modules/tasks/components/TasksToast";
import { TaskBulkBar } from "@/modules/tasks/components/TaskBulkBar";
import { NewNotionTicketDialog } from "@/modules/tasks/components/NewNotionTicketDialog";
import type { NotionSubTicketsProps } from "@/modules/tasks/components/NotionSubTickets";
import { TrashTicketDialog } from "@/modules/tasks/components/TrashTicketDialog";
import { AddNotionDatabaseSheet } from "@/modules/tasks/components/AddNotionDatabaseSheet";
import { AddGitHubRepoSheet } from "@/modules/tasks/components/AddGitHubRepoSheet";
import { useGhAccounts } from "@/modules/tasks/hooks/useGhAccounts";
import { createTauriFactoryRunClient, notionTicketBody, type FactoryRef, type FactoryRunClient } from "@/modules/factory";
import { factoryNotionTicket } from "@/lib/tauri/graph-run";
import type { GhAccount } from "@/modules/connectors/services/connectors-api";
import { createTauriAutomationClient } from "@/modules/automation/services/automation-api";
import { createTauriGitHubIssuesClient, type GitHubIssue, type GitHubIssueComment, type GitHubIssuesClient, type GitHubSourceConfig } from "@/modules/tasks/services/github-issues-source";
import { GITHUB_ISSUE_WRITE_DENY_RULES, githubIssueRef, namesakeCheckoutNote, taskDraftFromGitHubIssue } from "@/modules/tasks/services/github-delegation";
import { NotionRowPanel, type NotionEditing } from "@/modules/tasks/components/NotionRowPanel";
import { useNotionAccount } from "@/modules/tasks/hooks/useNotionAccount";
import { NOTION_WRITE_DENY_RULES, taskDraftFromNotionRow } from "@/modules/tasks/services/notion-delegation";
import type { NotionRow } from "@/modules/tasks/services/notion-source";
import {
  createTauriNotionSourceClient,
  type NotionSourceClient,
  type NotionSourceConfig,
} from "@/modules/tasks/services/notion-source";
import { TaskDetailPanel } from "@/modules/tasks/components/TaskDetailPanel";
import { VaultTicketPanel } from "@/modules/tasks/components/VaultTicketPanel";
import { NoteRefreshSheet } from "@/modules/tasks/components/NoteRefreshSheet";
import { notionIsNewer, notionPageIdOf, pullTime, PULLED_SECTION, samePageId } from "@/modules/tasks/services/notes-pull";
import { notesByKey, readTicketPlace, TICKET_SOURCE_LABELS, writeTicketPlaces } from "@/modules/tasks/services/ticket-sources";
import { TicketSourceMark } from "@/modules/tasks/components/TicketSourceMark";
import {
  taskDraftFromTicket,
  taskToReuseForTicket,
  tasksFromTicket,
} from "@/modules/tasks/services/ticket-to-task";
import type { DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import type { VaultTicketDetail } from "@/modules/tasks/services/vault-api";
import { useDelegation } from "@/modules/tasks/hooks/useDelegation";
import { useTicketEditing } from "@/modules/tasks/hooks/useTicketEditing";
import type { TaskSpawner } from "@/modules/tasks/services/task-spawner";
import { workspaceInFolder } from "@/modules/tasks/services/delegation-target";
import { useIssueCheckout, type FindIssueCheckout } from "@/modules/tasks/hooks/useIssueCheckout";
import { ticketDelegateOptions as ticketDelegateOptionsFor } from "@/modules/tasks/services/ticket-delegate-options";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";
import { TaskFilterBar } from "@/modules/tasks/components/TaskFilterBar";
import { TaskList, type TaskListProps } from "@/modules/tasks/components/TaskList";
import { TasksNavPanel } from "@/modules/tasks/components/TasksNavPanel";
import { ClosedWorkspaceTasks } from "@/modules/tasks/components/ClosedWorkspaceTasks";
import type { ClosedWorkspaceTaskClient } from "@/modules/tasks/services/closed-workspace-tasks";
import { useVaultPath } from "@/modules/tasks/hooks/useVaultPath";
import { LOTUS_VOCABULARY, statusLabel, taskPriorityLabel } from "@/modules/tasks/services/task-vocabulary";
import {
  countTasks,
  filterTasks,
  groupTasksByProject,
  isActiveTask,
  reorderWrites,
  type TaskSort,
  vocabularyByProject,
} from "@/modules/tasks/services/task-list";
import { toTrackerTask, trackerTaskKey } from "@/modules/tasks/services/task-mapping";
import {
  applyFilterRules,
  availableProperties,
  filterOptions,
  filterViewKey,
  ruleIsActive,
  type FilterProperty,
  type TaskFilterRule,
} from "@/modules/tasks/services/task-filters";
import { listPosition } from "@/modules/tasks/services/task-detail";
import { SplitHandle } from "@/modules/workspace-shell/components/SplitHandle";
import { useElementSize } from "@/modules/workspace-shell/hooks/useElementSize";
import { clampSplitSize, computeSplitMax } from "@/modules/workspace-shell/services/split-sizing";
import type { OpenedTask, TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TasksLayout } from "@/modules/tasks/services/tasks-layout";
import { capabilitiesOf, type TrackerTask } from "@/modules/tasks/types";
import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";

const NAV_DEFAULT = 260;
const NAV_MIN = 210;
const LIST_MIN = 380;

interface TasksSurfaceProps {
  /** The one board the whole window shares — the rail's count reads the same one. */
  board: TrackerBoard;
  /** What every pane in this window is doing, so `Active` is an observation and not a claim. */
  activities: ReadonlyMap<string, PaneActivityState>;
  /** The connected vault, resolved above so the board and this panel cannot disagree. */
  vault: Pick<ReturnType<typeof useVaultPath>, "path" | "connect" | "disconnect"> &
    Partial<Pick<ReturnType<typeof useVaultPath>, "addNotionSource" | "addGitHubSource" | "removeSource" | "sources">>;
  /**
   * How to open a pane, published by Code mode. `null` before that mode has mounted — and
   * Delegate says so rather than failing when pressed.
   */
  spawner: TaskSpawner | null;
  /** Why this host cannot delegate yet, said when Delegate is pressed (the Canvas Dock, S4). */
  delegateUnavailable?: string;
  /**
   * The folder on screen beside Tasks (the canvas board's): a ticket is delegated to the workspace
   * in that folder unless another is picked, rather than to the rail's first.
   */
  defaultTargetFolder?: string | null;
  /** Tasks with a node on the canvas board beside the Dock, and showing that node (board 18). */
  canvasTasks?: { ids: ReadonlySet<string>; reveal: (taskId: string) => void };
  /** The live badge goes to the row's agent where this host can show its pane (LOT2-220). */
  agentJump?: TaskListProps["agentJump"];
  /** Opens on this task (the Canvas Dock's Needs-you row). Read once: remount to open another. */
  initialSelectedTaskId?: string | null;
  layout: TasksLayout;
  onLayoutChange: (patch: Partial<TasksLayout>) => void;
  onClose: () => void;
  /** Injected by tests; the Tauri one otherwise. */
  closedWorkspaceClient?: ClosedWorkspaceTaskClient;
  /** Injected by tests; the Tauri one otherwise. */
  notionClient?: NotionSourceClient;
  /** Injected by tests; the Tauri one otherwise. */
  githubClient?: Pick<GitHubIssuesClient, "listRepos" | "forget" | "readIssue">;
  /** Injected by tests; the Tauri one otherwise. */
  factoryClient?: FactoryRunClient;
  /** Injected by tests; gh's logins otherwise. */
  ghAccounts?: GhAccount[] | null;
  /** Injected by tests; the Tauri one otherwise. Finds a GitHub issue's checkout. */
  findCheckout?: FindIssueCheckout;
  /** Opens Connectors, where a source that lost its token is connected again. */
  onOpenConnectors?: () => void;
  /** Opens the Factory on one issue's run. */
  onOpenFactoryRun?: (repo: string, issue: FactoryRef, tab?: "chief") => void;
}

/**
 * The repo a GitHub source reads, from its settings entry; the issue's own github.com URL if that
 * is gone. Null when neither says — a guess would give the task a ref other issues share.
 */
function githubRepoFor(
  sources: readonly { kind: string }[] | undefined,
  sourceId: string,
  issue: GitHubIssue,
): string | null {
  return (
    sources?.find((source): source is GitHubSourceConfig => source.kind === "github" && (source as GitHubSourceConfig).id === sourceId)?.repo ??
    issue.url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1] ??
    null
  );
}

/**
 * Tasks: the tracker, opened from the rail rather than from the mode switcher.
 *
 * That placement is `bb`'s and it is the point of this arrangement: Tasks is not a fourth kind of
 * workspace, it is a panel you step into and back out of, and the mode underneath keeps running
 * while you are in it. Its own navigation — All tasks, Active, the projects — sits on the RIGHT,
 * again as bb does, because the left column already belongs to the window.
 */
export function TasksSurface({
  board,
  activities,
  vault,
  spawner,
  delegateUnavailable,
  defaultTargetFolder = null,
  initialSelectedTaskId = null,
  canvasTasks,
  agentJump,
  layout,
  onLayoutChange,
  onClose,
  closedWorkspaceClient,
  notionClient,
  githubClient,
  factoryClient,
  onOpenFactoryRun,
  ghAccounts: ghAccountsOverride,
  onOpenConnectors,
  findCheckout,
}: TasksSurfaceProps) {
  const [bodyRef, body] = useElementSize<HTMLDivElement>();
  // One identity for the memoised rows: the Dock passes a fresh object each render.
  const revealCanvasTask = canvasTasks?.reveal;
  const revealOnCanvas = useCallback((task: TrackerTask) => revealCanvasTask?.(task.id), [revealCanvasTask]);

  const navMax = computeSplitMax(body.width, LIST_MIN, NAV_MIN);
  const navSize = clampSplitSize(layout.taskNavWidth ?? NAV_DEFAULT, { min: NAV_MIN, max: navMax });
  const navVisible = layout.taskNavVisible ?? true;
  const hideDone = layout.taskHideDone ?? true;

  const [selection, setSelection] = useState<string | null | "active">(null);
  /*
    Filters belong to the VIEW, as they do in Notion: "Assignee contains Me" set on one board stays
    on that board, and "All tasks" keeps its own. Kept in the layout, so a view opens tomorrow the
    way it was left — the old chips lived in component state and were gone the moment Tasks closed.
  */
  const viewKey = filterViewKey(selection);
  const rules = useMemo(() => layout.taskFilters?.[viewKey] ?? [], [layout.taskFilters, viewKey]);
  const taskFilters = layout.taskFilters;
  const setRules = useCallback(
    (next: TaskFilterRule[]) => {
      const all = { ...(taskFilters ?? {}) };
      if (next.length) all[viewKey] = next;
      else delete all[viewKey];
      onLayoutChange({ taskFilters: all });
    },
    [onLayoutChange, taskFilters, viewKey],
  );
  const me = layout.taskMe ?? null;
  const sort: TaskSort = layout.taskSort ?? "priority";
  const setSort = useCallback((next: TaskSort) => onLayoutChange({ taskSort: next }), [onLayoutChange]);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialSelectedTaskId);
  /** The keyboard cursor (J/K): the row Enter, S, P and X act on. Stays where a closed task was. */
  const [cursorId, setCursorId] = useState<string | null>(initialSelectedTaskId);
  /** Rows ticked for a bulk action (D8), and the row a Shift-tick ranges from. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const pickAnchor = useRef<string | null>(null);
  /** Folded sections, keyed `projectId:status`. shortcut: not persisted, resets on reopen; move to layout prefs if asked. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  /** The last bulk change, kept so its toast can put every row back. */
  const [bulkUndo, setBulkUndo] = useState<{ message: string; before: TrackerTask[] } | null>(null);
  const [composing, setComposing] = useState(false);
  /** "Add a ticket source" is open. */
  const [addingSource, setAddingSource] = useState(false);
  /** Bumped to open the vault's folder form in the nav, after Obsidian was picked. */
  const [vaultFormRequest, setVaultFormRequest] = useState(0);
  /** "Add a Notion database" is open. */
  const [addingNotion, setAddingNotion] = useState(false);
  const notionAccount = useNotionAccount();
  /** "Add a GitHub repo" is open. */
  const [addingGitHub, setAddingGitHub] = useState(false);
  const ghAccountsRead = useGhAccounts();
  const ghAccounts = ghAccountsOverride !== undefined ? ghAccountsOverride : ghAccountsRead;
  /** The Notion source whose fields are being remapped, by id. */
  const [remapping, setRemapping] = useState<string | null>(null);
  const notionConfigOf = (id: string) =>
    vault.sources?.find((source): source is NotionSourceConfig => source.kind === "notion" && source.id === id) ?? null;
  const remappingSource = remapping ? notionConfigOf(remapping) : null;
  /** The ticket whose trash is being confirmed, and the one just trashed (the Undo toast). */
  const [trashing, setTrashing] = useState<{ projectId: string; row: NotionRow } | null>(null);
  const [trashed, setTrashed] = useState<{ projectId: string; row: NotionRow; busy?: boolean; error?: string } | null>(null);
  /** Undo keeps its toast until Notion answers; anything but `saved` is said there, with Try again. */
  const undoTrash = useCallback(() => {
    const done = trashed;
    if (!done || done.busy) return;
    setTrashed({ ...done, busy: true, error: undefined });
    const failed = (error: string) => setTrashed((now) => (now?.row.pageId === done.row.pageId ? { ...done, busy: false, error } : now));
    void notion
      .trash(done.projectId, done.row.pageId, false)
      .then((outcome) => {
        if (outcome.outcome !== "saved") return failed("message" in outcome ? outcome.message : "Notion did not restore it.");
        board.notionRows?.putRow(done.projectId, outcome.row);
        setTrashed((now) => (now?.row.pageId === done.row.pageId ? null : now));
      })
      .catch((cause) => failed(String(cause)));
    // `notion` and `board.notionRows` are read at the moment of Undo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trashed]);
  const dismissTrashed = useCallback(() => setTrashed(null), []);
  /** The Notion board a new ticket is being made in, from New task. */
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  /** A Notion ticket's sub-tickets (from the board's rows), the form to add one, and its main ticket. */
  const notionSubTickets = (projectId: string, row: NotionRow): NotionSubTicketsProps => {
    const config = notionConfigOf(projectId);
    const add: NotionSubTicketsProps["add"] =
      config?.permission !== "manage"
        ? null
        : !config.mapping.parent
          ? "unmapped"
          : {
              boardName: config.name,
              onRefresh: board.refresh,
              onAdd: async (title) => {
                const outcome = await notion.create(projectId, title, row.pageId);
                if (outcome.outcome === "saved") board.notionRows?.putRow(projectId, outcome.row);
                return outcome;
              },
            };
    const parentId = row.parents[0];
    return {
      rows: board.notionRows?.childrenOf(projectId, row.pageId) ?? [],
      add,
      onOpen: setSelectedTaskId,
      parent: parentId ? (board.notionRows?.rowOf(projectId, parentId) ?? null) : null,
    };
  };
  /** A Manage source's ticket can be changed here; Rust checks the permission again before writing. */
  const notionEditing = (projectId: string, row: NotionRow): NotionEditing | undefined => {
    if (notionConfigOf(projectId)?.permission !== "manage") return undefined;
    return {
      people: board.notionRows?.peopleOf(projectId) ?? [],
      labels: board.notionRows?.labelsOf(projectId) ?? [],
      onTrash: () => setTrashing({ projectId, row }),
      writeBody: (seen, markdown) => notion.writeBody(projectId, row.pageId, seen, markdown),
      write: async (change, seen) => {
        const outcome = await notion.write(projectId, change, seen);
        const now = outcome.outcome === "saved" ? outcome.row : "fresh" in outcome ? outcome.fresh : null;
        if (now) board.notionRows?.applyRow(projectId, now);
        return outcome;
      },
    };
  };
  const notion = useMemo(() => notionClient ?? createTauriNotionSourceClient(), [notionClient]);
  const github = useMemo(() => githubClient ?? createTauriGitHubIssuesClient(), [githubClient]);
  const factoryRuns = useMemo(() => factoryClient ?? createTauriFactoryRunClient(), [factoryClient]);
  // Read when asked, so a workspace opened after the panel is still found.
  const spawnerRef = useRef(spawner);
  useEffect(() => {
    spawnerRef.current = spawner;
  }, [spawner]);
  const localWorkspaces = useCallback(() => spawnerRef.current?.workspaces?.() ?? [], []);
  const findIssueCheckout = useMemo<FindIssueCheckout>(() => {
    if (findCheckout) return findCheckout;
    const client = createTauriAutomationClient();
    return (repo, workspaces, preferred, options) => client.findCheckout(repo, workspaces, preferred, options);
  }, [findCheckout]);
  /** `"new"` for a fresh preset, a preset to edit it, `null` when no editor is open. */
  const [presetEditor, setPresetEditor] = useState<DelegationPreset | "new" | null>(null);
  /** Why the last delegation did not happen. Cleared when another one is attempted. */
  const [delegateError, setDelegateError] = useState<string | null>(null);
  /*
    The WHOLE stored task, read when a row is opened.

    Not held for every row: the record an agent writes is large, it is read once per look, and a
    list that fetched it for all of them would spend most of its reads on rows nobody opened.
    `undefined` is "still reading", `null` is "the store could not produce it" — two different
    things to say, and a panel that conflated them would show an empty record for a failed read.
  */
  const [openTask, setOpenTask] = useState<OpenedTask | null | undefined>(undefined);
  // The open Notion ticket as the list has it now (syncs and writes keep it current), else as opened.
  const notionRowShown =
    openTask?.kind === "notion"
      ? (board.notionRows?.rowOf(openTask.projectId, openTask.row.pageId) ?? openTask.row)
      : null;

  /*
    The project of the open row — for a ticket, the source it came from. Asked of the row rather
    than assumed, so an open ticket is re-read from the source that holds it.
  */
  const selectedProjectId = useMemo(
    () => (selectedTaskId ? board.tasks.find((task) => task.id === selectedTaskId)?.projectId ?? null : null),
    [board.tasks, selectedTaskId],
  );

  /*
    The open vault ticket, editable. Re-read through the same board call that opened it, so an
    outside change arrives in exactly the shape the panel was first given.
  */
  const rereadTicket = useCallback(
    async (file: string) => {
      if (!selectedProjectId) return null;
      const fresh = await board.openTask(selectedProjectId, file);
      return fresh?.kind === "ticket" ? fresh.detail : null;
    },
    [board, selectedProjectId],
  );
  const ticketEditing = useTicketEditing(
    openTask?.kind === "ticket" ? openTask.detail : null,
    board.saveTicket,
    rereadTicket,
    board.vaultVersion,
  );

  /*
    The workspace a delegated agent is born into is the task's own project — never whichever
    workspace happens to be focused. A task from `interviews` must not spawn a worker in `lotus`.
  */
  /*
    Stable, so the execution hook is not rebuilt on every render of this panel — an inline arrow
    here rebuilds the spawner's primitives and every callback hanging off them.
  */
  const updateTaskForDelegation = useCallback(
    (taskId: string, patch: Parameters<typeof board.editTask>[1]) => board.editTask(taskId, patch),
    [board],
  );


  /*
    Which workspace a delegation is born into, for BOTH shapes of open record.

    A Lotus task carries its own. A vault ticket carries none — it belongs to no workspace — so it
    is the target chosen in the panel. Reading only the task's left this `null` whenever a ticket
    was open, which made Delegate report "open a workspace first" while a target sat selected
    beside it, and would have spawned into the wrong place had the button been reachable.
  */
  const writableProjects = useMemo(
    () => board.projects.filter((project) => capabilitiesOf(project).holdsTasks),
    [board.projects],
  );
  const [ticketTarget, setTicketTarget] = useState<string | null>(null);
  const [delegatingTicket, setDelegatingTicket] = useState(false);
  const folderTarget = useMemo(
    () => workspaceInFolder(writableProjects, defaultTargetFolder, (id) => spawner?.workspace?.(id)?.cwd),
    [defaultTargetFolder, writableProjects, spawner],
  );
  /*
    A GitHub issue defaults to its repo's checkout (`useIssueCheckout`): the board's folder is where
    the person is looking, the checkout is where the code is. A target picked by hand wins over both.
  */
  const openIssueRepo = openTask?.kind === "github" ? githubRepoFor(vault.sources, openTask.projectId, openTask.issue) : null;
  const issueCheckout = useIssueCheckout(openIssueRepo, localWorkspaces, folderTarget, findIssueCheckout);
  const checkoutTarget =
    issueCheckout && writableProjects.some((project) => project.id === issueCheckout.workspaceId) ? issueCheckout : null;
  const targetProjectId = ticketTarget ?? checkoutTarget?.workspaceId ?? folderTarget ?? writableProjects[0]?.id ?? null;
  // The checkout's folder only when the agent goes to its workspace: a repo inside a parent workspace.
  const issueCheckoutUsed = checkoutTarget && targetProjectId === checkoutTarget.workspaceId ? checkoutTarget : undefined;

  const delegation = useDelegation(
    openTask?.kind === "task"
      ? openTask.task.workspaceId
      : openTask?.kind === "ticket" || openTask?.kind === "notion" || openTask?.kind === "github"
        ? targetProjectId
        : null,
    spawner?.openPane ?? spawner?.addPane ?? null,
    updateTaskForDelegation,
    undefined,
    delegateUnavailable,
    spawner?.launchesAgentDirectly,
  );

  const vocabularyOf = useMemo(() => vocabularyByProject(board.projectsById), [board.projectsById]);

  const delegateTicket = useCallback(
    async (detail: VaultTicketDetail, preset: DelegationPreset) => {
      const projectId = targetProjectId;
      if (!projectId) {
        setDelegateError("Open a workspace first — a ticket needs somewhere to be worked.");
        return;
      }
      setDelegatingTicket(true);
      /*
        A task from this ticket still open in that workspace is where the work already is: the
        next agent joins it, and its history stays in one place. Only otherwise is a new task made
        ALONGSIDE the ticket — the vault is never written to, and the task is what carries the
        pane, the history and the session.
      */
      const reuse = taskToReuseForTicket(board.tasks, detail.ticket.file, projectId, vocabularyOf);
      const reopened = reuse ? await board.openTask(projectId, reuse.id) : null;
      const target =
        reopened?.kind === "task"
          ? reopened.task
          : await board.createFromTicket(projectId, taskDraftFromTicket(detail));
      if (!target) {
        setDelegatingTicket(false);
        return;
      }
      const message = await delegation.delegate(target, preset, detail.ticket.ticket);
      setDelegatingTicket(false);
      setDelegateError(message);
      if (!message) onClose();
    },
    [board, delegation, onClose, targetProjectId, vocabularyOf],
  );

  /*
    A Notion ticket, delegated. Same shape as a vault ticket's: an open task from this page in that
    workspace is joined, otherwise one is made alongside the ticket. The agent is denied every Notion
    MCP tool that writes (PLAN S35), and a preset that cannot be denied them is refused.
  */
  const delegateNotion = useCallback(
    async (projectId: string | null, row: NotionRow, sourceName: string, preset: DelegationPreset, body: string | null) => {
      if (!projectId) {
        setDelegateError("Open a workspace first — a ticket needs somewhere to be worked.");
        return;
      }
      setDelegatingTicket(true);
      const reuse = taskToReuseForTicket(board.tasks, row.pageId, projectId, vocabularyOf);
      const reopened = reuse ? await board.openTask(projectId, reuse.id) : null;
      const target =
        reopened?.kind === "task"
          ? reopened.task
          : await board.createFromTicket(projectId, taskDraftFromNotionRow(row, sourceName, body));
      if (!target) {
        setDelegatingTicket(false);
        return;
      }
      const message = await delegation.delegate(target, preset, row.key, { denyTools: NOTION_WRITE_DENY_RULES });
      setDelegatingTicket(false);
      setDelegateError(message);
      if (!message) onClose();
    },
    [board, delegation, onClose, vocabularyOf],
  );

  /*
    A GitHub issue, delegated (ADR-0048 §11). Same shape again: an open task from `owner/name#123` in
    that workspace is joined, otherwise one is made alongside the issue. The agent is denied the
    `gh issue` and GitHub MCP issue writes; pushing and opening a pull request stay open to it.
  */
  const delegateGitHub = useCallback(
    async (
      projectId: string | null,
      repo: string,
      read: { issue: GitHubIssue; comments: readonly GitHubIssueComment[] },
      sourceName: string,
      preset: DelegationPreset,
      checkout?: { cwd: string; namesake?: string },
    ) => {
      if (!projectId) {
        setDelegateError("Open a workspace first — a ticket needs somewhere to be worked.");
        return;
      }
      setDelegatingTicket(true);
      const reuse = taskToReuseForTicket(board.tasks, githubIssueRef(repo, read.issue.number), projectId, vocabularyOf);
      const reopened = reuse ? await board.openTask(projectId, reuse.id) : null;
      const target =
        reopened?.kind === "task"
          ? reopened.task
          : await board.createFromTicket(projectId, taskDraftFromGitHubIssue(read.issue, read.comments, repo, sourceName));
      if (!target) {
        setDelegatingTicket(false);
        return;
      }
      const message = await delegation.delegate(target, preset, `#${read.issue.number}`, {
        denyTools: GITHUB_ISSUE_WRITE_DENY_RULES,
        ...(checkout ? { cwd: checkout.cwd } : {}),
        ...(checkout?.namesake ? { note: namesakeCheckoutNote(repo, checkout.namesake) } : {}),
      });
      setDelegatingTicket(false);
      setDelegateError(message);
      if (!message) onClose();
    },
    [board, delegation, onClose, vocabularyOf],
  );
  // A Notion or GitHub task keeps its agents from writing there, however it is delegated.
  const ticketDelegateOptions = useCallback(
    (task: BridgeTask) => ticketDelegateOptionsFor(task, localWorkspaces, findIssueCheckout),
    [findIssueCheckout, localWorkspaces],
  );
  const githubRepoOf = (sourceId: string, issue: GitHubIssue) => githubRepoFor(vault.sources, sourceId, issue);

  /**
   * A Factory Run needs the source's repo AND its gh account; both come from the settings entry
   * only, so an issue whose source is gone shows no Factory Run rather than a guessed account.
   */
  const githubFactoryOf = (sourceId: string) => {
    const source = vault.sources?.find((s): s is GitHubSourceConfig => s.kind === "github" && s.id === sourceId);
    return source
      ? { client: factoryRuns, repo: source.repo, account: source.account, workspaces: localWorkspaces, onOpenRun: onOpenFactoryRun }
      : undefined;
  };

  /**
   * A Notion ticket built as a Factory Run (#168): its code is in one of the GitHub sources, picked
   * on the card. The page is read when the run starts — read only, nothing is written to Notion.
   */
  const notionFactoryOf = (sourceId: string, pageId: string) => {
    const repos = (vault.sources ?? [])
      .filter((s): s is GitHubSourceConfig => s.kind === "github")
      .map(({ id, repo, account }) => ({ id, repo, account }));
    return {
      client: factoryRuns,
      sourceId,
      repos,
      workspaces: localWorkspaces,
      readBody: async () => notionTicketBody(await factoryNotionTicket(pageId)),
      onOpenRun: onOpenFactoryRun,
    };
  };

  const keyOf = useCallback(
    (task: TrackerTask) => trackerTaskKey(task, board.projectsById),
    [board.projectsById],
  );

  /*
    Tickets matched with a note of the same key (PLAN S37): the "notes" badge and the Notes section.
    Empty unless a source asked for it AND a vault is there to match against — then nothing on
    screen mentions notes at all (SOURCES 05).
  */
  const notes = useMemo(() => notesByKey(board.tasks, board.projectsById), [board.projectsById, board.tasks]);
  const notesSet = useMemo(() => new Set(notes.keys()), [notes]);

  /*
    The Notion page an open vault note can be refreshed from (PLAN S38): the ticket matched to it by
    key, else the page its `notion:` link names, if that page is on a board here. Only 12 of the
    real vault's notes carry a link, so the key is the way most of them are found.
  */
  const [pulling, setPulling] = useState(false);
  // A review belongs to the note it was opened on; stepping to another note closes it.
  useEffect(() => setPulling(false), [selectedTaskId]);
  // Every panel shows why the last Delegate failed (LOT2-108); it belongs to the panel it failed on.
  useEffect(() => setDelegateError(null), [selectedTaskId]);
  const openNote = openTask?.kind === "ticket" ? (ticketEditing?.state.detail ?? openTask.detail) : null;
  const pullSource = useMemo(() => {
    if (!openNote || !board.saveTicket) return null;
    const file = openNote.ticket.file;
    let found: TrackerTask | undefined;
    for (const [rowId, noteFile] of notes) {
      if (noteFile !== file) continue;
      found = board.tasks.find((task) => task.id === rowId);
      if (found) break;
    }
    const linked = notionPageIdOf(openNote.ticket.notion);
    if (!found && linked) {
      found = board.tasks.find(
        (task) => board.projectsById.get(task.projectId)?.source?.kind === "notion" && samePageId(task.id, linked),
      );
    }
    const row = found ? board.notionRows?.rowOf(found.projectId, found.id) : null;
    return row ? row : null;
  }, [board.notionRows, board.projectsById, board.saveTicket, board.tasks, notes, openNote]);
  const pulledBody = openNote?.sections.find((section) => section.heading === PULLED_SECTION)?.body ?? "";
  /*
    The page's edit time is read BEFORE its body, so the body holds at least that version and the
    note is never stamped newer than what it got. The board's copy of the row can be a minute old,
    which is why it is only the fallback.
  */
  const loadPull = async () => {
    const pageId = pullSource!.pageId;
    const editedAt = notion.pageEditedTime ? await notion.pageEditedTime(pageId) : pullSource!.lastEditedTime;
    return { editedAt, page: await notion.pageMarkdown(pageId) };
  };
  const applyPull = async (body: string | null, editedAt: string): Promise<string | null> => {
    if (!openNote || !pullSource || !board.saveTicket) return "This note cannot be updated from here.";
    try {
      const outcome = await board.saveTicket(openNote.ticket.file, openNote.revision, {
        ...(body !== null ? { ownedSection: { heading: PULLED_SECTION, body } } : {}),
        notionPulled: editedAt,
      });
      // The editor holds its own copy of the note; it reads the file again rather than guess.
      ticketEditing?.reload();
      return outcome.kind === "conflict"
        ? "This note changed in Obsidian a moment ago, so nothing was written. Review the changes again."
        : null;
    } catch (cause) {
      return `The note was not updated: ${String(cause)}`;
    }
  };
  const notesPlace = board.projects.find((project) => project.source?.kind === "obsidian") ?? null;
  const noteOf = (rowId: string) => {
    const file = notes.get(rowId);
    if (!file || !notesPlace?.source) return undefined;
    return {
      name: `${notesPlace.name} / ${file.split("/").pop() ?? file}`,
      mark: <TicketSourceMark kind={notesPlace.source.kind} size={12} />,
      hint: `Your ${TICKET_SOURCE_LABELS[notesPlace.source.kind]} note for this ticket, matched by key.`,
      onOpen: () => setSelectedTaskId(file),
    };
  };


  /*
    A ticket source's manual order is kept in the layout, not in its files — so its rows are given
    their place here, before anything sorts them. A Lotus task carries its own `position`.
  */
  const ticketOrder = layout.ticketOrder;
  const placed = useMemo(() => {
    if (!ticketOrder || Object.keys(ticketOrder).length === 0) return board.tasks;
    return board.tasks.map((task) => {
      const project = board.projectsById.get(task.projectId);
      if (!project?.source) return task;
      const place = readTicketPlace(ticketOrder, project.id, task.id, project.source.kind === "obsidian");
      return place === undefined ? task : { ...task, position: place };
    });
  }, [board.projectsById, board.tasks, ticketOrder]);

  const scoped = useMemo(() => {
    return selection === null
        ? placed
        : selection === "active"
          ? // The same question the count beside it answers — never the `cellId` claim alone.
            placed.filter((task) => isActiveTask(task, vocabularyOf(task), activities))
          : placed.filter((task) => task.projectId === selection);
  }, [activities, placed, selection, vocabularyOf]);

  const visible = useMemo(() => {
    // "Finished" is asked of each task's own project: `released` ends a vault ticket, `complete` a
    // Lotus task, and neither word means anything to the other.
    const found = filterTasks(scoped, { query, openOnly: hideDone }, { keyOf, vocabularyOf });
    return applyFilterRules(found, rules, me);
  }, [hideDone, keyOf, me, query, rules, scoped, vocabularyOf]);

  /*
    What the filter menus offer: the projects and tasks of THIS view. A single board lists its own
    people and statuses; "All tasks" lists every project's, grouped by whose words they are.
  */
  const viewProjects = useMemo(() => {
    if (typeof selection === "string" && selection !== "active") {
      const project = board.projectsById.get(selection);
      return project ? [project] : [];
    }
    const present = new Set(scoped.map((task) => task.projectId));
    const inView = board.projects.filter((project) => present.has(project.id));
    return inView.length ? inView : board.projects.filter((project) => !project.source);
  }, [board.projects, board.projectsById, scoped, selection]);
  const filterProperties = useMemo(() => availableProperties(scoped, viewProjects), [scoped, viewProjects]);
  const optionsFor = useCallback(
    (property: FilterProperty) => filterOptions(property, scoped, viewProjects),
    [scoped, viewProjects],
  );
  const filtering = rules.some(ruleIsActive);

  // Lotus's own words for now. Project-first grouping, where each project brings its own
  // vocabulary, is the next slice.
  /*
    Project first, status inside it — decided when two vocabularies first had to share one list.
    A single project's view still reads as plain status sections, because only one group survives.
  */
  const groups = useMemo(
    () => groupTasksByProject(visible, board.projects, sort),
    [board.projects, sort, visible],
  );
  /*
    The rows exactly as the list draws them — project, then status section, then sort — so ↑ ↓ in
    an open task step to the row that was visually above or below it.
  */
  const drawnIds = useMemo(
    () => groups.flatMap((group) => group.sections.flatMap((section) => section.tasks.map((row) => row.id))),
    [groups],
  );
  const position = selectedTaskId ? listPosition(drawnIds, selectedTaskId) : null;

  /* ── The list's keyboard, ticks and folds (Tasks revamp D4, D6, D8) ─────────────────────── */

  const collapsedIn = useCallback(
    (projectId: string) =>
      new Set([...collapsed].filter((key) => key.startsWith(`${projectId}:`)).map((key) => key.slice(projectId.length + 1))),
    [collapsed],
  );
  const toggleSection = (projectId: string, status: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      const key = `${projectId}:${status}`;
      if (!next.delete(key)) next.add(key);
      return next;
    });
  /** Rows the eye can see: drawn, and not inside a folded section. What J/K and Shift-tick walk. */
  const shownIds = useMemo(
    () =>
      groups.flatMap((group) =>
        group.sections
          .filter((section) => !collapsed.has(`${group.project.id}:${section.status}`))
          .flatMap((section) => section.tasks.map((row) => row.id)),
      ),
    [collapsed, groups],
  );
  const pickable = useCallback(
    (id: string) => {
      const task = board.tasks.find((row) => row.id === id);
      return Boolean(task && capabilitiesOf(board.projectsById.get(task.projectId)).editRows);
    },
    [board.projectsById, board.tasks],
  );
  const togglePick = useCallback(
    (task: TrackerTask, range: boolean) => {
      // Read before the updater runs: React may run it after the anchor below has moved.
      const from = pickAnchor.current ? shownIds.indexOf(pickAnchor.current) : -1;
      setPicked((current) => {
        const next = new Set(current);
        const to = shownIds.indexOf(task.id);
        if (range && from !== -1 && to !== -1) {
          const [a, b] = from < to ? [from, to] : [to, from];
          for (const id of shownIds.slice(a, b + 1)) if (pickable(id)) next.add(id);
        } else if (!next.delete(task.id)) {
          next.add(task.id);
        }
        return next;
      });
      pickAnchor.current = task.id;
    },
    [pickable, shownIds],
  );
  const pickAllVisible = () => setPicked(new Set(shownIds.filter(pickable)));
  const pickedTasks = useMemo(() => board.tasks.filter((task) => picked.has(task.id)), [board.tasks, picked]);
  /*
    Status is offered when every ticked row speaks ONE vocabulary — compared by the vocabulary, not
    the project: every Lotus workspace shares Lotus's, so ticking rows from two workspaces still
    sets status. Only a mix with a vault (other words) hides it.
  */
  const bulkVocabulary = useMemo(() => {
    const vocabularies = new Set(
      pickedTasks.map((task) => board.projectsById.get(task.projectId)?.vocabulary ?? LOTUS_VOCABULARY),
    );
    return vocabularies.size === 1 ? [...vocabularies][0] : null;
  }, [board.projectsById, pickedTasks]);
  const editPicked = async (patch: Partial<Pick<TrackerTask, "status" | "priority">>, what: string) => {
    const before = pickedTasks.map((task) => ({ ...task }));
    setPicked(new Set());
    // One write per row: the store has no batch call, and each row keeps its own rollback. Waited
    // for, so the toast reports what was saved — the board's own error line keeps only the last
    // write's answer, and a later success would wipe an earlier failure from it.
    const errors = await Promise.all(before.map((task) => board.editTask(task.id, patch)));
    const saved = before.filter((_, index) => errors[index] === null);
    const firstError = errors.find((error) => error !== null);
    const noun = (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`;
    setBulkUndo({
      message: !firstError
        ? `${noun(saved.length)} → ${what}`
        : saved.length === 0
          ? `Nothing changed: ${firstError}`
          : `${saved.length} of ${noun(before.length)} → ${what} · ${before.length - saved.length} failed: ${firstError}`,
      before: saved,
    });
  };

  /*
    J/K move the cursor, Enter opens it, S/P open its status/priority menu, X ticks it, C writes a
    new task, ⌘A ticks every row in view. With ticks, S/P open the bulk bar's menus instead and
    Escape clears the ticks before it does anything else. Only while the list is on screen, and
    never while a dialog or a text field has the keys. A ref, so the handler reads this render.
  */
  const listKeys = useRef<(event: KeyboardEvent) => void>(() => {});
  listKeys.current = (event) => {
    if (selectedTaskId || event.defaultPrevented || isTypingTarget(event.target)) return;
    if (document.querySelector("[aria-modal='true']")) return;
    if (event.altKey || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() !== "a")) return;
    const openMenu = (scope: string, kind: string) => {
      const details = document.querySelector<HTMLDetailsElement>(`${scope} details[data-kind="${kind}"]`);
      if (!details) return false;
      details.open = true;
      return true;
    };
    const cursorRow = cursorId ? `.tk-row[data-task-id="${CSS.escape(cursorId)}"]` : null;
    const key = event.key.toLowerCase();
    if (event.key === "Escape" && picked.size > 0) {
      event.preventDefault();
      setPicked(new Set());
      return;
    }
    if (key === "a" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      pickAllVisible();
      return;
    }
    if (key === "j" || key === "k") {
      if (shownIds.length === 0) return;
      event.preventDefault();
      const at = cursorId ? shownIds.indexOf(cursorId) : -1;
      const next = at === -1 ? 0 : Math.max(0, Math.min(shownIds.length - 1, at + (key === "j" ? 1 : -1)));
      setCursorId(shownIds[next]);
      document
        .querySelector(`.tk-row[data-task-id="${CSS.escape(shownIds[next])}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (key === "c") {
      event.preventDefault();
      startNewTask();
      return;
    }
    if (key === "s" || key === "p") {
      const kind = key === "s" ? "status" : "priority";
      const opened = picked.size > 0 ? openMenu(".tk-bulk", kind) : cursorRow ? openMenu(cursorRow, kind) : false;
      if (opened) event.preventDefault();
      return;
    }
    if (!cursorId || !shownIds.includes(cursorId)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      setSelectedTaskId(cursorId);
      return;
    }
    if (key === "x" && pickable(cursorId)) {
      event.preventDefault();
      const task = board.tasks.find((row) => row.id === cursorId);
      if (task) togglePick(task, event.shiftKey);
    }
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => listKeys.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const counts = useMemo(
    () => countTasks(board.tasks, vocabularyOf, activities),
    [activities, board.tasks, vocabularyOf],
  );

  const navProjects = useMemo(
    () =>
      board.projects.map((project) => ({
        ...project,
        taskCount: board.tasks.filter((task) => task.projectId === project.id).length,
      })),
    [board.projects, board.tasks],
  );

  /*
    Escape steps back ONE level: out of a task first, and only out of the tracker when no task is
    open. Closing the whole panel from inside a task would throw away two steps for one key, and
    the way back into that task is another two.
  */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // `/` finds, as it does in most trackers — unless the key is being typed into something.
      if (event.key === "/" && !isTypingTarget(event.target) && searchRef.current) {
        event.preventDefault();
        searchRef.current.focus();
        return;
      }
      if (event.key !== "Escape") return;
      // Already answered by something inside — a rename it cancelled, a menu it closed. One key,
      // one step: stepping the tracker back as well would throw away the level that was left.
      if (event.defaultPrevented) return;
      // An open modal is the innermost level. Its own handler normally catches Escape first; this
      // covers focus that has wandered outside it (a click on the backdrop's edge, say).
      if (presetEditor) {
        setPresetEditor(null);
        return;
      }
      if (pulling) {
        setPulling(false);
        return;
      }
      if (addingNotion) {
        setAddingNotion(false);
        return;
      }
      if (addingGitHub) {
        setAddingGitHub(false);
        return;
      }
      if (addingSource) {
        setAddingSource(false);
        return;
      }
      if (composing) {
        setComposing(false);
        return;
      }
      if (selectedTaskId) {
        setSelectedTaskId(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addingGitHub, addingNotion, addingSource, composing, onClose, presetEditor, pulling, selectedTaskId]);

  // Reading the record is a trip to the store, so it happens when a row is opened, not on render.
  useEffect(() => {
    if (!selectedTaskId) {
      setOpenTask(undefined);
      return;
    }
    const row = board.tasks.find((task) => task.id === selectedTaskId);
    if (!row) return;
    let cancelled = false;
    setOpenTask(undefined);
    void board.openTask(row.projectId, selectedTaskId).then((full) => {
      if (!cancelled) setOpenTask(full);
    });
    return () => {
      cancelled = true;
    };
    // `board.tasks` is a new array whenever anything in the list changes — including this task's
    // own optimistic edit, which must not re-read the record it just changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.openTask, selectedTaskId]);

  /*
    The open task changed outside this window — an agent reported, a reviewer gave a verdict. Read
    it again, QUIETLY: the record on screen stays until the new one arrives, because flashing
    "Reading the task…" for an update would make every report look like a reload.
  */
  const lastChange = board.lastChange;
  useEffect(() => {
    if (!lastChange || lastChange.taskId !== selectedTaskId) return;
    let cancelled = false;
    void board.openTask(lastChange.workspaceId, lastChange.taskId).then((full) => {
      if (!cancelled && full) setOpenTask(full);
    });
    return () => {
      cancelled = true;
    };
    // Keyed on the change alone: opening a different task is the effect above's job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastChange]);

  /*
    One move is usually one write — the midpoint of the new neighbours. Sent through `editTask`,
    so the row moves at once and moves back if the store refuses.
  */
  const moveRow = useCallback(
    (section: readonly TrackerTask[], taskId: string, toIndex: number) => {
      const writes = reorderWrites(section, taskId, toIndex);
      /*
        A section is one project's, so its rows all live in one place: a ticket source keeps them
        in the layout, a workspace in its own store.
      */
      const moved = board.tasks.find((task) => task.id === taskId);
      const project = moved ? board.projectsById.get(moved.projectId) : undefined;
      if (project?.source) {
        // Only rows the source still holds keep a place: a file deleted or renamed in Obsidian
        // must not keep one in the layout forever.
        const refs = new Set(
          board.tasks.filter((task) => task.projectId === project.id).map((task) => task.id),
        );
        onLayoutChange({
          ticketOrder: writeTicketPlaces(
            ticketOrder ?? {},
            project.id,
            refs,
            writes,
            project.source.kind === "obsidian",
          ),
        });
        return;
      }
      for (const write of writes) void board.editTask(write.id, { position: write.position });
    },
    [board, onLayoutChange, ticketOrder],
  );


  /*
    Picking a view in the sidebar is asking to SEE that view. With a task open, changing only the
    filter left the task on screen and the click looked dead — so a pick also closes the task.
  */
  // On a Manage Notion board, New task makes a ticket in that database (S49).
  const startNewTask = () =>
    selectedNotionSource && notionConfigOf(selectedNotionSource.id)?.permission === "manage"
      ? setCreatingIn(selectedNotionSource.id)
      : setComposing(true);

  const selectView = useCallback(
    (next: string | null | "active") => {
      // Each view keeps its own filters, so nothing chosen in one can empty another.
      setSelection(next);
      setSelectedTaskId(null);
      // Ticks are about rows in view: carried into another view they would act on rows unseen.
      setPicked(new Set());
    },
    [],
  );

  const navToggle = (
    <button
      type="button"
      className="ws-chrome-button"
      onClick={() => onLayoutChange({ taskNavVisible: !navVisible })}
      aria-label={navVisible ? "Hide sidebar" : "Show sidebar"}
      aria-pressed={navVisible}
      title={navVisible ? "Hide sidebar" : "Show sidebar"}
    >
      {navVisible ? <PanelRightClose size={15} strokeWidth={1.75} /> : <PanelRight size={15} strokeWidth={1.75} />}
    </button>
  );

  const selectedNotionSource =
    typeof selection === "string" && selection !== "active" && board.projectsById.get(selection)?.source?.kind === "notion"
      ? board.projectsById.get(selection)!
      : null;
  const selectedGitHubSource =
    typeof selection === "string" && selection !== "active" && board.projectsById.get(selection)?.source?.kind === "github"
      ? board.projectsById.get(selection)!
      : null;

  const heading =
    selection === null
      ? "All tasks"
      : selection === "active"
        ? "Running agents"
        : board.projectsById.get(selection)?.name ?? "Project";

  return (
    <div className="ws-body tk-body" ref={bodyRef}>
      <div className="ws-column tk-column">
        {selectedTaskId ? (
          openTask === undefined ? (
            <div className="tk-skel-detail">
              <SkeletonDetail label="Reading the task" />
            </div>
          ) : openTask === null ? (
            <p className="tk-error">That task could not be read.</p>
          ) : openTask.kind === "notion" ? (
            <NotionRowPanel
              // One page per ticket: nothing typed or waiting on one carries to the next.
              key={openTask.row.pageId}
              row={notionRowShown ?? openTask.row}
              client={notion}
              editing={notionEditing(openTask.projectId, notionRowShown ?? openTask.row)}
              subTickets={notionSubTickets(openTask.projectId, notionRowShown ?? openTask.row)}
              workedAs={tasksFromTicket(board.tasks, openTask.row.pageId).map((task) => ({
                id: task.id,
                key: keyOf(task),
                status: task.status,
                vocabulary: vocabularyOf(task),
                projectName: board.projectsById.get(task.projectId)?.name ?? "",
              }))}
              note={noteOf(openTask.row.pageId)}
              factory={notionFactoryOf(openTask.projectId, openTask.row.pageId)}
              onOpenTask={setSelectedTaskId}
              delegation={{
                presets: delegation.presets,
                ready: delegation.ready,
                busy: delegatingTicket,
                error: delegateError,
                targets: writableProjects,
                targetId: targetProjectId ?? "",
                onTargetChange: setTicketTarget,
                onDelegate: (preset, body) =>
                  void delegateNotion(
                    targetProjectId,
                    openTask.row,
                    board.projectsById.get(openTask.projectId)?.name ?? "Notion",
                    preset,
                    body,
                  ),
                onNewPreset: () => setPresetEditor("new"),
                onEditPreset: setPresetEditor,
              }}
              projectName={board.projectsById.get(openTask.projectId)?.name ?? "Notion"}
              syncLine={board.projectsById.get(openTask.projectId)?.source?.syncLine}
              vocabulary={board.projectsById.get(openTask.projectId)?.vocabulary ?? LOTUS_VOCABULARY}
              position={position}
              onBack={() => setSelectedTaskId(null)}
              onStep={setSelectedTaskId}
              barTrailing={navToggle}
            />
          ) : openTask.kind === "github" ? (
            <GitHubIssuePanel
              key={openTask.issue.number}
              issue={openTask.issue}
              sourceId={openTask.projectId}
              client={github}
              delegation={{
                presets: delegation.presets,
                ready: delegation.ready,
                busy: delegatingTicket,
                error: delegateError,
                targets: writableProjects,
                targetId: targetProjectId ?? "",
                onTargetChange: setTicketTarget,
                onDelegate: (preset, read) => {
                  const repo = githubRepoOf(openTask.projectId, read.issue);
                  if (!repo) {
                    setDelegateError("Lotus cannot tell the repo this issue belongs to. Add the repo as a source again, then delegate.");
                    return;
                  }
                  void delegateGitHub(
                    targetProjectId,
                    repo,
                    read,
                    board.projectsById.get(openTask.projectId)?.name ?? "GitHub",
                    preset,
                    issueCheckoutUsed && { cwd: issueCheckoutUsed.cwd, namesake: issueCheckoutUsed.namesake },
                  );
                },
                onNewPreset: () => setPresetEditor("new"),
                onEditPreset: setPresetEditor,
              }}
              factory={githubFactoryOf(openTask.projectId)}
              projectName={board.projectsById.get(openTask.projectId)?.name ?? "GitHub"}
              position={position}
              onBack={() => setSelectedTaskId(null)}
              onStep={setSelectedTaskId}
              barTrailing={navToggle}
            />
          ) : openTask.kind === "ticket" ? (
            <VaultTicketPanel
              detail={openTask.detail}
              projectName={(selectedProjectId && board.projectsById.get(selectedProjectId)?.name) || "Tickets"}
              onBack={() => setSelectedTaskId(null)}
              position={position}
              onStep={setSelectedTaskId}
              barTrailing={navToggle}
              editing={ticketEditing}
              pull={
                pullSource
                  ? {
                      section: PULLED_SECTION,
                      editedAt: pullSource.lastEditedTime,
                      url: pullSource.url,
                      pulledAt: openNote?.ticket.notionPulled ?? null,
                      newer: notionIsNewer(pullSource.lastEditedTime, openNote?.ticket.notionPulled),
                      format: pullTime,
                      onReview: () => setPulling(true),
                    }
                  : null
              }
              hasKey={(key) => board.tasks.some((task) => task.key === key)}
              workedAs={tasksFromTicket(board.tasks, openTask.detail.ticket.file).map((task) => ({
                id: task.id,
                key: keyOf(task),
                status: task.status,
                vocabulary: vocabularyOf(task),
                projectName: board.projectsById.get(task.projectId)?.name ?? "",
              }))}
              onOpenTask={setSelectedTaskId}
              delegation={{
                presets: delegation.presets,
                ready: delegation.ready,
                busy: delegatingTicket,
                error: delegateError,
                targets: writableProjects,
                targetId: targetProjectId ?? "",
                onTargetChange: setTicketTarget,
                onDelegate: (preset) => void delegateTicket(openTask.detail, preset),
                onNewPreset: () => setPresetEditor("new"),
                onEditPreset: setPresetEditor,
              }}
              onOpenKey={(key) => {
                const target = board.tasks.find((task) => task.key === key);
                if (target) setSelectedTaskId(target.id);
              }}
            />
          ) : (
            <TaskDetailPanel
              task={openTask.task}
              /* The key is a LIST fact — prefix plus number — so it is read through the same
                 mapping the rows use rather than recomputed from the stored task. */
              taskKey={keyOf(toTrackerTask(openTask.task))}
              project={board.projectsById.get(openTask.task.workspaceId)}
              /* A vault row's id IS its file name, which is exactly what `source.ref` holds. */
              onOpenSource={(ref) => {
                if (board.tasks.some((row) => row.id === ref)) setSelectedTaskId(ref);
              }}
              onResume={(command) => {
                void delegation.resume(openTask.task, command).then((message) => {
                  setDelegateError(message);
                  if (!message) onClose();
                });
              }}
              delegation={{
                presets: delegation.presets,
                ready: delegation.ready,
                busy: delegation.inFlight.has(openTask.task.id),
                error: delegateError,
                onDelegate: (preset) => {
                  // The message is the whole point of delegate returning one: the first version of
                  // this discarded it, so a delegation that threw looked exactly like a button
                  // that did nothing.
                  const task = openTask.task;
                  void ticketDelegateOptions(task)
                    .then((options) => delegation.delegate(task, preset, keyOf(toTrackerTask(task)), options))
                    .then((message) => {
                      setDelegateError(message);
                      // Tasks covers the work area. A pane born behind it is a pane nobody sees,
                      // so a delegation that worked steps out of the way to show it.
                      if (!message) onClose();
                    });
                },
                onNewPreset: () => setPresetEditor("new"),
                onEditPreset: setPresetEditor,
              }}
              onBack={() => setSelectedTaskId(null)}
              position={position}
              onStep={setSelectedTaskId}
              barTrailing={navToggle}
              onEditBody={
                board.editTaskBody
                  ? (patch) => {
                      const { workspaceId, id } = openTask.task;
                      // The record on screen follows at once, so the editor's stored value is what
                      // was just saved — not the older text an outside change would be compared with.
                      setOpenTask((current) =>
                        current && current.kind === "task" && current.task.id === id
                          ? { ...current, task: { ...current.task, ...patch } }
                          : current,
                      );
                      void board.editTaskBody?.(workspaceId, id, patch);
                    }
                  : undefined
              }
              onEdit={(taskId, patch) => {
                // The panel is shown from the record just read, so it has to be told too —
                // otherwise the mark you just changed springs back while the list shows the change.
                setOpenTask((current) =>
                  current && current.kind === "task"
                    ? { ...current, task: { ...current.task, ...patch } }
                    : current,
                );
                void board.editTask(taskId, patch);
              }}
            />
          )
        ) : (
        <>
        <header className="tk-head">
          <h1 className="tk-head-title">{heading}</h1>
          <span className="tk-head-count" aria-label={`${visible.length} ${visible.length === 1 ? "task" : "tasks"}`}>
            {visible.length}
          </span>
          {/* The view's tools sit in the title row (D3): one band of chrome, not two. */}
          <TaskFilterBar
            rules={rules}
            onRulesChange={setRules}
            properties={filterProperties}
            optionsFor={optionsFor}
            me={me}
            onSetMe={(next) => onLayoutChange({ taskMe: next })}
            sort={sort}
            onSortChange={setSort}
            query={query}
            onQueryChange={setQuery}
            searchRef={searchRef}
            hideDone={hideDone}
            onHideDoneChange={(next) => onLayoutChange({ taskHideDone: next })}
            onRefresh={board.refresh}
          />
          {selectedNotionSource && vault.removeSource ? (
            <button
              type="button"
              className="tk-button"
              onClick={() => {
                vault.removeSource?.(selectedNotionSource.id);
                void notion.forget(selectedNotionSource.id).catch(() => {
                  /* only the offline copy is left behind; nothing reads it without the source */
                });
                selectView(null);
              }}
              title="Remove this Notion database from Tasks. Nothing changes in Notion."
            >
              Remove source
            </button>
          ) : null}
          {selectedGitHubSource && vault.removeSource ? (
            <button
              type="button"
              className="tk-button"
              onClick={() => {
                vault.removeSource?.(selectedGitHubSource.id);
                void github.forget(selectedGitHubSource.id).catch(() => {
                  /* only the offline copy is left behind; nothing reads it without the source */
                });
                selectView(null);
              }}
              title="Remove this repo from Tasks. Nothing changes on GitHub."
            >
              Remove source
            </button>
          ) : null}
          {selectedNotionSource && notionConfigOf(selectedNotionSource.id) && vault.addNotionSource ? (
            <button
              type="button"
              className="tk-button"
              onClick={() => setRemapping(selectedNotionSource.id)}
              title="Choose which Notion property is which ticket field"
            >
              Fields
            </button>
          ) : null}
          <button
            type="button"
            className="tk-new"
            onClick={startNewTask}
            aria-haspopup="dialog"
            title="New task (C)"
          >
            <Plus size={14} strokeWidth={2} />
            New task
          </button>
          <button type="button" className="ws-chrome-button" onClick={onClose} aria-label="Close tasks" title="Close (Esc)">
            <X size={15} strokeWidth={1.75} />
          </button>
          {navToggle}
        </header>

        {/* A source that is not healthy says so above its rows, which stay (SOURCES 06). Only the
            sources in view: a banner about a board you are not looking at is noise. */}
        {board.projects
          .filter((project) => project.source?.health?.banner && (selection === null || selection === project.id))
          .map((project) => (
            <SourceHealthBanner
              key={project.id}
              name={project.name}
              health={project.source!.health!}
              onRetry={board.refresh}
              onReconnect={onOpenConnectors}
              onRemap={() => setRemapping(project.id)}
            />
          ))}
        {board.error ? <p className="tk-error">{board.error}</p> : null}
        {delegateError ? <p className="tk-error">{delegateError}</p> : null}

        <div className="tk-scroll">
          {groups.length === 0 && board.loading ? (
            <TaskRowsSkeleton />
          ) : groups.length === 0 ? (
            // One sentence and one way out (S6): what is empty, and the press that changes it.
            <div className="tk-empty-band">
              {board.tasks.length === 0 ? (
                <EmptyState action={<button type="button" className="rs-button rs-button--primary" onClick={startNewTask}>New task</button>}>
                  No tasks yet. Write one, or let an agent add it with the Lotus MCP tools.
                </EmptyState>
              ) : filtering ? (
                <EmptyState action={<button type="button" className="rs-button" onClick={() => setRules([])}>Clear filters</button>}>
                  Nothing matches these filters.
                </EmptyState>
              ) : (
                <EmptyState action={<button type="button" className="rs-button" onClick={() => selectView(null)}>Show all tasks</button>}>
                  Nothing in this view yet.
                </EmptyState>
              )}
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.project.id} className="tk-project">
                {/* Named only when there is more than one group to tell apart. Inside a single
                    project the heading would restate the title already above the list. */}
                {groups.length > 1 ? (
                  <header className="tk-project-head">
                    <span className="tk-project-name">{group.project.name}</span>
                    <span className="tk-project-count">{group.total}</span>
                  </header>
                ) : null}
                <TaskList
                  sections={group.sections}
                  vocabulary={group.project.vocabulary}
                  projectsById={board.projectsById}
                  keyOf={keyOf}
                  selectedTaskId={selectedTaskId}
                  withNotes={notes.size > 0 ? notesSet : undefined}
                  notesKind={notesPlace?.source?.kind}
                  onSelect={(task) => {
                    setCursorId(task.id);
                    setSelectedTaskId(task.id);
                  }}
                  /* Absent for a vault: `TaskList` reads that as a read-only list and draws the
                     marks without offering to change them. The board refuses the write too. */
                  onEdit={capabilitiesOf(group.project).editRows ? board.editTask : undefined}
                  activities={activities}
                  agentJump={agentJump}
                  onCanvasIds={canvasTasks?.ids}
                  onRevealOnCanvas={revealOnCanvas}
                  /* Only in Manual, and only where rows can be written: in any other sort the
                     order is computed, and a vault's rows are not Lotus's to reorder. */
                  onMove={sort === "manual" && capabilitiesOf(group.project).reorder ? moveRow : undefined}
                  empty={null}
                  cursorId={cursorId}
                  pickedIds={picked}
                  onTogglePick={capabilitiesOf(group.project).editRows ? togglePick : undefined}
                  collapsed={collapsedIn(group.project.id)}
                  onToggleSection={(status) => toggleSection(group.project.id, status)}
                />
              </section>
            ))
          )}
        </div>
        {pickedTasks.length > 0 ? (
          <TaskBulkBar
            count={pickedTasks.length}
            vocabulary={bulkVocabulary}
            canSetPriority={pickedTasks.every((task) => capabilitiesOf(board.projectsById.get(task.projectId)).hasPriority)}
            onStatus={(status) => void editPicked({ status }, statusLabel(bulkVocabulary ?? LOTUS_VOCABULARY, status))}
            onPriority={(priority) => void editPicked({ priority }, `priority ${taskPriorityLabel(priority).toLowerCase()}`)}
            onSelectAll={pickAllVisible}
            onClear={() => setPicked(new Set())}
          />
        ) : null}
        </>
        )}
      </div>

      {navVisible ? (
      <>
      <SplitHandle
        orientation="vertical"
        /* The nav is the pane AFTER this seam: pulling left, into the list, widens it. */
        sizes="after"
        size={navSize}
        min={NAV_MIN}
        max={navMax}
        defaultSize={NAV_DEFAULT}
        label="Resize tasks navigation"
        onResize={(next) => onLayoutChange({ taskNavWidth: next })}
      />
      <div className="ws-pane-slot" style={{ width: navSize }}>
        <TasksNavPanel
          projects={navProjects}
          vaultPath={vault.path}
          onConnectVault={(path) => vault.connect(path)}
          onDisconnectVault={vault.disconnect}
          onAddSource={() => setAddingSource(true)}
          vaultFormRequest={vaultFormRequest}
          totalCount={counts.total}
          activeCount={counts.active}
          selection={selection}
          onSelect={selectView}
          presets={delegation.presets}
          onEditPreset={setPresetEditor}
          onNewPreset={() => setPresetEditor("new")}
          recovery={
            <ClosedWorkspaceTasks
              projects={writableProjects}
              client={closedWorkspaceClient}
              onMoved={board.refresh}
            />
          }
        />
      </div>
      </>
      ) : null}

      {composing ? (
        <TaskComposerModal
          // A ticket is born in Notion and copied over by hand, so the composer must never
          // offer to create one here.
          projects={writableProjects}
          // The project the list is scoped to is the obvious home for a task typed while looking
          // at it. "All tasks" names none, so the first project stands in and can be changed.
          defaultProjectId={
            typeof selection === "string" &&
            selection !== "active" &&
            capabilitiesOf(board.projectsById.get(selection)).holdsTasks
              ? selection
              : null
          }
          onCreate={board.createTask}
          onClose={() => setComposing(false)}
        />
      ) : null}

      {pulling && pullSource && openNote ? (
        <NoteRefreshSheet
          noteKey={openNote.ticket.ticket || openNote.ticket.file}
          keptHeadings={openNote.sections.flatMap((section) => (section.heading ? [section.heading] : []))}
          current={pulledBody}
          pulledAt={openNote.ticket.notionPulled ?? null}
          load={loadPull}
          onApply={applyPull}
          blockedReason={
            ticketEditing?.state.dirty || ticketEditing?.state.saving
              ? "Your typing in this note is still being saved — try again in a moment."
              : null
          }
          onClose={() => setPulling(false)}
        />
      ) : null}
      {addingNotion && notionAccount?.state === "connected" ? (
        <AddNotionDatabaseSheet
          account={notionAccount}
          client={notion}
          existingIds={new Set(board.projects.filter((p) => p.source?.kind === "notion").map((p) => p.id))}
          notesName={notesPlace?.name ?? null}
          notesMark={notesPlace?.source ? <TicketSourceMark kind={notesPlace.source.kind} size={12} /> : null}
          onAdd={(config: NotionSourceConfig) => {
            vault.addNotionSource?.(config);
            setAddingNotion(false);
            selectView(config.id);
          }}
          onClose={() => setAddingNotion(false)}
        />
      ) : null}

      {addingGitHub && ghAccounts && ghAccounts.length > 0 ? (
        <AddGitHubRepoSheet
          accounts={ghAccounts}
          client={github}
          isAdded={(repo) =>
            (vault.sources ?? []).some((source) => source.kind === "github" && source.repo.toLowerCase() === repo.toLowerCase())
          }
          onAdd={(config: GitHubSourceConfig) => {
            vault.addGitHubSource?.(config);
            setAddingGitHub(false);
            selectView(config.id);
          }}
          onClose={() => setAddingGitHub(false)}
        />
      ) : null}

      {creatingIn ? (
        <NewNotionTicketDialog
          boardName={board.projectsById.get(creatingIn)?.name ?? "Notion"}
          onCreate={(title) => notion.create(creatingIn, title, null)}
          onRefresh={board.refresh}
          onDone={(row) => {
            board.notionRows?.putRow(creatingIn, row);
            setCreatingIn(null);
            setSelectedTaskId(row.pageId);
          }}
          onClose={() => setCreatingIn(null)}
        />
      ) : null}

      {trashing ? (
        <TrashTicketDialog
          row={trashing.row}
          boardName={board.projectsById.get(trashing.projectId)?.name ?? "Notion"}
          subTickets={board.notionRows?.subTicketsOf(trashing.projectId, trashing.row.pageId) ?? 0}
          onConfirm={() => notion.trash(trashing.projectId, trashing.row.pageId, true)}
          onDone={() => {
            board.notionRows?.removeRow(trashing.projectId, trashing.row.pageId);
            setTrashed(trashing);
            setTrashing(null);
            setSelectedTaskId(null);
          }}
          onClose={() => setTrashing(null)}
        />
      ) : null}

      {bulkUndo && !trashed ? (
        <TasksToast
          label="Bulk change"
          message={bulkUndo.message}
          action={bulkUndo.before.length ? "Undo" : "Dismiss"}
          onAction={() => {
            for (const task of bulkUndo.before) void board.editTask(task.id, { status: task.status, priority: task.priority });
            setBulkUndo(null);
          }}
          onDismiss={() => setBulkUndo(null)}
        />
      ) : null}

      {trashed ? (
        <TasksToast
          label="Moved to trash"
          message={
            trashed.error
              ? `Could not undo: ${trashed.error}`
              : `${trashed.row.key ?? "The ticket"} moved to trash in Notion`
          }
          action={trashed.error ? "Try again" : trashed.busy ? "Restoring…" : "Undo"}
          onAction={undoTrash}
          onDismiss={dismissTrashed}
          // A failed Undo stays until it is dealt with; the ticket is still in Notion's trash.
          ms={trashed.error ? 60_000 : 10_000}
        />
      ) : null}

      {remappingSource ? (
        <NotionFieldsSheet
          source={remappingSource}
          client={notion}
          notesName={notesPlace?.name ?? null}
          notesMark={notesPlace?.source ? <TicketSourceMark kind={notesPlace.source.kind} size={12} /> : null}
          onSave={(config) => {
            vault.addNotionSource?.(config);
            setRemapping(null);
          }}
          onClose={() => setRemapping(null)}
        />
      ) : null}

      {addingSource ? (
        <AddTicketSourceModal
          hasObsidian={Boolean(vault.path)}
          notionConnected={notionAccount?.state === "connected"}
          onPickNotion={() => {
            setAddingSource(false);
            setAddingNotion(true);
          }}
          githubAccounts={ghAccounts ? ghAccounts.length : null}
          onPickGitHub={() => {
            setAddingSource(false);
            setAddingGitHub(true);
          }}
          onOpenConnectors={
            onOpenConnectors
              ? () => {
                  setAddingSource(false);
                  onOpenConnectors();
                }
              : undefined
          }
          onPickObsidian={() => {
            setAddingSource(false);
            // The nav must be showing for the form to open in it.
            if (!navVisible) onLayoutChange({ taskNavVisible: true });
            setVaultFormRequest((value) => value + 1);
          }}
          onClose={() => setAddingSource(false)}
        />
      ) : null}

      {presetEditor ? (
        <PresetEditorModal
          key={presetEditor === "new" ? "new" : presetEditor.id}
          preset={presetEditor === "new" ? undefined : presetEditor}
          onSave={(draft) =>
            presetEditor === "new" ? delegation.savePreset(draft) : delegation.updatePreset(presetEditor.id, draft)
          }
          onRemove={presetEditor === "new" ? undefined : () => void delegation.removePreset(presetEditor.id)}
          onClose={() => setPresetEditor(null)}
        />
      ) : null}
    </div>
  );
}

/** Is this key landing in something that takes text — where `/` is a character, not a command? */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/** Rows in the list's own shape while the board is read, so the list does not jump when it lands. */
const SKELETON_TITLE_WIDTHS = ["62%", "48%", "71%", "55%", "40%", "66%"];
function TaskRowsSkeleton() {
  return (
    <ul className="tk-skel-rows" aria-label="Reading tasks" aria-busy="true">
      {SKELETON_TITLE_WIDTHS.map((width, index) => (
        <li key={index} className="tk-row tk-row--skeleton">
          <span className="rs-skel tk-skel-key" />
          <span className="rs-skel tk-skel-title" style={{ width }} />
        </li>
      ))}
    </ul>
  );
}
