"use client";

/**
 * The unified workspace shell — what Lotus opens into.
 *
 * Everything here is live: Code mode runs the real workspace engine and its PTY sessions, Chat
 * mode mounts the chat module, which keeps its threads in the chat runtime.
 *
 * Code mode stays mounted while Chat is showing, because unmounting it kills every terminal.
 * The chrome above them is one title bar for both: one mode switcher, one rail toggle, and a
 * status pill that says what the showing mode reports about itself rather than a number written
 * into the chrome. See `plans/unified-workspace-shell/PLAN.md` §M2.
 */

import { useFactoryChiefCheckedAt } from "@/modules/factory/hooks/useFactoryChiefCheckedAt";
import "@/styles/workspace-shell.css";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useMacOverlayChrome } from "@/lib/hooks/useMacOverlayChrome";
import {
  ShellChrome,
  type ShellMode,
  type ShellModeStatus,
} from "@/modules/workspace-shell";
import { useElementSize } from "@/modules/workspace-shell/hooks/useElementSize";
import { useLotusSettingsHost } from "@/modules/lotus-settings/lotus-settings-context";
import { onSignInPaneRequest, pickSignInWorkspace } from "@/modules/workspace-shell/services/sign-in-pane";
import { useShellLayout } from "@/modules/workspace-shell/hooks/useShellLayout";
import { CodeMode } from "@/modules/workspace-shell/containers/CodeMode";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { RailSection } from "@/modules/workspace-shell/components/RailSection";
import { TasksNavRow } from "@/modules/tasks/components/TasksNavRow";
import { AutomationNavRow } from "@/modules/automation/components/AutomationNavRow";
import { AutomationSurface } from "@/modules/automation/components/AutomationSurface";
import { agentPaneDeps, startAgentWithPrompt } from "@/modules/automation/services/start-agent-with-prompt";
import {
  clearOpenAskRequest,
  openAskRequest,
  requestOpenAsk,
  subscribeToOpenAskRequest,
} from "@/modules/automation/services/open-ask-request";
import { useAutomationPanes } from "@/modules/automation/hooks/useAutomationPanes";
import { usePendingDrafts } from "@/modules/automation/hooks/usePendingDraftCount";
import { automationNeedsYouAsks, factoryNeedsYouAsks } from "@/modules/codecanvas/services/needs-you-sources";
import { markChatThreadRead } from "@/modules/chat/runtime/chat-runtime-client";
import { railState } from "@/modules/chat/domain/rail";
import { useNeedsYouAlerts } from "@/modules/workspace-shell/hooks/useNeedsYouAlerts";
import { useWorktreeAutoCleanup } from "@/modules/workspace-shell/hooks/useWorktreeAutoCleanup";
import { paneAsks, startPaneAsks } from "@/modules/workspace-shell/services/pane-asks";
import { ConnectorsNavRow } from "@/modules/connectors/components/ConnectorsNavRow";
import { ConnectorsSurface } from "@/modules/connectors/components/ConnectorsSurface";
import {
  FactoryNavRow,
  FactorySurface,
  createTauriFactoryRunActions,
  createTauriFactoryRunsClient,
  brainstormWorkspace,
  factoryIntakeWaiting,
  factoryWorkflowId,
  onOpenFactoryRunRequest,
  useFactoryRuns,
  type FactoryRef,
} from "@/modules/factory";
import {
  createTauriConnectorsClient,
  subscribeToConnectorChanges,
} from "@/modules/connectors/services/connectors-api";
import { useConnectorAttention } from "@/modules/connectors/hooks/useConnectorAttention";

/** Every panel closed: the base every "open one panel" patch starts from. */
const NO_PANEL = { tasksOpen: false, automationOpen: false, connectorsOpen: false, factoryOpen: false } as const;
import {
  createTauriAutomationClient,
  subscribeToAutomationChanges,
} from "@/modules/automation/services/automation-api";
import type { TrackerProjectInput } from "@/modules/tasks/hooks/useTrackerBoard";
import { TrackerBoardProvider, useOptionalSharedTrackerBoard, useSharedTrackerBoard } from "../hooks/TrackerBoardProvider";
import { useFactorySources } from "../hooks/useFactorySources";
import { countTasks, vocabularyByProject } from "@/modules/tasks/services/task-list";
import type { TrackerTask } from "@/modules/tasks/types";
import { ChatMode } from "@/modules/workspace-shell/containers/ChatMode";
import { chatTabMark } from "@/modules/chat/domain/rail";
import { useChatRail } from "@/modules/chat/ui/ChatPage";
import { useChatAgentDoneAlerts } from "@/modules/workspace-shell/hooks/useChatAgentDoneAlerts";
import { ThreadComposerRegistryProvider } from "@/modules/codespace/state/thread-composer-registry";
import { isJumpPaletteShortcut, isOldestNeedsYouShortcut, isToggleRailShortcut } from "@/modules/workspace-shell/services/shortcuts";
import { JumpPalette } from "@/modules/workspace-shell/components/JumpPalette";
import { buildJumpItems, oldestNeedsYou, type JumpSources, type JumpTarget } from "@/modules/workspace-shell/services/jump-items";
import { readRecent } from "@/modules/workspace-shell/services/jump-recent";
import { chatPaneThreads } from "@/modules/codespace/state/thread-activity-registry";
import { SurfaceVisible } from "@/lib/surface-visible";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";
import {
  createModeSwitchClock,
  summarizeModeSwitches,
  type ModeSwitchSample,
} from "@/modules/workspace-shell/services/mode-switch-metric";

/**
 * How long a mode switch takes in the real window (§M2), kept for re-measuring.
 *
 * Development only: the numbers are for whoever is changing this layout, and a line per switch
 * is noise in a shipped app. Module scope, because the samples belong to the window rather than
 * to a mount, and a measurement should not add a ref or a memo to the component it watches.
 *
 * `console.warn` with ONE string argument, deliberately: that is what the forwarder carrying the
 * webview console into the `tauri dev` terminal was observed to pass through — an `info` with a
 * second, object argument produced nothing at all, which cost a round of measurement to find.
 *
 * Measured 2026-09-20, 54 switches, panes live in both modes:
 *   code->chat  p50 54ms   p95 81ms
 *   chat->code  p50 104ms  p95 124ms
 * See `plans/unified-workspace-shell/VERIFICATION.md`.
 */
const modeSwitchSamples: ModeSwitchSample[] = [];
const measureModeSwitches = process.env.NODE_ENV !== "production";
const markModeSwitch = createModeSwitchClock({
  report: (sample) => {
    if (!measureModeSwitches) return;
    modeSwitchSamples.push(sample);
    const spread = summarizeModeSwitches(modeSwitchSamples);
    // ONE string, and `warn`: the forwarder that carries the webview console into the `tauri dev`
    // terminal has only ever been seen carrying single-argument warnings and errors, and an
    // `info` with an object argument produced nothing at all.
    console.warn(
      `[mode-switch] ${sample.from}->${sample.to} ${sample.ms.toFixed(1)}ms firstBuild=${sample.firstBuild} ` +
        `isi="${sample.contents ?? "-"}" ` +
        `n=${spread.count} min=${spread.min.toFixed(1)} p50=${spread.p50.toFixed(1)} p95=${spread.p95.toFixed(1)} max=${spread.max.toFixed(1)}`,
    );
  },
});


/** Below this width two panes and a rail stop fitting, so the rail steps aside on its own. */
const NARROW_SHELL_WIDTH = 980;

interface WorkspaceShellPageProps {
  /**
   * Whether this shell is the surface the window is drawing.
   *
   * `AppShell` keeps the shell mounted while the window is on a route that owns nothing —
   * CodeCanvas above all — so that the terminals stay attached and the agents keep running. A
   * parked shell is invisible and inert, but its window-level keydown listeners are still
   * installed, so it has to be TOLD to stop answering: without this, ⌘B would still
   * fire while the canvas is on screen. ⌘J (the Jump palette) is the one that still answers there.
   */
  shown?: boolean;
}

/**
 * The shell reads the window's one tracker board (`TrackerBoardProvider`, mounted by AppShell so
 * the Canvas Dock reads the same one). Rendered alone — a test, a preview — it brings its own.
 */
export function WorkspaceShellPage(props: WorkspaceShellPageProps = {}) {
  const shared = useOptionalSharedTrackerBoard();
  return shared ? (
    <WorkspaceShell {...props} />
  ) : (
    <TrackerBoardProvider>
      <WorkspaceShell {...props} />
    </TrackerBoardProvider>
  );
}

function WorkspaceShell({ shown = true }: WorkspaceShellPageProps) {
  const router = useRouter();
  const { layout, update } = useShellLayout();
  const macOverlayChrome = useMacOverlayChrome();
  const shortcut = useFormatShortcut();
  const [shellRef, shell] = useElementSize<HTMLDivElement>();
  // A rail forced open in a narrow window is this session's business, not a stored preference:
  // the layout someone arranged on a wide screen must survive being opened on a small one.

  const narrow = shell.width > 0 && shell.width < NARROW_SHELL_WIDTH;
  const [wasNarrow, setWasNarrow] = useState(narrow);
  // Adjusted during render rather than in an effect: React's own pattern for state that has to
  // follow a changing input, and it avoids rendering one frame with the stale value.
  if (wasNarrow !== narrow) {
    setWasNarrow(narrow);
  }

  const railVisible = layout.railVisible;
  const mode: ShellMode = layout.mode;
  // Tell Lotus Settings which mode is on screen, so ⌘, starts in that mode's group. Parked behind
  // the canvas, the shell is not the mode on screen and says nothing.
  useLotusSettingsHost(useMemo(() => (shown ? { mode } : null), [shown, mode]));

  // The chrome shows what the SHOWING mode reports. Each mode keeps its own last report, so
  // switching back does not blank the pill while the other mode re-reports.
  const [statusByMode, setStatusByMode] = useState<
    Record<"code" | "chat", ShellModeStatus | null>
  >({
    code: null,
    chat: null,
  });
  const reportCodeStatus = useCallback((status: ShellModeStatus | null) => {
    setStatusByMode((current) =>
      current.code === status ? current : { ...current, code: status },
    );
  }, []);
  const reportChatStatus = useCallback((status: ShellModeStatus | null) => {
    setStatusByMode((current) =>
      current.chat === status ? current : { ...current, chat: status },
    );
  }, []);
  /**
   * The workspaces Code mode holds, so Tasks can call them projects.
   *
   * Reported UP rather than read again: `useCodeSpaceWorkspaces` is the snapshot's writer and may
   * be mounted exactly once per window — a second reader-that-is-also-a-writer is the two-owner
   * bug this shell already had once.
   */
  const [projects, setProjectsHere] = useState<TrackerProjectInput[]>([]);
  const sharedBoard = useSharedTrackerBoard();
  const { publishProjects, publishActivities, publishSpawner } = sharedBoard;
  // Published as Code mode reports them, never before: until then the board names the saved ones.
  const setProjects = useCallback(
    (next: TrackerProjectInput[]) => {
      setProjectsHere(next);
      publishProjects(next);
    },
    [publishProjects],
  );
  // Leaving for a route that unmounts the shell (`/codechat`) takes its panes with it.
  useEffect(
    () => () => {
      publishSpawner(null);
      publishActivities(new Map());
    },
    [publishActivities, publishSpawner],
  );
  const status = statusByMode[mode];

  /**
   * Keep-alive per mode (§M2).
   *
   * Code is mounted from the start because it owns the PTY sessions. Chat is built LAZILY — an
   * unvisited Chat costs nothing — but once built it stays, because a mode that is rebuilt on
   * every switch rebuilds its conversation view while a reply may still be arriving. So: no cost
   * until you use it, no remount after.
   */
  const [chatEverShown, setChatEverShown] = useState(mode === "chat");
  // One listing for the whole shell: Chat mode draws it, the Chat tab's mark and the alerts read it.
  const chatRail = useChatRail();
  const chatMark = chatTabMark(chatRail.threads);
  if (mode === "chat" && !chatEverShown) {
    setChatEverShown(true);
  }
  /**
   * The tracker board, owned here rather than by the panel.
   *
   * The sidebar's Tasks row carries a count of open tasks whether or not the panel is open, so
   * SOMETHING has to read the store either way — and two readers would be two answers. `bb` keeps
   * the same arrangement: its sidebar count is live, and its panel reads the same data.
   */
  const { board, vault, githubSources, activities, spawner } = sharedBoard;
  // Connectors shows each Notion source in the same words as the Tasks nav row (SOURCES 06).
  const notionHealth = useMemo(
    () =>
      board.projects.flatMap((project) =>
        project.source?.kind === "notion" && project.source.health
          ? [{ id: project.id, name: project.name, health: project.source.health }]
          : [],
      ),
    [board.projects],
  );
  const githubHealth = useMemo(
    () =>
      board.projects.flatMap((project) => {
        const config = githubSources.find((source) => source.id === project.id);
        return project.source?.kind === "github" && project.source.health && config
          ? [{ id: project.id, name: project.name, account: config.account, health: project.source.health }]
          : [];
      }),
    [board.projects, githubSources],
  );
  // Each row counted by its OWN project's words: a vault ticket is open in `qa-revision` and
  // finished in `released`, neither of which is a word Lotus speaks.
  const openTaskCount = useMemo(
    () => countTasks(board.tasks, vocabularyByProject(board.projectsById)).open,
    [board.projectsById, board.tasks],
  );

  const tasksOpen = layout.tasksOpen;
  const automationOpen = layout.automationOpen && !tasksOpen;
  const connectorsOpen = layout.connectorsOpen && !tasksOpen && !automationOpen;
  const factoryOpen = layout.factoryOpen && !tasksOpen && !automationOpen && !connectorsOpen;
  const chatShown = shown && mode === "chat" && !tasksOpen && !automationOpen && !connectorsOpen && !factoryOpen;
  useChatAgentDoneAlerts(chatRail.threads, chatRail.activeId, chatShown);
  // One panel covers the working area at a time: opening one closes the others.
  const openTasks = useCallback(() => update({ ...NO_PANEL, tasksOpen: true }), [update]);
  const closeTasks = useCallback(() => update({ tasksOpen: false }), [update]);
  const openAutomation = useCallback(() => update({ ...NO_PANEL, automationOpen: true }), [update]);
  // The automation to land on when Automations opens from Connectors › Used by; null is Inbox.
  // Spent once the panel closes, so the next plain open starts on Inbox.
  const [automationChannel, setAutomationChannel] = useState<string | null>(null);
  if (!automationOpen && automationChannel !== null) setAutomationChannel(null);
  const openAutomationChannel = useCallback(
    (id: string) => {
      setAutomationChannel(id);
      update({ ...NO_PANEL, automationOpen: true });
    },
    [update],
  );
  const closeAutomation = useCallback(() => update({ automationOpen: false }), [update]);
  const openConnectors = useCallback(() => update({ ...NO_PANEL, connectorsOpen: true }), [update]);
  const closeConnectors = useCallback(() => update({ connectorsOpen: false }), [update]);
  // The run the Factory opens on; set by an issue's "Open in Factory", cleared by the nav row.
  const [factoryFocus, setFactoryFocus] = useState<string | null>(null);
  const openFactory = useCallback(() => {
    setFactoryFocus(null);
    update({ ...NO_PANEL, factoryOpen: true });
  }, [update]);
  const openFactoryRun = useCallback(
    (repo: string, issue: FactoryRef, tab?: "chief") => {
      setFactoryFocus(factoryWorkflowId(repo, issue));
      // "Open in Chief of Staff" (CoS 10): the pane selects the run's PR by the same key.
      const factoryTab = tab ?? (layout.factoryTab === "insights" ? ("runs" as const) : undefined);
      update({ ...NO_PANEL, factoryOpen: true, ...(factoryTab ? { factoryTab } : {}) });
    },
    [layout.factoryTab, update],
  );
  // A canvas Factory node's double-click: it asks, and the panel opens on that run (#146).
  useEffect(() => onOpenFactoryRunRequest(({ repo, issue }) => openFactoryRun(repo, issue)), [openFactoryRun]);
  const closeFactory = useCallback(() => update({ factoryOpen: false }), [update]);
  const closePanels = useCallback(() => update(NO_PANEL), [update]);
  const automationClient = useMemo(() => createTauriAutomationClient(), []);
  const connectorsClient = useMemo(() => createTauriConnectorsClient(), []);
  const factoryRunsClient = useMemo(() => createTauriFactoryRunsClient(), []);
  // Read here, not in the panel, so the sidebar badge counts runs that need you with the panel closed.
  const factoryRuns = useFactoryRuns(factoryRunsClient);
  // Asked only while the Factory panel is open: the strip is the only reader.
  const chiefCheckedAt = useFactoryChiefCheckedAt(layout.factoryOpen);
  // A Factory Run waiting on its questions or spec is listed in Inbox too (FI2), and opens in the Factory.
  const factoryWaiting = useMemo(
    () =>
      factoryIntakeWaiting(factoryRuns.rows).map((run) => ({
        id: `factory:${run.id}`,
        source: "Factory",
        title: run.title,
        line: run.line,
        onOpen: () => openFactoryRun(run.repo, run.issue),
      })),
    [factoryRuns.rows, openFactoryRun],
  );
  const factorySources = useFactorySources(sharedBoard, automationClient);
  const factoryActions = useMemo(() => {
    const actions = createTauriFactoryRunActions(factorySources.readIssue);
    if (!spawner) return actions;
    // Brainstorm live (FI2): an agent pane in the workspace on the run's checkout, as "Create with agent" opens one.
    const brainstorm = async (prompt: string, checkout: string) => {
      const workspaceId = brainstormWorkspace(spawner.workspaces?.() ?? [], checkout, spawner.activeWorkspaceId?.() ?? null);
      const error = await startAgentWithPrompt(workspaceId, prompt, agentPaneDeps(spawner.addPane));
      if (!error) update({ factoryOpen: false, mode: "code" });
      return error;
    };
    return { ...actions, brainstorm };
  }, [factorySources.readIssue, spawner, update]);
  const { newRun: factoryNewRun, agents: factoryAgents } = factorySources;
  const waitingDrafts = usePendingDrafts(automationClient, subscribeToAutomationChanges);
  const pendingDrafts = waitingDrafts.length;
  // Needs you's other rows (GLOSSARY): stopped Factory runs and Automation Asks, opened where answered.
  const needsYouAsks = useMemo(
    () => [
      ...factoryNeedsYouAsks(factoryRuns.rows, (row) => openFactoryRun(row.repo, row.issue)),
      ...automationNeedsYouAsks(waitingDrafts, (draft) => requestOpenAsk(draft.id)),
    ],
    [factoryRuns.rows, openFactoryRun, waitingDrafts],
  );
  // Runs of an automation with a project open their pane here, panel open or not.
  useAutomationPanes(automationClient, spawner);
  // Following an Ask's notification (heard by the app frame) opens Automation › Inbox on that Ask.
  const openAsk = useSyncExternalStore(subscribeToOpenAskRequest, openAskRequest, () => null);
  const askSeq = openAsk?.seq;
  useEffect(() => {
    if (askSeq !== undefined) openAutomation();
  }, [askSeq, openAutomation]);
  // Spent once the panel closes: opening it again later starts where it always does.
  const panelWasOpen = useRef(automationOpen);
  useEffect(() => {
    if (panelWasOpen.current && !automationOpen) clearOpenAskRequest();
    panelWasOpen.current = automationOpen;
  }, [automationOpen]);
  const connectorAttention = useConnectorAttention(connectorsClient);
  const tasksNav = useMemo(
    () => (
      <>
        <AutomationNavRow pendingCount={pendingDrafts} active={automationOpen} onOpen={openAutomation} />
        <ConnectorsNavRow active={connectorsOpen} attention={connectorAttention} onOpen={openConnectors} />
        <FactoryNavRow active={factoryOpen} needsYou={factoryRuns.needsYou} onOpen={openFactory} />
        <TasksNavRow openCount={openTaskCount} active={tasksOpen} onOpen={openTasks} />
      </>
    ),
    [
      automationOpen,
      connectorAttention,
      connectorsOpen,
      factoryOpen,
      factoryRuns.needsYou,
      openAutomation,
      openConnectors,
      openFactory,
      openTaskCount,
      openTasks,
      pendingDrafts,
      tasksOpen,
    ],
  );
  /*
    "Create with agent" opens a claude pane in the workspace Code mode is showing, then steps out
    of the panel onto that pane — the agent has to ask the user for a yes, so they must see it.
  */
  const createWithAgent = useMemo(
    () =>
      spawner
        ? async (prompt: string) => {
            const workspaceId = spawner.activeWorkspaceId?.() ?? projects[0]?.id ?? null;
            const error = await startAgentWithPrompt(workspaceId, prompt, agentPaneDeps(spawner.addPane));
            if (!error) update({ automationOpen: false, connectorsOpen: false, factoryOpen: false, mode: "code" });
            return error;
          }
        : undefined,
    [projects, spawner, update],
  );
  // Settings › Accounts and the usage popover ask for a pane running `claude auth login` (step 4).
  useEffect(
    () =>
      onSignInPaneRequest((command, target) => {
        // The command names one machine's account folder, so it runs on that machine only.
        const active = spawner?.activeWorkspaceId?.() ?? projects[0]?.id ?? null;
        const workspaceId = pickSignInWorkspace(spawner?.workspaces?.() ?? [], active, target);
        if (!spawner || !workspaceId || !spawner.addPane(workspaceId, command)) return false;
        update({ ...NO_PANEL, mode: "code" });
        return true;
      }),
    [projects, spawner, update],
  );
  /*
    Automations draws its sidebar INTO the window's rail (one sidebar, not two). The node lives in
    whichever mode is showing; the surface portals into it. With the rail hidden there is no node,
    and the surface draws its own sidebar again.
  */
  const [railSectionEl, setRailSectionEl] = useState<HTMLDivElement | null>(null);
  const automationNavTarget = railVisible ? railSectionEl : undefined;
  const railSection = useMemo(
    () =>
      automationOpen && railVisible ? (
        <RailSection backLabel={mode === "chat" ? "Threads" : "Workspaces"} onBack={closePanels} targetRef={setRailSectionEl} />
      ) : null,
    [automationOpen, closePanels, mode, railVisible],
  );
  const { automationNavWidth, automationPaneWidth } = layout;
  const automationPanel = useMemo(
    () =>
      automationOpen ? (
        <AutomationSurface
          client={automationClient}
          subscribe={subscribeToAutomationChanges}
          onClose={closeAutomation}
          onCreateWithAgent={createWithAgent}
          onOpenConnectors={openConnectors}
          projects={projects}
          openAsk={automationOpen ? openAsk : null}
          // Only its own two widths: a terminal drag must not re-render the whole panel.
          layout={{ automationNavWidth, automationPaneWidth }}
          onLayoutChange={update}
          navTarget={automationNavTarget}
          waitingElsewhere={factoryWaiting}
          initialChannel={automationChannel}
        />
      ) : connectorsOpen ? (
        <ConnectorsSurface
          client={connectorsClient}
          subscribe={subscribeToConnectorChanges}
          onClose={closeConnectors}
          notionSources={notionHealth}
          githubSources={githubHealth}
          onOpenAutomation={openAutomationChannel}
        />
      ) : factoryOpen ? (
        <FactorySurface
          runs={factoryRuns}
          onClose={closeFactory}
          actions={factoryActions}
          tab={layout.factoryTab}
          onTabChange={(factoryTab) => update({ factoryTab })}
          focusKey={factoryFocus}
          newRun={factoryNewRun}
          agents={factoryAgents}
          chiefCheckedAt={chiefCheckedAt}
        />
      ) : null,
    [
      automationChannel,
      automationClient,
      automationOpen,
      closeAutomation,
      closeConnectors,
      connectorsClient,
      connectorsOpen,
      closeFactory,
      createWithAgent,
      factoryActions,
      factoryAgents,
      chiefCheckedAt,
      factoryFocus,
      factoryNewRun,
      factoryOpen,
      factoryRuns,
      factoryWaiting,
      layout.factoryTab,
      githubHealth,
      notionHealth,
      openAsk,
      openAutomationChannel,
      openConnectors,
      projects,
      automationNavWidth,
      automationNavTarget,
      automationPaneWidth,
      update,
    ],
  );

  /**
   * The tracker, handed to whichever mode is showing so it covers that mode's WORKING AREA.
   *
   * Not a surface of its own: a panel that covered the whole window would cover the rail it was
   * opened from, and the way back out with it. `bb` keeps its sidebar live for exactly that
   * reason.
   */
  // A row's live badge (LOT2-220): Tasks steps aside, Code comes up, and that pane takes focus.
  const codePaneIds = statusByMode.code?.paneIds;
  const focusCodePane = statusByMode.code?.onFocusPane;
  const agentJump = useMemo(
    () =>
      codePaneIds && focusCodePane
        ? {
            label: "Show agent pane",
            has: (cellId: string) => codePaneIds.has(cellId),
            show: (task: TrackerTask) => {
              const paneId = task.cellId;
              if (!paneId) return;
              update({ tasksOpen: false, mode: "code" });
              // After the switch lands: Code is `inert` while another mode shows, and focus into it fails.
              requestAnimationFrame(() => focusCodePane(paneId));
            },
          }
        : undefined,
    [codePaneIds, focusCodePane, update],
  );
  const tasksPanel = useMemo(
    () =>
      tasksOpen ? (
        <TasksSurface
          board={board}
          agentJump={agentJump}
          activities={activities}
          vault={vault}
          spawner={spawner}
          layout={layout}
          onLayoutChange={update}
          onClose={closeTasks}
          onOpenConnectors={openConnectors}
          onOpenFactoryRun={openFactoryRun}
        />
      ) : null,
    [activities, agentJump, board, closeTasks, layout, openConnectors, openFactoryRun, spawner, tasksOpen, update, vault],
  );

  const changeMode = useCallback(
    (next: ShellMode) => {
      // Canvas keeps its own chrome and its own command bar: selecting it leaves this shell
      // rather than redrawing Canvas inside it. See plans/unified-workspace-shell §M2.
      if (next === "canvas") {
        router.push("/canvas");
        return;
      }
      if (next !== mode) {
        markModeSwitch(
          mode,
          next,
          next === "chat" && !chatEverShown,
          `${statusByMode.code?.label ?? "-"} · fokus=${statusByMode.code?.focusKind ?? "-"}`,
        );
      }
      update({ mode: next });
    },
    [chatEverShown, mode, router, statusByMode.code, update],
  );

  const toggleRail = useCallback(() => {
    update({ railVisible: !railVisible });
  }, [railVisible, update]);

  /*
    The Jump palette (GLOSSARY): ⌘J from every mode, Canvas included, so it answers while the shell
    is parked behind the canvas. Modes are its rows; ⌘1/⌘2/⌘3 are gone.
  */
  const [jumpOpen, setJumpOpen] = useState(false);
  const closeJump = useCallback(() => setJumpOpen(false), []);
  const [pendingPane, setPendingPane] = useState<string | null>(null);
  const jumpWorkspaces = statusByMode.code?.jumpWorkspaces;
  const selectCodeWorkspace = statusByMode.code?.onSelectWorkspace;
  const { threads: chatThreads, setActiveId: setChatActiveId, setAgentId: setChatAgentId } = chatRail;
  const jumpSources = useCallback(
    (): JumpSources => ({
      workspaces: jumpWorkspaces?.() ?? [],
      threads: chatThreads,
      threadInPane: chatPaneThreads,
      recent: readRecent(),
      asks: needsYouAsks,
      paneAsks: paneAsks(),
    }),
    [chatThreads, jumpWorkspaces, needsYouAsks],
  );
  // The waiting agents' questions, for Needs you's second line.
  useEffect(() => startPaneAsks(), []);
  const jumpTo = useCallback(
    (target: JumpTarget) => {
      const { kind } = target;
      if (kind === "mode" && target.mode === "canvas") {
        changeMode("canvas");
        return;
      }
      if (!shown) router.push("/");
      if (target.kind === "ask") {
        target.open();
      } else if (kind === "mode") {
        update({ ...NO_PANEL, mode: target.mode === "chat" ? "chat" : "code" });
      } else if (target.kind === "thread") {
        setChatAgentId?.(null);
        setChatActiveId(target.threadId);
        update({ ...NO_PANEL, mode: "chat" });
      } else {
        if (target.kind === "workspace") selectCodeWorkspace?.(target.workspaceId);
        else setPendingPane(target.paneId);
        update({ ...NO_PANEL, mode: "code" });
      }
    },
    [changeMode, router, selectCodeWorkspace, setChatActiveId, setChatAgentId, shown, update],
  );
  const markCodePaneSeen = statusByMode.code?.onMarkSeen;
  const markSeen = useCallback(
    (target: JumpTarget) => {
      if (target.kind === "pane") markCodePaneSeen?.(target.paneId);
      else if (target.kind === "thread") void markChatThreadRead(target.threadId).catch(() => undefined);
    },
    [markCodePaneSeen],
  );

  /*
    Needs you, counted over every source for the chrome's badge and the Dock: Code reports its panes
    (a Chat thread in a pane counted there), Chat's own threads, then Factory and Automation.
  */
  const codeNeeds = statusByMode.code?.needsYou;
  let chatWaiting = 0;
  let chatDone = 0;
  for (const thread of chatThreads) {
    if (thread.archived || [...chatPaneThreads.values()].includes(thread.id)) continue;
    const state = railState(thread);
    if (state === "waiting") chatWaiting += 1;
    else if (state === "ready") chatDone += 1;
  }
  const needsWaiting = (codeNeeds?.waiting ?? 0) + chatWaiting + needsYouAsks.length;
  const needsDone = (codeNeeds?.done ?? 0) + chatDone;
  const jumpToOldest = useCallback(() => {
    const item = oldestNeedsYou(buildJumpItems(jumpSources()));
    if (item) jumpTo(item.target);
  }, [jumpSources, jumpTo]);
  useNeedsYouAlerts({
    waiting: needsWaiting,
    signature: `${codeNeeds?.waiting ?? 0}/${codeNeeds?.done ?? 0}|${chatWaiting}/${chatDone}|${needsYouAsks.map((ask) => ask.id).join(" ")}`,
    readItems: () => buildJumpItems(jumpSources()),
    onOpen: jumpTo,
  });
  useWorktreeAutoCleanup();
  // A pane takes focus once Code is on screen: it is `inert` while another mode or the canvas shows.
  useEffect(() => {
    if (!pendingPane || !shown || mode !== "code" || !focusCodePane) return;
    const frame = requestAnimationFrame(() => {
      focusCodePane(pendingPane);
      setPendingPane(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusCodePane, mode, pendingPane, shown]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isOldestNeedsYouShortcut(event)) {
        event.preventDefault();
        setJumpOpen(false);
        jumpToOldest();
        return;
      }
      if (isJumpPaletteShortcut(event)) {
        event.preventDefault();
        setJumpOpen((open) => !open);
        return;
      }
      if (shown && isToggleRailShortcut(event)) {
        event.preventDefault();
        toggleRail();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [jumpToOldest, shown, toggleRail]);

  return (
    <div
      className="ws-shell"
      ref={shellRef}
      data-narrow={narrow ? "true" : undefined}
    >
      {jumpOpen ? <JumpPalette getSources={jumpSources} onJump={jumpTo} onMarkSeen={markSeen} onClose={closeJump} /> : null}
      {/* One rail toggle for both modes (§M2, G5). It moved here once BOTH modes started
          reading `layout.railVisible`; while only one did, a chrome button that collapsed one
          rail and not the other would have been a lie. */}
      <ShellChrome
        mode={mode}
        onModeChange={changeMode}
        onToggleRail={toggleRail}
        railVisible={railVisible}
        reserveTrafficLights={macOverlayChrome}
        chatMark={chatMark}
        status={
          needsWaiting + needsDone > 0 ? (
            /*
              Needs you's badge (GLOSSARY), over every mode: it opens the Jump palette, whose empty
              list starts with Needs you. `aria-live` only while something waits, so "2 working"
              never interrupts a screen reader but an unanswered prompt does.
            */
            <button
              type="button"
              className="ws-pane-pill"
              data-attention={needsWaiting > 0 ? "true" : undefined}
              aria-live={needsWaiting > 0 ? "polite" : undefined}
              title={`Needs you (${shortcut("⌘J")}) · ${shortcut("⌘⇧J")} opens the one waiting longest`}
              style={{ ["--ws-tone" as string]: needsWaiting > 0 ? "var(--ws-activity-ask)" : `var(--ws-kind-${status?.tone ?? "terminal"})` }}
              onClick={() => setJumpOpen(true)}
            >
              <span className="ws-pane-pill-dot" aria-hidden />
              {[needsWaiting > 0 ? `${needsWaiting} waiting` : null, needsDone > 0 ? `${needsDone} done` : null].filter(Boolean).join(" · ")}
            </button>
          ) : status ? (
            <button type="button" className="ws-pane-pill" disabled title={status.label} style={{ ["--ws-tone" as string]: `var(--ws-kind-${status.tone})` }}>
              <span className="ws-pane-pill-dot" aria-hidden />
              {status.label}
            </button>
          ) : null
        }
      />
      {/* One command bar can reach a conversation it does not own, by calling that
        conversation's own send. See `thread-composer-registry.tsx` (§M3). */}
      <ThreadComposerRegistryProvider>
        {/*
      Code mode stays MOUNTED while Chat is showing. It owns the PTY sessions and the
      workspace snapshot; unmounting it would kill every running terminal on a mode switch.
      Chat mode is cheap to remount — its threads live in the chat runtime — so it is rendered
      only while shown.
    */}
        <div className="ws-surfaces">
          {/*
            A mode is "showing" only when the tracker is NOT over it. Hidden this way it stays
            mounted and its panes stay attached — the same bargain the modes make with each
            other, measured at 36ms to come back (§M2) — but it stops taking clicks and stops
            being read aloud underneath a panel that covers it.
          */}
          <div
            className="ws-surface"
            data-active={mode === "code" ? "true" : undefined}
            aria-hidden={mode !== "code"}
            inert={mode !== "code"}
          >
            {/* Not on screen under a panel either: a native browser would draw over the panel. */}
            <SurfaceVisible visible={mode === "code" && !tasksOpen && !automationOpen && !connectorsOpen && !factoryOpen}>
            <CodeMode
              navSlot={tasksNav}
              sectionSlot={mode === "code" ? railSection : null}
              onSpawnerChange={publishSpawner}
              onActivitiesChange={publishActivities}
              columnOverlay={mode === "code" ? (tasksPanel ?? automationPanel) : null}
              railVisible={railVisible}
              layout={layout}
              onLayoutChange={update}
              onProjectsChange={setProjects}
              active={mode === "code"}
              /* Parked behind another route, or under the tracker: panes stay attached, the
                 keyboard goes quiet. */
              shown={shown && !tasksOpen && !automationOpen && !connectorsOpen && !factoryOpen}
              /* Choosing a pane in the rail means "show me that pane", so the tracker steps
                 aside. The rail stays live under the panel by design, which is exactly why
                 the click has to be answered here: the mode does not own the panel. */
              onRevealWork={closePanels}
              onStatusChange={reportCodeStatus}
            />
            </SurfaceVisible>
          </div>
          {chatEverShown ? (
            <div
              className="ws-surface"
              data-active={mode === "chat" ? "true" : undefined}
              aria-hidden={mode !== "chat"}
              inert={mode !== "chat"}
            >
              <SurfaceVisible visible={chatShown}>
              <ChatMode
                rail={chatRail}
                shown={chatShown}
                navSlot={tasksNav}
                sectionSlot={mode === "chat" ? railSection : null}
                columnOverlay={mode === "chat" ? (tasksPanel ?? automationPanel) : null}
                onRevealWork={closePanels}
                railVisible={railVisible}
                railWidth={layout.railWidth}
                onRailResize={(width) => update({ railWidth: width })}
                onStatusChange={reportChatStatus}
              />
              </SurfaceVisible>
            </div>
          ) : null}

        </div>
      </ThreadComposerRegistryProvider>
    </div>
  );
}

export default WorkspaceShellPage;
