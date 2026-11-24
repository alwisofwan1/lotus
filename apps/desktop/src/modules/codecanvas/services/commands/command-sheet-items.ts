// Command sheet catalog — the single list of things ⌘K can do.
//
// Extracted from CanvasCommandPalette when the centred ⌘K modal merged into the NL command bar
// (2026-08-28). It was the palette's whole substance and none of its chrome, and the merge needed
// it in two places at once: the sheet renders it, and the tests that used to drive it through a
// DOM now drive it directly. Keeping it here also stops the catalog from being re-litigated in a
// component that is otherwise about keyboard handling.
//
// One rule the sheet depends on: `buildCommandSheetItems` is TOTAL and never throws. It is called
// on every keystroke of a bar the user types free-form prose into, and a bad node shape must
// degrade to a missing row, never to an unusable command bar.

import {
  ArrowLeftRight,
  Bot,
  CornerDownLeft,
  Crosshair,
  Factory,
  FileCode2,
  Globe,
  Hand,
  Layers,
  LayoutGrid,
  ListChecks,
  Music,
  Play,
  RotateCcw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  SquareCheckBig,
  SquareTerminal,
  StickyNote,
  Trash2,
  Users,
  VolumeX,
  Workflow,
  Rows3,
  type LucideIcon,
  MessagesSquare,
} from "lucide-react";
import type { Node } from "@xyflow/react";
import type { CanvasCommand, CanvasCreateNodeKind } from "./canvas-command";
import { runMembersFromSelection } from "../run-node";
import { buildSpawnFirstAgentDefinition, cliToRunnerSpec } from "../spawn-first-agent";
import { SPAWN_VERBS } from "../canvas-nl-fastpath";
import { currentNamePool } from "@/lib/agent-naming";
import type { DetectedCli } from "@/lib/tauri-api";
import { adoptionShapeFor, cellLabel, type RemoteHostCell } from "../remote-host";
import { buildRecentProjects, projectDisplayName } from "../recent-projects";
import type { CanvasSessionRecord } from "../session-record";
import { sessionMetaLine, sessionRowTitle } from "../session-view";
import {
  dispatchActionLabel,
  planSessionDispatch,
  type SessionBoardFacts,
} from "../session-dispatch";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";
import { rankPaths } from "@/modules/codespace/services/fuzzy-path";
import { fileNodeNames } from "../file-node/file-node-view";

/** SPAWN_VERBS is an alternation for a RegExp; the search index wants plain words. */
const SPAWN_VERB_WORDS = SPAWN_VERBS.split("|").join(" ");

export type SheetAction =
  | { kind: "command"; command: CanvasCommand }
  | {
      kind: "custom";
      run: () => void;
      /** The row only prepares the bar for typing (it is not a result): leave the sheet and the query alone. */
      keepOpen?: boolean;
      /** ⌘↵ / Ctrl+↵ on this row, with the words the active row shows for it ("open in Tasks"). */
      alt?: { run: () => void; hint: string };
    };

/**
 * Visual grouping. Order here is the render + keyboard-nav order (see GROUP_ORDER).
 *
 * `send` is the merge's own group and always sorts last: it holds exactly one row, "send what you
 * typed", which is what keeps the sheet from ever standing between the user and the NL pipeline.
 * The bar's primary job is free-form prose, so the escape hatch is a visible row rather than a
 * remembered keystroke.
 */
export type SheetGroup = "launch" | "adopt" | "factory" | "tasks" | "files" | "create" | "selection" | "navigate" | "send";

export const GROUP_ORDER: Record<SheetGroup, number> = { launch: 0, adopt: 1, factory: 2, tasks: 3, files: 4, create: 5, selection: 6, navigate: 7, send: 8 };
export const GROUP_LABEL: Record<SheetGroup, string> = {
  launch: "Launch",
  // Not "Adopt", which is already the verb on every row here. The header answers the question the
  // rows do not: where did these come from? They are cells this project's machine is running right
  // now — most often started from the phone — not anything this canvas made.
  adopt: "Already running",
  // Runs the Factory already has. A row places one on the canvas, or opens one that waits for you
  // in the Dock; it starts nothing.
  factory: "Factory run…",
  // Tasks the tracker board already has (board 18): a row places one as a linked Task node.
  tasks: "From Tasks…",
  // Files of the project root, found by what is typed: a row places a File Node (S3).
  files: "Open file…",
  create: "Create",
  selection: "This node",
  navigate: "Go to",
  // No header: one row, already set apart by the rule above it.
  send: "",
};

/** How many groups there are, so the relevance prior below does not have to be kept in step. */
const GROUP_COUNT = Object.keys(GROUP_ORDER).length;

/**
 * The right-aligned category tag. Coarser than the group on purpose — the group tells you where a
 * row sits in the list, the tag tells you what will happen to your canvas if you press Enter.
 * "Go to" splits across two of them, which is the whole reason this is not derived from the group:
 * opening Settings changes the app, focusing a node moves the camera.
 */
export type SheetTag = "AGENT" | "ADD" | "APP" | "GO" | "NODE" | "SEND";

/** Per-item identity hue — sourced from the active theme's node/status tokens so every icon
 *  tile recolours with the Artisan theme instead of carrying a hardcoded colour. */
const HUE = {
  agent: "var(--canvas-node-agent)",
  task: "var(--canvas-node-task)",
  note: "var(--canvas-node-note)",
  info: "var(--canvas-node-info)",
  accent: "var(--canvas-accent)",
  warn: "var(--canvas-status-blocked)",
  danger: "var(--canvas-status-error)",
  music: "var(--canvas-node-music, #f472b6)",
} as const;

export interface SheetItem {
  id: string;
  title: string;
  detail: string;
  keywords: string;
  action: SheetAction;
  group: SheetGroup;
  tag: SheetTag;
  Icon: LucideIcon;
  hue: string;
  tone?: "danger";
  /** ⇥ on the row: changes what it runs on (the Claude row's account). */
  cycle?: () => void;
  /** With `cycle`: the account ⇥ picked; null = the default. */
  account?: string | null;
}

export interface CommandSheetInput {
  nodes: Node[];
  clis: DetectedCli[];
  /** Claude accounts besides the global one, chosen on the one Claude row with ⇥ (issues/07, mockup decision 6). */
  claudeAccounts?: string[];
  /** The account that row launches on; null = the global one. */
  launchAccount?: string | null;
  onCycleAccount?: () => void;
  onOpenSettings?: () => void;
  onOpenCanvases?: () => void;
  /** Silence every voice the canvas speaks with — the Speaker Queue's stop-all (Lotus #176). */
  onStopAllSpeech?: () => void;
  projects?: CodeCanvasProjectMeta[];
  activeProjectId?: string | null;
  onSelectProject?: (projectId: string) => void;
  /** Sessions of the active project (`plans/codecanvas-session-widget/`, Slice 02). */
  sessions?: CanvasSessionRecord[];
  /**
   * Press a session row. One entry point, because what a press means is the dispatcher's decision
   * (`plans/codecanvas-session-refactor/issues/03`).
   */
  onDispatchSession?: (session: CanvasSessionRecord) => void;
  /** Facts about the canvas being looked at, so a row's verb matches what will happen. */
  sessionBoard?: SessionBoardFacts;
  /**
   * Cells the project's machine is already running under its own Standalone Host (ticket 11).
   *
   * Empty or absent for every machine that runs no host — which is most of them — and that is the
   * whole of "a machine without a host shows no trace of this feature": there is no section, no
   * empty state and no disabled row, because the rows are built from this list.
   */
  hostCells?: RemoteHostCell[];
  /** Take a host-owned cell over as a canvas node. */
  onAdoptCell?: (cell: RemoteHostCell) => void;
  /** Factory Runs, one per issue (#146); a row places that issue's run as a Factory node. */
  factoryRuns?: SheetFactoryRun[];
  onAddFactoryRun?: (run: SheetFactoryRun) => void;
  /** Open one run in the Dock's Factory, where its next step (Answer, Approve…) is taken. */
  onOpenFactoryRun?: (run: SheetFactoryRun) => void;
  /** Open the Dock's Factory with New run showing. */
  onNewFactoryRun?: () => void;
  /**
   * Open an app in the Canvas Dock. One row per app instead of a chord each (`plans/canvas-dock/`,
   * revised 2026-10-16): ⌘⇧A is Auto-arrange, and a chord per app does not scale.
   */
  onOpenAutomation?: () => void;
  onOpenFleet?: () => void;
  /** Open tasks from the window's tracker board, this board's workspace first (board 18). */
  trackerTasks?: SheetTrackerTask[];
  /** Place the task as a linked Task node, or centre the node that already shows it. */
  onPlaceTask?: (task: SheetTrackerTask, options?: { openInDock?: boolean }) => void;
}

export interface SheetTrackerTask {
  id: string;
  workspaceId: string;
  title: string;
  /** `FT-12`; null before the task has a number. */
  key: string | null;
  workspaceName: string;
  statusLabel: string;
  /** The Task node already linked to it on this board, if any: the row centres it, never a second one. */
  nodeId: string | null;
}

export interface SheetFactoryRun {
  repo: string;
  /** The issue number, or the Notion ticket id (`TKT-123`). */
  issue: number | string;
  title: string;
  /** Working, Needs you, Ready, Stopped. */
  statusWord: string;
  /** The verb for a run that waits for you (Answer, Approve…); empty otherwise. */
  next?: string;
}

const CREATE_NODE_ITEMS: Array<{
  type: CanvasCreateNodeKind;
  title: string;
  detail: string;
  Icon: LucideIcon;
  hue: string;
}> = [
  { type: "note", title: "Create Note", detail: "Capture context or instructions", Icon: StickyNote, hue: HUE.note },
  { type: "terminal", title: "Create Terminal", detail: "Start a native-backed canvas terminal", Icon: SquareTerminal, hue: HUE.accent },
  { type: "plan", title: "Create Plan", detail: "Track ordered workflow steps", Icon: ListChecks, hue: HUE.info },
  { type: "task", title: "Create Task", detail: "Define work for an agent or team", Icon: SquareCheckBig, hue: HUE.task },
  { type: "context", title: "Create Context", detail: "Share artifacts between agents", Icon: Layers, hue: HUE.info },
  { type: "critic", title: "Create Critic", detail: "Add a verification gate", Icon: ShieldCheck, hue: HUE.warn },
  { type: "human-gate", title: "Create Human Gate", detail: "Pause a run for approval", Icon: Hand, hue: HUE.warn },
  { type: "team", title: "Create Team", detail: "Coordinate multiple agents", Icon: Users, hue: HUE.agent },
  { type: "music", title: "Create Music Player", detail: "YouTube tracklist player", Icon: Music, hue: HUE.music },
];

export function nodeLabel(node: Node): string {
  const data = node.data ?? {};
  const explicit = data.title ?? data.label ?? data.name ?? data.url;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (node.type === "note" && typeof data.content === "string" && data.content.trim()) {
    return data.content.trim().slice(0, 48);
  }
  return `${node.type ?? "node"} ${node.id}`;
}

export function buildCommandSheetItems({
  nodes,
  clis,
  claudeAccounts = [],
  launchAccount = null,
  onCycleAccount,
  onOpenSettings,
  onOpenCanvases,
  onStopAllSpeech,
  projects,
  activeProjectId,
  onSelectProject,
  sessions,
  onDispatchSession,
  sessionBoard,
  hostCells,
  onAdoptCell,
  factoryRuns,
  onAddFactoryRun,
  onOpenFactoryRun,
  onNewFactoryRun,
  onOpenAutomation,
  onOpenFleet,
  trackerTasks,
  onPlaceTask,
}: CommandSheetInput): SheetItem[] {
  // Runner-first launch (ADR-0027, CNVS "⌘K can launch"): each installed CLI spawns an
  // auto-named live agent. Listed first so launching is the palette's primary action.
  const takenNames = nodes.map((n) => (typeof n.data?.name === "string" ? n.data.name : "")).filter(Boolean);
  const launchItems: SheetItem[] = clis.flatMap((cli) => {
    const { runner, runnerCommand } = cliToRunnerSpec(cli);
    const choosable = runner === "claude" && claudeAccounts.length > 0 && !!onCycleAccount;
    const account = choosable ? launchAccount : null;
    return [{
      id: `launch-${cli.id}`,
      title: `Launch ${cli.name}`,
      // The COMMAND, not a sentence. Every launch row used to read "Spawn an auto-named live
      // agent", so a browse list on a machine with seven CLIs printed the same second line seven
      // times — the detail column carried no information at all where it was needed most. The
      // binary that will actually run is the one thing that differs per row.
      detail: `${cli.command} · auto-named agent`,
      // Every verb the NL fast path accepts for a spawn, so the sheet answers the same words the
      // bar does — "open codex" must find this row, not just "launch codex". See SPAWN_VERBS.
      keywords: `${SPAWN_VERB_WORDS} cli agent ${cli.id} ${cli.name} ${runner}${choosable ? ` account ${claudeAccounts.join(" ")}` : ""}`,
      group: "launch",
      tag: "AGENT",
      Icon: Bot,
      hue: HUE.agent,
      action: {
        kind: "command",
        command: {
          kind: "create-agent",
          definition: buildSpawnFirstAgentDefinition(runner, takenNames, { ...(runnerCommand ? { runnerCommand } : {}), pool: currentNamePool() }),
          ...(account ? { options: { account } } : {}),
        },
      },
      ...(choosable ? { cycle: onCycleAccount, account } : {}),
    } satisfies SheetItem];
  });

  /**
   * Cells the project's machine is already running, offered for adoption (ticket 11).
   *
   * **Listed after Launch, and that order is the decision.** Spawning is the palette's primary
   * action and is available on every machine; adoption exists only where a host happens to be
   * running, so it must never push the thing that always works below the fold.
   *
   * **In its own group, and that is the same decision made properly.** These rows used to sit in
   * `launch`, which meant they spent the SAME per-group browse budget: six rows shared between the
   * runners you can start and the cells already running. Two of each fits, so nothing looked wrong
   * — but a machine with four live cells silently pushed the last Launch rows out of the browse
   * list, and the operator would read that as "Lotus forgot my runner". A separate group gives
   * each its own six and lets the section header say where these came from.
   *
   * A cell already on this board is not offered again — adopting it twice would give one tmux
   * session two nodes, and tmux would then size it to the smaller of them.
   */
  const adoptedAlready = new Set(
    nodes
      .map((node) => (typeof node.data?.adoptedPaneId === "string" ? node.data.adoptedPaneId : null))
      .filter((paneId): paneId is string => Boolean(paneId)),
  );
  const adoptItems: SheetItem[] = (hostCells ?? [])
    .filter((cell) => !adoptedAlready.has(cell.paneId))
    .map((cell) => {
      const name = cellLabel(cell);
      // Two cells can be adopted and they do not become the same thing, so the row says which.
      // A `tui` cell becomes a terminal attached to its tmux session; a headless one has no
      // terminal anywhere and becomes its conversation. An operator who presses this expecting a
      // shell and gets a chat box learned the difference at the worst moment.
      const chat = adoptionShapeFor(cell) === "chat";
      return {
        id: `adopt-${cell.paneId}`,
        title: `Adopt ${name}`,
        // What it is, what shape it will take, and where — a cell started from a phone has no
        // other introduction.
        detail: `${cell.provider} · ${chat ? "chat, tanpa terminal" : "terminal"} · ${cell.cwd}${cell.isAlive ? "" : " · berhenti"}`,
        keywords: `adopt adopsi host cell ${cell.provider} ${name} ${cell.paneId} ${cell.cwd} phone hp lotus host${chat ? " chat percakapan headless conversation" : " terminal tmux"}`,
        group: "adopt",
        tag: "AGENT",
        Icon: chat ? MessagesSquare : Bot,
        hue: HUE.agent,
        action: { kind: "custom", run: () => onAdoptCell?.(cell) },
      };
    });

  // One node per issue: a run already on the board is not offered again.
  const onBoard = new Set(
    nodes
      .filter((node) => node.type === "factory")
      .map((node) => `${String(node.data?.repo ?? "").toLowerCase()}#${String(node.data?.issue ?? "")}`),
  );
  const factoryItems: SheetItem[] = onAddFactoryRun
    ? (factoryRuns ?? [])
        .filter((run) => !onBoard.has(`${run.repo.toLowerCase()}#${run.issue}`))
        .map((run) => {
          const label = typeof run.issue === "number" ? `#${run.issue}` : run.issue;
          return {
            id: `factory-${run.repo}#${run.issue}`,
            title: `Factory run: ${label} ${run.title}`,
            detail: `${run.repo} · ${run.statusWord}`,
            keywords: `factory run issue ${run.repo} ${run.issue} ${label} ${run.title} ${run.statusWord}`,
            group: "factory",
            tag: "ADD",
            Icon: Factory,
            hue: HUE.accent,
            action: { kind: "custom", run: () => onAddFactoryRun(run) },
          } satisfies SheetItem;
        })
    : [];
  // A run that waits for you, by its verb, whether or not it is on the board: the decision is made
  // in the Dock's run detail, never from the sheet, so the row opens the run there.
  const factoryNextItems: SheetItem[] = onOpenFactoryRun
    ? (factoryRuns ?? [])
        .filter((run) => run.next)
        .map((run) => {
          const label = typeof run.issue === "number" ? `#${run.issue}` : run.issue;
          return {
            id: `factory-next-${run.repo}#${run.issue}`,
            title: `${run.next}: ${label} ${run.title}`,
            detail: `${run.repo} · in the Dock`,
            keywords: `factory run needs you ${run.next} ${run.repo} ${run.issue} ${label} ${run.title}`,
            group: "factory",
            tag: "APP",
            Icon: Factory,
            hue: HUE.warn,
            action: { kind: "custom", run: () => onOpenFactoryRun(run) },
          } satisfies SheetItem;
        })
    : [];

  const taskItems: SheetItem[] = onPlaceTask
    ? (trackerTasks ?? []).map((task) => {
        const where = [task.key, task.workspaceName, task.statusLabel].filter(Boolean).join(" · ");
        return {
          id: `task-${task.workspaceId}:${task.id}`,
          title: task.title,
          detail: task.nodeId ? `${where} · on this canvas` : where,
          keywords: `task tasks from tracker link ${task.key ?? ""} ${task.workspaceName} ${task.statusLabel}`,
          group: "tasks",
          tag: task.nodeId ? "GO" : "ADD",
          Icon: SquareCheckBig,
          hue: HUE.task,
          action: {
            kind: "custom",
            run: () => onPlaceTask(task),
            alt: { run: () => onPlaceTask(task, { openInDock: true }), hint: "open in Tasks" },
          },
        } satisfies SheetItem;
      })
    : [];

  const items: SheetItem[] = CREATE_NODE_ITEMS.map((item) => ({
    id: `create-${item.type}`,
    title: item.title,
    detail: item.detail,
    keywords: `create add new ${item.type}`,
    group: "create",
    tag: "ADD",
    Icon: item.Icon,
    hue: item.hue,
    action: { kind: "command", command: { kind: "create-node", nodeType: item.type } },
  }));

  items.push({
    id: "create-browser",
    title: "Create Browser",
    detail: "Open a standalone browser node",
    keywords: "create add new browser web",
    group: "create",
    tag: "ADD",
    Icon: Globe,
    hue: HUE.accent,
    action: { kind: "command", command: { kind: "create-browser" } },
  });

  if (onOpenCanvases) {
    items.push({
      id: "open-canvases",
      title: "Browse Canvases",
      detail: "Switch projects or create a new canvas",
      keywords: "project canvas switch open browse",
      group: "navigate",
      tag: "APP",
      Icon: LayoutGrid,
      hue: HUE.info,
      action: { kind: "custom", run: onOpenCanvases },
    });
  }

  // Sessions as ⌘K rows. The corner segment answers "what is there right now"; this answers "take
  // me to that one" — typed and filtered, so it is not capped at what fits in a popover.
  //
  // Only sessions whose node is still on the board get a row: both actions act on a node, and a row
  // that could not act would be a dead entry in the palette. Sessions detached from their node get
  // rows when attaching one back exists (Slice 05).
  if (sessions && sessions.length && onDispatchSession && sessionBoard) {
    const dispatch = onDispatchSession;
    const board = sessionBoard;
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const now = Date.now();
    for (const session of sessions) {
      // The label comes from the same plan that decides what the row does, so a session whose node is
      // not on this canvas gets a row too (it used to be skipped from the list entirely).
      const plan = planSessionDispatch(session, board);
      const label = dispatchActionLabel(plan);
      if (!label) continue;
      const node = session.nodeId ? nodeById.get(session.nodeId) : undefined;
      const agentName = typeof node?.data?.name === "string" ? node.data.name : undefined;
      const title = sessionRowTitle(session, agentName);
      items.push({
        id: `resume-session-${session.id}`,
        title: `${label} ${title}`,
        detail: sessionMetaLine(session, now),
        // Indonesian words kept for search only: people type what they are used to.
        keywords: `session conversation sesi ${session.runner} ${agentName ?? ""} ${session.title} open resume buka lanjut`,
        group: "navigate",
        tag: "GO",
        Icon: MessagesSquare,
        hue: HUE.agent,
        action: {
          kind: "custom",
          run: () => dispatch(session),
        },
      });
    }
  }

  if (projects && projects.length && onSelectProject) {
    const select = onSelectProject;
    const recent = buildRecentProjects(projects, { excludeId: activeProjectId });
    const recentIds = new Set(recent.map((r) => r.id));
    const ordered = [
      ...recent.map((r) => ({ id: r.id, name: r.name })),
      ...projects.filter((p) => p.id !== activeProjectId && !recentIds.has(p.id)).map((p) => ({ id: p.id, name: projectDisplayName(p) })),
    ];
    for (const p of ordered) {
      items.push({
        id: `switch-project-${p.id}`,
        title: `Switch to ${p.name}`,
        // EMPTY on purpose. It read "Open this canvas project" on every project, so a list of three
        // projects printed the same sentence three times under three different names — the second
        // line was pure repetition of the first. A row whose detail adds nothing shows no detail;
        // the sheet renders one line for it and reads quieter for the omission.
        detail: "",
        keywords: `${p.name} project switch open`,
        group: "navigate",
        tag: "GO",
        Icon: ArrowLeftRight,
        hue: HUE.info,
        action: { kind: "custom", run: () => select(p.id) },
      });
    }
  }

  if (onOpenSettings) {
    items.push({
      id: "open-settings",
      title: "Open Canvas Settings",
      detail: "Theme, background, and canvas preferences",
      keywords: "settings theme preferences background",
      group: "navigate",
      tag: "APP",
      Icon: SlidersHorizontal,
      hue: HUE.info,
      action: { kind: "custom", run: onOpenSettings },
    });
  }

  if (onOpenAutomation) {
    items.push({
      id: "open-automation",
      title: "Open Automations",
      detail: "Inbox, automations and what was sent, in the Dock",
      keywords: "automation automations inbox review drafts dock",
      group: "navigate",
      tag: "APP",
      Icon: Workflow,
      hue: HUE.info,
      action: { kind: "custom", run: onOpenAutomation },
    });
  }

  if (onNewFactoryRun) {
    items.push({
      id: "new-factory-run",
      title: "New Factory run…",
      detail: "Pick issues and start runs, in the Dock",
      keywords: "factory new run start issue ticket dock",
      group: "navigate",
      tag: "APP",
      Icon: Factory,
      hue: HUE.accent,
      action: { kind: "custom", run: onNewFactoryRun },
    });
  }

  if (onOpenFleet) {
    items.push({
      id: "open-fleet",
      title: "Fleet",
      detail: "Every cell on this canvas as a list, in the Dock",
      keywords: "fleet cells agents list rows",
      group: "navigate",
      tag: "APP",
      Icon: Rows3,
      hue: HUE.info,
      action: { kind: "custom", run: onOpenFleet },
    });
  }

  if (onStopAllSpeech) {
    items.push({
      id: "stop-all-speech",
      title: "Stop All Speech",
      detail: "Silence replies, callouts, and narration",
      keywords: "stop speaking silence mute voice quiet shut up diam",
      group: "navigate",
      tag: "APP",
      Icon: VolumeX,
      hue: HUE.info,
      action: { kind: "custom", run: onStopAllSpeech },
    });
  }

  // A Run Node over the selected runnable nodes (plans/canvas-graph-run). Shown only when the
  // selection holds at least one node that is not already in another run.
  const runMembers = runMembersFromSelection(nodes);
  if (runMembers.length > 0) {
    items.push({
      id: "create-run-from-selection",
      title: "New Run from Selection",
      detail: `${runMembers.length} node${runMembers.length === 1 ? "" : "s"} · runs only these`,
      keywords: "new run graph run selection group start workflow",
      group: "selection",
      tag: "ADD",
      Icon: Play,
      hue: HUE.accent,
      action: { kind: "command", command: { kind: "create-run", memberIds: runMembers } },
    });
  }

  const selected = nodes.find((node) => node.selected);
  if (selected) {
    const label = nodeLabel(selected);
    items.push({
      id: `focus-selected-${selected.id}`,
      title: "Focus Selected Node",
      detail: label,
      keywords: `focus selected ${selected.type ?? "node"} ${label}`,
      group: "selection",
      tag: "NODE",
      Icon: Crosshair,
      hue: HUE.accent,
      action: { kind: "command", command: { kind: "focus-node", nodeId: selected.id } },
    });
    items.push({
      id: `close-selected-${selected.id}`,
      title: "Close Selected Node",
      detail: label,
      keywords: `close delete remove selected ${selected.type ?? "node"} ${label}`,
      group: "selection",
      tag: "NODE",
      Icon: Trash2,
      hue: HUE.danger,
      action: { kind: "command", command: { kind: "close-node", nodeId: selected.id } },
      tone: "danger",
    });
    if (selected.type === "task") {
      items.push({
        id: `dispatch-selected-single-${selected.id}`,
        title: "Dispatch Selected Task",
        detail: "Run with one agent",
        keywords: `dispatch run task single ${label}`,
        group: "selection",
        tag: "NODE",
        Icon: Send,
        hue: HUE.task,
        action: { kind: "command", command: { kind: "dispatch-task", nodeId: selected.id, mode: "single" } },
      });
      items.push({
        id: `dispatch-selected-team-${selected.id}`,
        title: "Dispatch Selected Task with Team",
        detail: "Coordinate through the team path",
        keywords: `dispatch run task team ${label}`,
        group: "selection",
        tag: "NODE",
        Icon: Users,
        hue: HUE.agent,
        action: { kind: "command", command: { kind: "dispatch-task", nodeId: selected.id, mode: "team" } },
      });
    }
    if (selected.type === "browser") {
      items.push({
        id: `recover-browser-${selected.id}`,
        title: "Recover Selected Browser",
        detail: label,
        keywords: `recover reconnect retry browser web ${label}`,
        group: "selection",
        tag: "NODE",
        Icon: RotateCcw,
        hue: HUE.accent,
        action: { kind: "command", command: { kind: "recover-browser", nodeId: selected.id } },
      });
    }
    if (selected.type === "terminal") {
      items.push({
        id: `recover-terminal-${selected.id}`,
        title: "Recover Selected Terminal",
        detail: label,
        keywords: `recover restart terminal pty runtime ${label}`,
        group: "selection",
        tag: "NODE",
        Icon: RotateCcw,
        hue: HUE.accent,
        action: { kind: "command", command: { kind: "recover-terminal", nodeId: selected.id } },
      });
      items.push({
        id: `toggle-browser-${selected.id}`,
        title: "Toggle Browser for Selected Terminal",
        detail: label,
        keywords: `browser web terminal toggle ${label}`,
        group: "selection",
        tag: "NODE",
        Icon: Globe,
        hue: HUE.info,
        action: { kind: "command", command: { kind: "toggle-browser", terminalId: selected.id } },
      });
    }
  }

  for (const node of nodes.slice(0, 40)) {
    const label = nodeLabel(node);
    items.push({
      id: `focus-${node.id}`,
      title: `Focus ${label}`,
      detail: `${node.type ?? "node"} node`,
      keywords: `focus find node ${node.type ?? "node"} ${label}`,
      group: "navigate",
      tag: "GO",
      Icon: Crosshair,
      hue: HUE.info,
      action: { kind: "command", command: { kind: "focus-node", nodeId: node.id } },
    });
  }

  // Stable group ordering: keep each item's original relative order within its group
  // (recent-project ordering, node order) while sectioning the list visually.
  return [...launchItems, ...adoptItems, ...factoryNextItems, ...factoryItems, ...taskItems, ...items].sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]);
}


/** Does this item survive the current query? Every whitespace-separated part must appear. */
export function matchesSheetQuery(item: SheetItem, query: string): boolean {
  if (!query.trim()) return true;
  const haystack = `${item.title} ${item.detail} ${item.keywords}`.toLowerCase();
  return query.toLowerCase().trim().split(/\s+/).every((part) => haystack.includes(part));
}

/**
 * The always-available last row: send exactly what was typed through the NL pipeline
 * (fast path → planner), which is what the bar did before the sheet existed.
 *
 * Returned only for a non-empty query, because with an empty one there is nothing to send —
 * and its absence is what makes ⌘K-with-no-query behave like a plain command list.
 */
export function buildSendRow(query: string, run: () => void): SheetItem | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  return {
    id: "send-raw",
    // Quoted so it is unmistakably the user's own words and not a command the catalog invented.
    title: `Do it: “${trimmed}”`,
    detail: "send exactly what you typed — agents, canvas, voice grammar",
    // Intentionally NOT matched against: this row is appended after filtering, never filtered.
    keywords: "",
    group: "send",
    tag: "SEND",
    Icon: CornerDownLeft,
    hue: HUE.accent,
    action: { kind: "custom", run },
  };
}

/**
 * How many rows each surface shows. Both numbers are the sheet's own height, expressed as a count:
 * .canvas-sheet caps at 24rem and a row is ~44px, so ~8 rows are visible. A cap that matches the
 * viewport is what keeps this a shortcut surface rather than a directory.
 */
export const SHEET_SEARCH_LIMIT = 8;
export const SHEET_BROWSE_GROUP_LIMIT = 6;

/** Escape a user-typed string for use inside a RegExp. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Relevance, in tiers. `null` means the item does not match at all.
 *
 * WHERE a query lands matters more than whether it lands. Sharing the NL fast path's spawn verbs
 * with this catalog was right — "open codex" has to find a Launch row — but it also made the bare
 * word "open" match EVERY installed CLI through their keywords, and a flat filter answered with
 * eight near-identical "Launch … / Spawn an auto-named live agent" rows before anything else. The
 * words the user can actually SEE (title, then detail) outrank the invisible search index, so
 * "Open Canvas Settings" comes first and the launch rows fall in behind.
 *
 * The tier is scaled by 10 and the group priority added underneath, so a group prior can only ever
 * break a tie between equal tiers — never promote a keyword-only match over a title match.
 */
export function scoreSheetMatch(item: SheetItem, query: string): number | null {
  if (!matchesSheetQuery(item, query)) return null;
  const q = query.toLowerCase().trim();
  const groupPrior = GROUP_COUNT - 1 - GROUP_ORDER[item.group];
  if (!q) return groupPrior;

  const title = item.title.toLowerCase();
  let tier = 0;
  if (title === q) tier = 50;
  else if (title.startsWith(q)) tier = 40;
  else if (new RegExp(`\\b${escapeRe(q)}`).test(title)) tier = 30; // matches at a word boundary
  else if (title.includes(q)) tier = 20;
  else if (item.detail.toLowerCase().includes(q)) tier = 10;
  // tier 0 = matched only through the invisible keyword index.
  return tier * 10 + groupPrior;
}

/**
 * The rows to show, in the order to show them. Two modes, because browsing and searching want
 * opposite things — the pattern Spotlight and Raycast both settled on:
 *
 *   • BROWSE (⌘K, empty query) — the catalog, in its curated group order, each group capped so the
 *     sheet is not a 40-row wall of "Focus <node>". Sections are labelled; the user is scanning.
 *   • SEARCH (anything typed) — one flat list ranked by relevance, no section headings. Grouping
 *     would fight the ranking: the groups are only contiguous if group order outranks relevance,
 *     which is exactly the flood described in `scoreSheetMatch`. The category tag on each row
 *     carries the classification instead, which is all a heading was doing.
 *
 * The send row is pinned last in both modes and never ranked — it is the escape hatch, not a result.
 */
export function filterCommandSheetItems(
  items: SheetItem[],
  query: string,
  onSend?: () => void,
  /** Rows already ranked by their own source (file search), shown after the catalog hits, before send. */
  extraRows: SheetItem[] = [],
): SheetItem[] {
  const send = onSend ? buildSendRow(query, onSend) : null;
  const rows = query.trim() ? [...searchRows(items, query), ...extraRows] : mergeByGroup(browseRows(items), extraRows);
  return send ? [...rows, send] : rows;
}

/** File rows shown under a query: the sheet is a shortcut surface, not a directory. */
export const SHEET_FILE_LIMIT = 6;

/**
 * "Open file…" rows for a query, ranked by the editor's own Go to file ranking. Built per query
 * (not part of the catalog) because a project can have 100k+ files and the catalog is scored on
 * every keystroke. Files that already have a File Node are not offered again.
 */
export function buildFileSheetItems({ query, files, rootDir, onBoard, onOpenFile }: {
  query: string;
  files: readonly string[];
  rootDir: string;
  onBoard: ReadonlySet<string>;
  onOpenFile?: (path: string) => void;
}): SheetItem[] {
  if (!onOpenFile || !query.trim() || files.length === 0) return [];
  const hits = rankPaths(query, files, { rootDir, limit: SHEET_FILE_LIMIT + onBoard.size })
    .filter((hit) => !onBoard.has(hit.path))
    .slice(0, SHEET_FILE_LIMIT);
  return hits.map((hit) => {
    const { name, dir } = fileNodeNames(hit.path, rootDir);
    return {
      id: `file-${hit.path}`,
      title: name,
      detail: dir,
      keywords: `open file ${hit.relativePath}`,
      group: "files",
      tag: "ADD",
      Icon: FileCode2,
      hue: HUE.info,
      action: { kind: "custom", run: () => onOpenFile(hit.path) },
    } satisfies SheetItem;
  });
}

/**
 * ⌘K's browse list has an "Open file…" row, not only a row per match after typing: the file index
 * is too big to list, so the row is the way in. It does nothing itself; it keeps the sheet open on
 * the bar so the next keystrokes search the project's files.
 */
export function buildOpenFileBrowseRow({ onOpenFile }: { onOpenFile?: (path: string) => void }): SheetItem[] {
  if (!onOpenFile) return [];
  return [{
    id: "file-browse",
    title: "Search project files",
    detail: "Type a name to place its File Node on the board",
    keywords: "open file browse project",
    group: "files",
    tag: "ADD",
    Icon: FileCode2,
    hue: HUE.info,
    action: { kind: "custom", run: () => {}, keepOpen: true },
  } satisfies SheetItem];
}

function mergeByGroup(items: SheetItem[], extra: SheetItem[]): SheetItem[] {
  if (extra.length === 0) return items;
  return [...items, ...extra]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => GROUP_ORDER[a.item.group] - GROUP_ORDER[b.item.group] || a.index - b.index)
    .map((entry) => entry.item);
}

/** True when `filterCommandSheetItems` returned the grouped, section-headed browse list. */
export function isBrowseMode(query: string): boolean {
  return !query.trim();
}

function browseRows(items: SheetItem[]): SheetItem[] {
  const perGroup = new Map<SheetGroup, number>();
  const out: SheetItem[] = [];
  // `items` already arrives in group order (buildCommandSheetItems sorts by GROUP_ORDER), so a
  // single pass preserves both the group order and each group's internal order.
  for (const item of items) {
    const seen = perGroup.get(item.group) ?? 0;
    if (seen >= SHEET_BROWSE_GROUP_LIMIT) continue;
    perGroup.set(item.group, seen + 1);
    out.push(item);
  }
  return out;
}

function searchRows(items: SheetItem[], query: string): SheetItem[] {
  const scored: Array<{ item: SheetItem; score: number }> = [];
  for (const item of items) {
    const score = scoreSheetMatch(item, query);
    if (score !== null) scored.push({ item, score });
  }
  // Array#sort is stable, so equal scores keep the catalog's own order.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, SHEET_SEARCH_LIMIT).map((s) => s.item);
}

/**
 * The hybrid auto-open rule (user decision, 2026-08-28): the sheet opens itself once the query is
 * long enough to be a plausible command AND the catalog actually has something for it.
 *
 * Both halves matter. Without the length floor a single "b" pops a panel over the canvas on the
 * first keystroke of every sentence; without the match requirement free-form prose — the bar's
 * primary job, and what dictation produces — would hold an empty panel open while the user talks.
 * The send row is excluded from "has a match" for exactly that reason: it always matches, so
 * counting it would make the rule vacuous.
 */
export const SHEET_AUTO_OPEN_MIN_CHARS = 2;

export function shouldAutoOpenSheet(items: SheetItem[], query: string): boolean {
  if (query.trim().length < SHEET_AUTO_OPEN_MIN_CHARS) return false;
  // Task rows are titled in the user's own prose, so nearly any sentence would match one and hold
  // the sheet open over it. They are found once the sheet is open (⌘K), never open it themselves.
  return items.some((item) => item.group !== "tasks" && matchesSheetQuery(item, query));
}
