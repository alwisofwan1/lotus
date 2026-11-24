"use client";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Node } from "@xyflow/react";
import { CodeXml, Factory, ListChecks, PanelRightClose, Rows3, Workflow, X } from "lucide-react";
import { AutomationPanel, type AgentWatchHost, type AutomationProject, type WaitingElsewhere } from "@/modules/automation";
import { createTauriFactoryRunActions, FactorySurface, type FactoryAgentsSource, type FactoryNewRunSource, type FactoryRunActions, type FactoryTab } from "@/modules/factory";
import { createTauriAutomationClient } from "@/modules/automation/services/automation-api";
import type { SelectionSendResult } from "@/modules/codespace/services/selection-send";
import type { CanvasDock as CanvasDockState } from "../hooks/useCanvasDock";
import { CanvasFleetPanel } from "../components/CanvasFleetPanel";
import { CanvasNeedsYouLane } from "../components/CanvasNeedsYouLane";
import { CodeDockApp } from "../components/CodeDockApp";
import { getActiveProjectLocation } from "../services/canvas-active-project";
import { isCodeEditorKeyTarget, isEditorWidgetOpen } from "../services/canvas-keyboard-guard";
import { useNeedsYouQueue } from "../hooks/useNeedsYouQueue";
import { useAgentStatusSnapshots } from "../hooks/useAgentStatusSnapshots";
import type { AgentStatusRegistry } from "../services/agent-status-registry";
import { NEEDS_YOU_SOURCE_LABEL, type NeedsYouAsk } from "../services/needs-you-queue";
// The hosted surfaces read the shell's tokens (--ws-*), which live on .ws-shell.
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { useOptionalSharedTrackerBoard, type SharedTrackerBoard } from "@/modules/workspace-shell/hooks/TrackerBoardProvider";
import { useFactorySources } from "@/modules/workspace-shell/hooks/useFactorySources";
import { useShellLayout } from "@/modules/workspace-shell/hooks/useShellLayout";
import type { TaskSpawner } from "@/modules/tasks/services/task-spawner";
import type { TrackerTask } from "@/modules/tasks/types";
import "@/styles/workspace-shell.css";

/** What the Fleet app needs: the board, and what a row press does. */
export interface DockFleet {
  nodes: Node[];
  /** The node being looked at, so its row reads as current. */
  heroId?: string | null;
  /** Fly to the node; the pressed row travels along so the caller can blur it if focus fails. */
  onFocusNode: (nodeId: string, source?: HTMLElement | null) => void;
  onCloseNode: (nodeId: string) => void;
  onRenameNode?: (nodeId: string, label: string) => void;
  /** Puts a terminal on the board: the empty Fleet's one action. */
  onAddTerminal?: () => void;
  /** Injected for tests; production uses the process-wide store. */
  registry?: AgentStatusRegistry;
}

interface Props {
  dock: CanvasDockState;
  projects?: AutomationProject[];
  /** Opens an agent on the canvas with this prompt; resolves to why not. */
  onCreateWithAgent?: (prompt: string) => Promise<string | null>;
  /** The agent the Dock's New page opens, followed in place (16e v2) rather than handed off. */
  agentWatch?: AgentWatchHost;
  /** What Factory's run actions do; tests pass fakes. Absent: the app's own (Tauri). */
  factoryActions?: FactoryRunActions;
  /** Brainstorm live as a canvas terminal in the run's Frame (S3). Absent: no Brainstorm live. */
  factoryBrainstorm?: FactoryRunActions["brainstorm"];
  fleet: DockFleet;
  /** Opens a delegated task's agent as a canvas terminal (S4b). Absent: Delegate says it cannot. */
  taskSpawner?: TaskSpawner | null;
  /** The board's folder: Tasks delegates a ticket to the workspace there unless another is picked. */
  boardFolder?: string | null;
  /** Task id → the linked Task node showing it on this board, and centring a node (board 18). */
  /** `nodes`: task id → its Task node. `panes`: a terminal's runtime pane id → its node. */
  canvasTasks?: { nodes: ReadonlyMap<string, string>; panes?: ReadonlyMap<string, string>; reveal: (nodeId: string) => void };
  /** Code's "Show on board": the Dock closes and the camera goes to that file's File Node. */
  onShowFileOnBoard?: (path: string) => void;
  /** Code's "Open file on board" for a file an agent touched: the node, wired to that agent. */
  onOpenFileFromAgent?: (path: string, agentNodeId: string) => void;
  /** Code's "Send to thread": types the text into an agent on the board. */
  onSendToAgent?: (text: string) => SelectionSendResult;
  /** The chord labels for the tooltips, as bound (they are remappable). */
  toggleChord: string;
  widenChord: string;
}

/**
 * The Canvas Dock: one panel on the right, its App Rail on the outer edge (the mirror of the Tool
 * Rail), Close on top of the rail. Screen-fixed, not in flow coordinates: it must not pan or zoom.
 *
 * Fleet is a Dock app: the same rows and needs-you lane the focus rail draws, as a list. A press
 * flies to the node and leaves the board's layout alone — the hero layout is focus mode's (⌘.).
 */
export function CanvasDock({ dock, projects, onCreateWithAgent, agentWatch, factoryActions, factoryBrainstorm, fleet, taskSpawner = null, boardFolder = null, canvasTasks, onShowFileOnBoard, onOpenFileFromAgent, onSendToAgent, toggleChord, widenChord }: Props) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  // Remember where focus was when the Dock opened, and give it back on close: Esc must land the
  // user where they were, not on <body>.
  useEffect(() => {
    if (!dock.open) return;
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement && !panelRef.current?.contains(active) ? active : null;
    return () => {
      const back = returnFocusRef.current;
      if (back && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [dock.open]);

  if (!dock.open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A surface inside that uses Escape for itself (a drawer, the composer) stops it first.
    if (event.key !== "Escape") return;
    // Escape in the editor belongs to Monaco's open widget (find, suggest, hover, rename) first.
    if (isCodeEditorKeyTarget(event.target) && isEditorWidgetOpen(event.currentTarget)) return;
    event.stopPropagation();
    dock.close();
  };

  const automationWaiting = dock.waiting.find((item) => item.app === "automation")?.count ?? 0;
  const factoryWaiting = dock.waiting.find((item) => item.app === "factory")?.count ?? 0;
  const tasksWaiting = dock.waiting.find((item) => item.app === "tasks")?.count ?? 0;

  return (
    <aside
      ref={panelRef}
      className="canvas-dock nodrag nopan nowheel"
      data-wide={dock.wide ? "true" : undefined}
      aria-label="Dock"
      onKeyDown={onKeyDown}
    >
      <div className="ws-shell canvas-dock-body">
        {dock.app === "automation" ? (
          <DockAutomationApp dock={dock} fleet={fleet} projects={projects} onCreateWithAgent={onCreateWithAgent} agentWatch={agentWatch} />
        ) : null}
        {dock.app === "factory" ? <DockFactoryApp dock={dock} actions={factoryActions} brainstorm={factoryBrainstorm} /> : null}
        {dock.app === "tasks" ? <DockTasksApp dock={dock} spawner={taskSpawner} boardFolder={boardFolder} canvasTasks={canvasTasks} /> : null}
        {dock.app === "fleet" ? <DockFleetApp fleet={fleet} asks={dock.asks} /> : null}
        {dock.app === "code" ? (
          <CodeDockApp
            rootDir={boardFolder}
            location={getActiveProjectLocation()}
            request={dock.code.request}
            registry={fleet.registry}
            onShowOnBoard={onShowFileOnBoard}
            onOpenFileFromAgent={onOpenFileFromAgent}
            onSendToAgent={onSendToAgent}
          />
        ) : null}
      </div>
      <nav className="canvas-dock-rail" aria-label="Dock apps">
        <button type="button" className="canvas-dock-rail-btn" aria-label="Close Dock" title={`Close Dock · Esc · ${toggleChord}`} onClick={dock.close}>
          <X size={16} strokeWidth={1.75} />
        </button>
        <span className="canvas-dock-rail-div" aria-hidden />
        <button
          type="button"
          className="canvas-dock-rail-btn"
          aria-label={automationWaiting > 0 ? `Automation, ${automationWaiting} waiting` : "Automation"}
          title={automationWaiting > 0 ? `Automation · ${automationWaiting} waiting` : "Automation"}
          aria-pressed={dock.app === "automation"}
          onClick={() => dock.show("automation")}
        >
          <Workflow size={16} strokeWidth={1.75} />
          {automationWaiting > 0 ? <span className="canvas-dock-badge" aria-hidden>{automationWaiting}</span> : null}
        </button>
        <button
          type="button"
          className="canvas-dock-rail-btn"
          aria-label={factoryWaiting > 0 ? `Factory, ${factoryWaiting} waiting` : "Factory"}
          title={factoryWaiting > 0 ? `Factory · ${factoryWaiting} need you` : "Factory"}
          aria-pressed={dock.app === "factory"}
          onClick={() => dock.show("factory")}
        >
          <Factory size={16} strokeWidth={1.75} />
          {factoryWaiting > 0 ? <span className="canvas-dock-badge" aria-hidden>{factoryWaiting}</span> : null}
        </button>
        <button
          type="button"
          className="canvas-dock-rail-btn"
          aria-label={tasksWaiting > 0 ? `Tasks, ${tasksWaiting} in review` : "Tasks"}
          title={tasksWaiting > 0 ? `Tasks · ${tasksWaiting} in review` : "Tasks"}
          aria-pressed={dock.app === "tasks"}
          onClick={() => dock.show("tasks")}
        >
          <ListChecks size={16} strokeWidth={1.75} />
          {tasksWaiting > 0 ? <span className="canvas-dock-badge" aria-hidden>{tasksWaiting}</span> : null}
        </button>
        <button
          type="button"
          className="canvas-dock-rail-btn"
          aria-label="Fleet"
          title="Fleet"
          aria-pressed={dock.app === "fleet"}
          onClick={() => dock.show("fleet")}
        >
          <Rows3 size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="canvas-dock-rail-btn"
          aria-label="Code"
          title="Code"
          aria-pressed={dock.app === "code"}
          onClick={() => dock.show("code")}
        >
          <CodeXml size={16} strokeWidth={1.75} />
        </button>
        <span className="canvas-dock-rail-spacer" />
        <button
          type="button"
          className="canvas-dock-rail-btn"
          aria-label={dock.wide ? "Narrow the Dock" : "Widen the Dock"}
          title={`${dock.wide ? "Narrow" : "Widen"} · ${widenChord}`}
          aria-pressed={dock.wide}
          onClick={dock.toggleWide}
        >
          <PanelRightClose size={16} strokeWidth={1.75} style={dock.wide ? undefined : { transform: "scaleX(-1)" }} />
        </button>
      </nav>
    </aside>
  );
}

/**
 * Automation in the Dock. Its Inbox lists what waits elsewhere from the same queue as the Needs-you
 * lane (S5), so the two agree: agents and Factory runs here, its own rows below them. An agent's
 * terminal can sit behind the Dock, so its row steps the Dock aside before flying to it.
 */
function DockAutomationApp({
  dock,
  fleet,
  projects,
  onCreateWithAgent,
  agentWatch,
}: {
  dock: CanvasDockState;
  fleet: DockFleet;
  projects?: AutomationProject[];
  onCreateWithAgent?: (prompt: string) => Promise<string | null>;
  agentWatch?: AgentWatchHost;
}) {
  const others = useMemo(() => dock.asks.filter((ask) => ask.source !== "automation"), [dock.asks]);
  const queue = useNeedsYouQueue(useAgentStatusSnapshots(fleet.registry), undefined, undefined, others);
  const elsewhere = queue.map((entry): WaitingElsewhere => {
    const source = entry.source ?? "agent";
    return {
      id: source === "agent" ? `agent:${entry.id}` : entry.id,
      source: NEEDS_YOU_SOURCE_LABEL[source],
      title: entry.name,
      line: entry.headline ?? (source === "agent" ? "Waiting for your answer" : ""),
      onOpen:
        source === "agent"
          ? () => {
              dock.close();
              fleet.onFocusNode(entry.id);
            }
          : () => entry.onOpen?.(),
    };
  });
  return (
    <AutomationPanel
      client={dock.automation.client}
      subscribe={dock.automation.subscribe}
      onClose={dock.close}
      projects={projects}
      onCreateWithAgent={onCreateWithAgent}
      agentWatch={agentWatch}
      openAsk={dock.automation.openAsk}
      waitingElsewhere={elsewhere}
      variant="dock"
    />
  );
}

function DockFleetApp({ fleet, asks }: { fleet: DockFleet; asks: readonly NeedsYouAsk[] }) {
  // Same lane as the focus rail: a blocked agent must not be able to scroll out of sight. One queue
  // (S5): Factory runs and Automation rows that wait sit in it too, and open in their Dock app.
  const needsYou = useNeedsYouQueue(useAgentStatusSnapshots(fleet.registry), undefined, undefined, asks);
  return (
    <div className="canvas-dock-fleet">
      {needsYou.length > 0 ? <CanvasNeedsYouLane entries={needsYou} onFocusNode={fleet.onFocusNode} /> : null}
      <CanvasFleetPanel
        nodes={fleet.nodes}
        heroId={fleet.heroId}
        onFocusNode={fleet.onFocusNode}
        onCloseNode={fleet.onCloseNode}
        onRenameNode={fleet.onRenameNode}
        onAddTerminal={fleet.onAddTerminal}
        registry={fleet.registry}
      />
    </div>
  );
}

/** Said when Delegate is pressed in a Dock with no canvas spawner (a host that passes none). */
export const DOCK_DELEGATE_UNAVAILABLE = "Delegating from the canvas is not ready yet. Use Tasks in Code to delegate for now.";

/**
 * Tasks in the Dock (S4): the same surface as Code's, on the window's one tracker board, so its
 * list, counts and writes are the shell's. Notion and GitHub are polled while it shows. Delegate
 * opens the agent as a terminal on this canvas (S4b), never a Code pane behind it.
 */
function DockTasksApp({
  dock,
  spawner,
  boardFolder,
  canvasTasks,
}: {
  dock: CanvasDockState;
  spawner: TaskSpawner | null;
  boardFolder: string | null;
  canvasTasks?: Props["canvasTasks"];
}) {
  const shared = useOptionalSharedTrackerBoard();
  const linked = canvasTasks?.nodes;
  const revealNode = canvasTasks?.reveal;
  const close = dock.close;
  // "on canvas": the Dock closes and the node is centred — the same move as ⌘J to an agent.
  const onCanvas = useMemo(
    () =>
      linked && revealNode
        ? {
            ids: new Set(linked.keys()),
            reveal: (taskId: string) => {
              const nodeId = linked.get(taskId);
              if (!nodeId) return;
              close();
              revealNode(nodeId);
            },
          }
        : undefined,
    [linked, revealNode, close],
  );
  // The live badge: the Dock closes and the agent's terminal is centred, as "on canvas" does.
  const panes = canvasTasks?.panes;
  const agentJump = useMemo(
    () =>
      panes && revealNode
        ? {
            label: "Show agent on canvas",
            has: (cellId: string) => panes.has(cellId),
            show: (task: TrackerTask) => {
              const nodeId = task.cellId ? panes.get(task.cellId) : undefined;
              if (!nodeId) return;
              close();
              revealNode(nodeId);
            },
          }
        : undefined,
    [panes, revealNode, close],
  );
  const { layout, update } = useShellLayout();
  const setViewing = shared?.setViewing;
  useEffect(() => {
    if (!setViewing) return;
    setViewing("canvas-dock", true);
    return () => setViewing("canvas-dock", false);
  }, [setViewing]);
  if (!shared) return <p className="canvas-dock-empty">Tasks is not available here.</p>;
  const focus = dock.tasks.focus;
  return (
    <div className="canvas-dock-tasks">
      <TasksSurface
        key={focus?.seq ?? 0}
        initialSelectedTaskId={focus?.id ?? null}
        canvasTasks={onCanvas}
        agentJump={agentJump}
        board={shared.board}
        activities={shared.activities}
        vault={shared.vault}
        spawner={spawner}
        delegateUnavailable={spawner ? undefined : DOCK_DELEGATE_UNAVAILABLE}
        defaultTargetFolder={boardFolder}
        layout={layout}
        onLayoutChange={update}
        onClose={dock.close}
        onOpenFactoryRun={(repo, issue) => dock.showFactoryRun(repo, issue)}
      />
    </div>
  );
}

/**
 * Factory in the Dock (S3): the same surface Code and Chat mount, from the module's public index.
 * Run actions are the app's own; Try again reads the run's stored ticket (no tracker board on the
 * canvas yet — S4), and New run and Agents join with it.
 */
function DockFactoryApp({ dock, actions, brainstorm }: { dock: CanvasDockState; actions?: FactoryRunActions; brainstorm?: FactoryRunActions["brainstorm"] }) {
  const shared = useOptionalSharedTrackerBoard();
  // Without the window's tracker board (a bare test host) there are no ticket sources to offer.
  if (!shared) return <DockFactoryView dock={dock} actions={withBrainstorm(actions ?? NO_TICKET_ACTIONS, brainstorm)} />;
  return <DockFactoryWithSources dock={dock} actions={actions} brainstorm={brainstorm} shared={shared} />;
}

/** The caller's own actions keep theirs; the app's get the canvas Brainstorm live. */
const withBrainstorm = (actions: FactoryRunActions, brainstorm?: FactoryRunActions["brainstorm"]): FactoryRunActions =>
  brainstorm && !actions.brainstorm ? { ...actions, brainstorm } : actions;

const NO_TICKET_ACTIONS = createTauriFactoryRunActions(async () => null);

/**
 * The Dock's Factory reads the same ticket sources as Code's panel (useFactorySources): New run,
 * Settings' repos, and the ticket a run's actions read. It had none, so Settings asked for a GitHub
 * ticket source the board already had and Runs offered no way to start one.
 */
function DockFactoryWithSources({
  dock,
  actions,
  brainstorm,
  shared,
}: {
  dock: CanvasDockState;
  actions?: FactoryRunActions;
  brainstorm?: FactoryRunActions["brainstorm"];
  shared: SharedTrackerBoard;
}) {
  const automationClient = useMemo(() => createTauriAutomationClient(), []);
  const sources = useFactorySources(shared, automationClient);
  const own = useMemo(
    () => withBrainstorm(actions ?? createTauriFactoryRunActions(sources.readIssue), brainstorm),
    [actions, sources.readIssue, brainstorm],
  );
  return <DockFactoryView dock={dock} actions={own} newRun={sources.newRun} agents={sources.agents} />;
}

function DockFactoryView({
  dock,
  actions,
  newRun,
  agents,
}: {
  dock: CanvasDockState;
  actions: FactoryRunActions;
  newRun?: FactoryNewRunSource;
  agents?: FactoryAgentsSource;
}) {
  const [tab, setTab] = useState<FactoryTab>("runs");
  return (
    <div className="canvas-dock-factory">
      <FactorySurface
        runs={dock.factory.runs}
        onClose={dock.close}
        actions={actions}
        tab={tab}
        onTabChange={setTab}
        focusKey={dock.factory.focusKey}
        newRun={newRun}
        newRunRequest={dock.factory.newRunRequest}
        agents={agents}
        onOpenTasks={() => dock.show("tasks")}
      />
    </div>
  );
}
