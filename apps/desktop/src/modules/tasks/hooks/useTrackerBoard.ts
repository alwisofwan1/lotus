"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@/lib/tauri/runtime";
import { createTauriTaskClient } from "@/modules/codespace/services/bridge/task-api";
import type {
  TicketEditOutcome,
  TicketEdits,
  VaultTicketDetail,
} from "@/modules/tasks/services/vault-api";
import { useObsidianSource } from "@/modules/tasks/hooks/useObsidianSource";
import { useNotionSources, type NotionSources } from "@/modules/tasks/hooks/useNotionSources";
import type { NotionRow, NotionSourceConfig } from "@/modules/tasks/services/notion-source";
import { useGitHubIssueSources } from "@/modules/tasks/hooks/useGitHubIssueSources";
import type { GitHubIssue, GitHubSourceConfig } from "@/modules/tasks/services/github-issues-source";
import { assignProjectPrefixes } from "@/modules/tasks/services/project-prefixes";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { indexProjects, toTrackerTask } from "@/modules/tasks/services/task-mapping";
import {
  applyTrackerTaskPatch,
  prepareTaskDraft,
  restoreTrackerTask,
  taskDraftRefusalMessage,
  type TaskDraft,
} from "@/modules/tasks/services/task-draft";
import { useLivenessRecorder } from "@/modules/tasks/hooks/useLivenessRecorder";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";
import type { BridgePriority, BridgeTask, BridgeTaskStatus, TaskSource } from "@/modules/codespace/services/bridge/task-store";
import { capabilitiesOf, type TrackerProject, type TrackerTask } from "@/modules/tasks/types";

/**
 * Everything the tracker draws: the projects, their tasks, and whether the last read worked.
 *
 * Tasks are stored per workspace (`bridge_tasks.rs`), so "all tasks" is N reads, one per project.
 * They run in parallel and a project that fails does not take the others down — a tracker that
 * showed nothing because one folder's file was unreadable would hide the work that IS readable.
 */

export interface TrackerProjectInput {
  id: string;
  name: string;
}

export interface UseTrackerBoardInput {
  /** The window's workspaces, in rail order. A workspace IS a project here. */
  projects: readonly TrackerProjectInput[];
  /** Prefixes already handed out, from shell preferences. */
  storedPrefixes: Readonly<Record<string, string>>;
  /** Called when a project had to be given a new prefix, so it can be kept. */
  onPrefixesChange: (prefixes: Record<string, string>) => void;
  /**
   * The connected Obsidian vault, if there is one.
   *
   * Empty means the vault source is not registered AT ALL, rather than registered and failing:
   * most people running Lotus have no vault, and that is not an error to report.
   */
  vaultPath?: string;
  /** The configured Notion databases. Empty is the default, and not an error. */
  notionSources?: readonly NotionSourceConfig[];
  /** The configured GitHub repos (ADR-0048). Empty is the default, and not an error. */
  githubSources?: readonly GitHubSourceConfig[];
  /** The Tasks panel is open. Notion and GitHub are polled only then (PLAN S24); a vault watches regardless. */
  tasksOpen?: boolean;
  /**
   * What every pane in this window is doing. The board writes a pane's ending into the task it
   * was working — here, not in the panel, because a Delegate that worked closes the panel and the
   * ending then arrives with nothing mounted to hear it.
   */
  activities?: ReadonlyMap<string, PaneActivityState>;
}

const NO_PANES: ReadonlyMap<string, PaneActivityState> = new Map();
const NO_NOTION: readonly NotionSourceConfig[] = [];
const NO_GITHUB: readonly GitHubSourceConfig[] = [];

export interface TaskChange {
  workspaceId: string;
  taskId: string;
  seq: number;
}

/** What a row opens into. The two sources answer in shapes of their own. */
export type OpenedTask =
  | { kind: "task"; task: BridgeTask }
  | { kind: "ticket"; detail: VaultTicketDetail }
  /** A Notion page, as its source's last read described it. Its full page is task 06. */
  | { kind: "notion"; projectId: string; row: NotionRow }
  /** A GitHub issue, as its source's last sync read it. Its full panel is slice 05. */
  | { kind: "github"; projectId: string; issue: GitHubIssue };

export interface TrackerBoard {
  projects: TrackerProject[];
  projectsById: Map<string, TrackerProject>;
  tasks: TrackerTask[];
  /** True until the first read settles — not on every refresh, which would flash the list empty. */
  loading: boolean;
  /** Set when at least one project could not be read — or when a write was refused. */
  error: string | null;
  refresh: () => void;
  /** Notion sources' own rows: the choices a Manage ticket offers, and where a write's answer lands. */
  notionRows?: Pick<NotionSources, "peopleOf" | "labelsOf" | "applyRow" | "rowOf" | "removeRow" | "putRow" | "subTicketsOf" | "childrenOf">;
  /** Create a task from what someone typed. Resolves to the refusal message, or null on success. */
  createTask: (draft: TaskDraft) => Promise<string | null>;
  /**
   * Make a workable task out of a vault ticket, in a workspace that can hold one.
   *
   * Separate from `createTask` because the shapes differ: a typed task is one line and a ticket is
   * a document, and squeezing a ticket through the composer's draft would drop everything the
   * worker needs. Resolves to the task, or null when the store refused it.
   */
  createFromTicket: (
    projectId: string,
    /** No `source` for a canvas's local Task node filed into Tasks ("Add to Tasks", board 18). */
    draft: { title: string; goal: string; knowledge: string; source?: TaskSource; status?: BridgeTaskStatus; priority?: BridgePriority },
  ) => Promise<BridgeTask | null>;
  /**
   * The WHOLE stored task, for the detail panel.
   *
   * The list rows are deliberately narrow (`TrackerTask`), and the record an agent writes — intake,
   * blocker, history — is neither in them nor worth reading for every row. `null` when the store
   * could not produce it, which the panel says rather than drawing an empty record.
   */
  openTask: (projectId: string, taskId: string) => Promise<OpenedTask | null>;
  /**
   * The one write into the vault: a surgical edit of one ticket against the revision it was read
   * at (`vault_ticket_edit.rs`). Absent where there is no vault, and in tests that do not edit.
   */
  saveTicket?: (file: string, baseRevision: string, edits: TicketEdits) => Promise<TicketEditOutcome>;
  /** Bumps whenever the vault folder changed on disk, so an open ticket can re-read itself. */
  vaultVersion?: number;
  /**
   * The last task changed OUTSIDE this window — an agent writing through the MCP tools. `seq`
   * rises on every change, so the same task changing twice is two changes. The board has already
   * re-read that workspace; this is for whoever holds the whole record open.
   */
  lastChange?: TaskChange | null;
  /**
   * Change a task the list is already showing.
   *
   * Applied to the list first and sent second, because a list that waits a round-trip for every
   * status click feels broken even when it is correct. A refusal puts the old row back and says so.
   */
  /**
   * Save a task's brief or knowledge — text the list rows never show, so nothing on the list
   * changes. Resolves to the refusal, or null. Absent in tests that do not edit.
   */
  editTaskBody?: (
    projectId: string,
    taskId: string,
    patch: { goal?: string; knowledge?: string },
  ) => Promise<string | null>;
  editTask: (
    taskId: string,
    patch: Partial<Pick<TrackerTask, "title" | "status" | "priority" | "position">>,
  ) => Promise<string | null>;
}

export function useTrackerBoard({
  projects,
  storedPrefixes,
  onPrefixesChange,
  vaultPath = "",
  notionSources = NO_NOTION,
  githubSources = NO_GITHUB,
  tasksOpen = false,
  activities = NO_PANES,
}: UseTrackerBoardInput): TrackerBoard {
  const client = useMemo(() => createTauriTaskClient(), []);
  /*
    Piles, combined for the caller: the workspaces' tasks, then each ticket source's rows.

    Kept apart because they change for different reasons and at different times: the workspaces
    change when somebody in this window does something, a vault changes when Obsidian or a `git
    pull` touches a file. One pile would mean either source reloading the other for nothing. Each
    source is its own hook and owns its own pile (`useObsidianSource`).
  */
  const obsidian = useObsidianSource(vaultPath);
  const notion = useNotionSources(notionSources, { live: tasksOpen });
  const github = useGitHubIssueSources(githubSources, { live: tasksOpen });
  const [lotusTasks, setLotusTasks] = useState<TrackerTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [lotusError, setLotusError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const tasks = useMemo(
    () => [...lotusTasks, ...obsidian.tasks, ...notion.tasks, ...github.tasks],
    [github.tasks, lotusTasks, notion.tasks, obsidian.tasks],
  );
  /*
    A refused write wins: it is the thing the person just did, and burying it under a read error
    they cannot act on would answer the wrong question. Otherwise both read errors are said,
    because "one project could not be read" and "the vault could not be read" are two different
    things to go and fix.
  */
  const error = useMemo(() => {
    if (writeError) return writeError;
    const both = [lotusError, obsidian.error].filter(Boolean).join(" ");
    return both || null;
  }, [lotusError, obsidian.error, writeError]);
  /*
    The list, readable from a callback that must NOT be rebuilt whenever it changes: `editTask` is
    handed to every row, and a new identity per keystroke elsewhere in the tracker would redraw all
    of them. The ref is written in the effect below, never during render.
  */
  const tasksRef = useRef<TrackerTask[]>([]);
  // Same reason: `editTask` asks what a row's project allows, and must not be rebuilt to do it.
  const projectsByIdRef = useRef<ReadonlyMap<string, TrackerProject>>(new Map());

  // The identity of the project SET, which is what a reload depends on. Names ride along because
  // a rename changes what the rail prints, not what is read.
  const projectKey = projects.map((project) => project.id).join(" ");

  /*
    Prefixes are assigned in an effect, never during render: this writes to stored preferences,
    and a render that writes is a render that cannot be replayed. `changed` keeps a window that
    has seen every project from writing the same map back on every pass.
  */
  const onPrefixesChangeRef = useRef(onPrefixesChange);
  useEffect(() => {
    onPrefixesChangeRef.current = onPrefixesChange;
  }, [onPrefixesChange]);

  useEffect(() => {
    const { prefixes, changed } = assignProjectPrefixes(projects, storedPrefixes);
    if (changed) onPrefixesChangeRef.current(prefixes);
    // Keyed on the project set and the stored map: a project that arrives later must still get one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, storedPrefixes]);

  const trackerProjects = useMemo(
    () =>
      projects
        .map((project) => ({
          id: project.id,
          name: project.name,
          prefix: storedPrefixes[project.id] ?? "",
          color: projectColor(project.id),
          // Every project here IS a workspace, so every one of them speaks Lotus's words. A vault
          // project arrives from a different source and brings its own.
          vocabulary: LOTUS_VOCABULARY,
        }))
        // A project with no prefix yet (first render, before the effect above has stored one) is
        // still listed: its rows just show no key for a beat.
        .map((project) => project as TrackerProject),
    [projects, storedPrefixes],
  );

  // Ticket sources are appended after the workspaces, each bringing its own project.
  const allProjects = useMemo<TrackerProject[]>(
    () => [...trackerProjects, ...(obsidian.project ? [obsidian.project] : []), ...notion.projects, ...github.projects],
    [trackerProjects, obsidian.project, notion.projects, github.projects],
  );

  const projectIds = useMemo(() => projects.map((project) => project.id), [projectKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const results = await Promise.all(
        projectIds.map(async (projectId) => {
          try {
            const stored = await client.list(projectId, {});
            return { projectId, tasks: stored.map(toTrackerTask), failed: false };
          } catch {
            // Outside Tauri there is no store at all, and a single unreadable file must not empty
            // the board. Both land here, and both are reported once, below.
            return { projectId, tasks: [] as TrackerTask[], failed: true };
          }
        }),
      );
      if (cancelled) return;

      const failures = results.filter((result) => result.failed).length;
      setLotusTasks(results.flatMap((result) => result.tasks));
      setLotusError(
        failures === 0
          ? null
          : failures === projectIds.length
            ? "Tasks could not be read."
            : `${failures} project${failures === 1 ? "" : "s"} could not be read.`,
      );
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [client, projectIds, nonce]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  /*
    A task changed outside this window: an agent wrote through the MCP tools (`mcp_ipc.rs` emits
    `tasks://changed`). Only that workspace is read again — the others did not move — and a
    workspace this window does not hold is none of its business.
  */
  const [lastChange, setLastChange] = useState<TaskChange | null>(null);
  const projectIdsRef = useRef(projectIds);
  useEffect(() => {
    projectIdsRef.current = projectIds;
  }, [projectIds]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let seq = 0;
    const pending = listen<{ workspaceId?: unknown; taskId?: unknown }>("tasks://changed", (event) => {
      const { workspaceId, taskId } = event.payload ?? {};
      if (typeof workspaceId !== "string" || typeof taskId !== "string") return;
      if (!projectIdsRef.current.includes(workspaceId)) return;
      seq += 1;
      setLastChange({ workspaceId, taskId, seq });
      void client
        .list(workspaceId, {})
        .then((stored) => {
          if (disposed) return;
          const rows = stored.map(toTrackerTask);
          setLotusTasks((current) => [
            ...current.filter((task) => task.projectId !== workspaceId),
            ...rows,
          ]);
        })
        .catch(() => {
          /* the next full read says it; one missed refresh is not worth a banner */
        });
    });

    return () => {
      disposed = true;
      void pending.then((off) => off());
    };
  }, [client]);

  const refreshObsidian = obsidian.refresh;
  const refreshNotion = notion.refresh;
  const refreshGitHub = github.refresh;
  const refresh = useCallback(() => {
    // Every pile: the button means "read everything again", and a refresh that quietly skipped
    // a source would be the one press that does not do what it says.
    setNonce((value) => value + 1);
    refreshObsidian();
    refreshNotion();
    refreshGitHub();
  }, [refreshGitHub, refreshNotion, refreshObsidian]);

  // `refresh` so the history that was just recorded is the history the panel draws.
  useLivenessRecorder(tasks, activities, refresh);

  /*
    Routed by project, because the sources answer in different shapes and neither can be made to
    look like the other honestly: a Lotus task carries intake, a blocker and a history; a vault
    ticket carries prose under headings somebody wrote by hand. The question is "which source owns
    this project", never "is this the vault's id".
  */
  const obsidianProjectId = obsidian.project?.id ?? null;
  const openObsidian = obsidian.open;
  const { owns: notionOwns } = notion;
  /*
    Read through a ref: `rowOf` changes with every sync, and `openTask` changing makes Tasks read the
    open ticket again — every minute, dropping whatever its page was showing. The page follows the
    list through `notionRows.rowOf` instead.
  */
  const notionRowOfRef = useRef(notion.rowOf);
  const { owns: githubOwns } = github;
  const githubIssueOfRef = useRef(github.issueOf);
  useEffect(() => {
    notionRowOfRef.current = notion.rowOf;
    githubIssueOfRef.current = github.issueOf;
  });
  const openTask = useCallback(
    async (projectId: string, taskId: string): Promise<OpenedTask | null> => {
      try {
        if (notionOwns(projectId)) {
          const row = notionRowOfRef.current(projectId, taskId);
          return row ? { kind: "notion", projectId, row } : null;
        }
        if (githubOwns(projectId)) {
          const issue = githubIssueOfRef.current(projectId, Number(taskId));
          return issue ? { kind: "github", projectId, issue } : null;
        }
        if (projectId === obsidianProjectId) {
          const detail = await openObsidian(taskId);
          return detail ? { kind: "ticket", detail } : null;
        }
        const task = await client.get(projectId, taskId);
        return task ? { kind: "task", task } : null;
      } catch {
        return null;
      }
    },
    [client, githubOwns, notionOwns, obsidianProjectId, openObsidian],
  );

  /*
    A ticket-source row, changed from the list. The source makes the edit against what its own
    record says now; the board only reports the outcome.
  */
  const editObsidianRow = obsidian.editRow;
  const editSourceRow = useCallback(
    async (original: TrackerTask, patch: Partial<Pick<TrackerTask, "title" | "status">>): Promise<string | null> => {
      const message = await editObsidianRow(original, patch);
      setWriteError(message);
      return message;
    },
    [editObsidianRow],
  );

  const createTask = useCallback(
    async (draft: TaskDraft): Promise<string | null> => {
      const prepared = prepareTaskDraft(draft);
      if (!prepared.ok) {
        const message = taskDraftRefusalMessage(prepared.reason);
        setWriteError(message);
        return message;
      }
      try {
        const created = await client.create(prepared.input);
        // Appended from the store's answer, not from the draft: the number and the id are the
        // store's to hand out, and a row invented here would show a key that does not exist yet.
        setLotusTasks((current) => [...current, toTrackerTask(created)]);
        setWriteError(null);
        return null;
      } catch (cause) {
        const message = `That task could not be created: ${String(cause)}`;
        setWriteError(message);
        return message;
      }
    },
    [client],
  );

  const createFromTicket = useCallback(
    async (
      projectId: string,
      draft: { title: string; goal: string; knowledge: string; source?: TaskSource; status?: BridgeTaskStatus; priority?: BridgePriority },
    ): Promise<BridgeTask | null> => {
      try {
        const created = await client.create({ workspaceId: projectId, ...draft, status: draft.status ?? "todo" });
        setLotusTasks((current) => [...current, toTrackerTask(created)]);
        setWriteError(null);
        return created;
      } catch (cause) {
        setWriteError(`That ticket could not be made into a task: ${String(cause)}`);
        return null;
      }
    },
    [client],
  );

  const editTask = useCallback(
    async (
      taskId: string,
      patch: Partial<Pick<TrackerTask, "title" | "status" | "priority" | "position">>,
    ): Promise<string | null> => {
      const original = tasksRef.current.find((task) => task.id === taskId);
      if (!original) return null;
      /*
        Refused here, not only hidden in the UI. The components stop offering the controls where a
        project does not allow them, but that is courtesy — this is the guarantee, and it holds for a caller
        that forgot to check.
      */
      const can = capabilitiesOf(projectsByIdRef.current.get(original.projectId));
      if (!can.editRows) {
        const message = "This row cannot be changed from the list. Open it to edit.";
        setWriteError(message);
        return message;
      }
      if (patch.priority !== undefined && !can.hasPriority) {
        const message = "A ticket has no priority to set.";
        setWriteError(message);
        return message;
      }
      if (original.projectId === obsidianProjectId) return editSourceRow(original, patch);

      setLotusTasks((current) => applyTrackerTaskPatch(current, taskId, patch, Date.now()));
      try {
        await client.update(original.projectId, taskId, patch);
        setWriteError(null);
        return null;
      } catch (cause) {
        // The row goes back to what it was: leaving the optimistic value on screen would mean the
        // list and the store disagree, and only the list is visible.
        setLotusTasks((current) => restoreTrackerTask(current, original));
        const message = `That change was not saved: ${String(cause)}`;
        setWriteError(message);
        return message;
      }
    },
    [client, editSourceRow, obsidianProjectId],
  );

  const editTaskBody = useCallback(
    async (projectId: string, taskId: string, patch: { goal?: string; knowledge?: string }) => {
      try {
        await client.update(projectId, taskId, patch);
        setWriteError(null);
        return null;
      } catch (cause) {
        const message = `That text was not saved: ${String(cause)}`;
        setWriteError(message);
        return message;
      }
    },
    [client],
  );

  const projectsById = useMemo(() => indexProjects(allProjects), [allProjects]);
  useEffect(() => {
    projectsByIdRef.current = projectsById;
  }, [projectsById]);

  /*
    One object for as long as nothing in it changed. The board is a dependency of everything below
    it — the panel's memo, the delegation hook's spawner, the ticket editor's re-read — and a fresh
    literal per render of the shell rebuilt all of them for nothing.
  */
  return useMemo(
    () => ({
      projects: allProjects,
      projectsById,
      tasks,
      loading,
      error,
      refresh,
      createTask,
      createFromTicket,
      editTask,
      editTaskBody,
      openTask,
      saveTicket: obsidian.saveTicket,
      vaultVersion: obsidian.version,
      lastChange,
      notionRows: notion,
    }),
    [
      allProjects,
      createFromTicket,
      createTask,
      editTask,
      editTaskBody,
      error,
      lastChange,
      loading,
      notion,
      openTask,
      obsidian.saveTicket,
      obsidian.version,
      projectsById,
      refresh,
      tasks,
    ],
  );
}

/**
 * A workspace's swatch, picked from its id so it stays the same across launches. Workspaces carry
 * no colour of their own, and grey for every project made the nav read as one list (revamp D5).
 * Mid-lightness hues that hold up on both Light and Dark.
 */
const PROJECT_PALETTE = ["#d6a26b", "#6ba3d6", "#8bc48a", "#c98bc4", "#d68b6b", "#7fc4bd", "#c4b86b", "#9a8bd6"]; // color-literal-ok: project identity hues, the same in every theme
export function projectColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PROJECT_PALETTE[Math.abs(hash) % PROJECT_PALETTE.length];
}
