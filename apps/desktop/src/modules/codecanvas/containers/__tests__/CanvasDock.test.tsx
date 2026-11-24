import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { CanvasDock as CanvasDockState } from "../../hooks/useCanvasDock";

vi.mock("@/modules/automation", () => ({
  AutomationPanel: ({ onClose, waitingElsewhere = [] }: { onClose: () => void; waitingElsewhere?: { id: string; source: string; title: string; onOpen: () => void }[] }) => (
    <div data-testid="automation-panel">
      <input aria-label="Draft" />
      <button type="button" onClick={onClose}>panel close</button>
      {waitingElsewhere.map((item) => (
        <button key={item.id} type="button" onClick={item.onOpen}>
          {`elsewhere ${item.source} ${item.title}`}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/modules/factory", () => ({
  createTauriFactoryRunActions: () => ({}),
  FactorySurface: ({ focusKey, newRun, agents, onOpenTasks }: { focusKey: string | null; newRun?: { repos: unknown[] }; agents?: { repos: unknown[] }; onOpenTasks?: () => void }) => (
    <div data-testid="factory-surface" data-new-run-repos={newRun?.repos.length ?? "none"} data-agent-repos={agents?.repos.length ?? "none"}>
      {focusKey ?? "list"}
      {onOpenTasks ? <button type="button" onClick={onOpenTasks}>factory open tasks</button> : null}
    </div>
  ),
}));

const factorySources = vi.fn((shared: { githubSources: { id: string; repo: string }[] }) => ({
  readIssue: async () => null,
  newRun: { repos: shared.githubSources },
  agents: { repos: shared.githubSources },
}));
vi.mock("@/modules/workspace-shell/hooks/useFactorySources", () => ({ useFactorySources: factorySources }));

const sharedBoard = { setViewing: vi.fn(), board: { tasks: [] }, activities: new Map(), vault: {}, githubSources: [{ id: "gh-1", repo: "o/r" }] };
vi.mock("@/modules/workspace-shell/hooks/TrackerBoardProvider", () => ({ useOptionalSharedTrackerBoard: () => sharedBoard }));
vi.mock("@/modules/tasks/containers/TasksSurface", () => ({
  TasksSurface: (props: { initialSelectedTaskId: string | null; spawner: unknown; delegateUnavailable?: string; defaultTargetFolder?: string | null; canvasTasks?: { ids: ReadonlySet<string>; reveal: (taskId: string) => void }; agentJump?: { has: (cellId: string) => boolean; show: (task: { cellId?: string }) => void }; onOpenFactoryRun: (repo: string, issue: number) => void }) => (
    <div data-testid="tasks-surface" data-open={props.initialSelectedTaskId ?? "list"} data-spawner={String(props.spawner)} data-folder={props.defaultTargetFolder ?? ""}>
      {props.delegateUnavailable}
      {[...(props.canvasTasks?.ids ?? [])].map((id) => (
        <button key={id} type="button" onClick={() => props.canvasTasks!.reveal(id)}>{`on canvas ${id}`}</button>
      ))}
      {props.agentJump?.has("pane-3") ? (
        <button type="button" onClick={() => props.agentJump!.show({ cellId: "pane-3" })}>show agent pane-3</button>
      ) : null}
      <button type="button" onClick={() => props.onOpenFactoryRun("o/r", 42)}>open run</button>
    </div>
  ),
}));

vi.mock("../../components/CodeDockApp", () => ({
  CodeDockApp: ({ rootDir, request }: { rootDir: string | null; request: { path: string } | null }) => (
    <div data-testid="code-app" data-root={rootDir ?? ""} data-open={request?.path ?? ""}>
      <div className="monaco-editor">
        <textarea aria-label="Editor input" />
        <div className="find-widget" data-testid="find-widget" />
      </div>
    </div>
  ),
}));

const { CanvasDock } = await import("../CanvasDock");
const { createAgentStatusRegistry } = await import("../../services/agent-status-registry");

function dockState(patch: Partial<CanvasDockState> = {}): CanvasDockState {
  return {
    open: true,
    app: "automation",
    wide: false,
    toggle: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    toggleWide: vi.fn(),
    automation: { client: {} as CanvasDockState["automation"]["client"], subscribe: () => () => {}, openAsk: null },
    factory: { runs: { rows: [], groups: [], loading: false, error: null, needsYou: 0 }, focusKey: null },
    showFactoryRun: vi.fn(),
    showFactoryNewRun: vi.fn(),
    tasks: { focus: null },
    code: { request: null },
    showTask: vi.fn(),
    waiting: [],
    waitingTotal: 0,
    asks: [],
    ...patch,
  };
}

const fleet = { nodes: [] as Node[], onFocusNode: vi.fn(), onCloseNode: vi.fn() };
const base = { fleet, toggleChord: "⌘B", widenChord: "⌘\\" };

describe("CanvasDock", () => {
  it("draws nothing while closed", () => {
    const { container } = render(<CanvasDock {...base} dock={dockState({ open: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("hosts Automation beside its rail, the rail on the outer edge", () => {
    const { container } = render(<CanvasDock {...base} dock={dockState()} />);
    const aside = screen.getByRole("complementary", { name: "Dock" });
    expect(aside).toHaveClass("nodrag", "nopan", "nowheel");
    expect(screen.getByTestId("automation-panel")).toBeInTheDocument();
    // Mirrored: the body first, the rail last (on the right), Close on top of the rail.
    expect(aside.lastElementChild).toHaveClass("canvas-dock-rail");
    const railButtons = container.querySelectorAll(".canvas-dock-rail-btn");
    expect(railButtons[0]).toHaveAccessibleName("Close Dock");
    expect(screen.getByRole("button", { name: "Automation" })).toHaveAttribute("aria-pressed", "true");
  });

  it("closes on Escape from inside, and on its Close button", () => {
    const dock = dockState();
    render(<CanvasDock {...base} dock={dock} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Draft" }), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close Dock" }));
    expect(dock.close).toHaveBeenCalledTimes(2);
  });

  describe("Code (LOT2-229)", () => {
    it("has a rail item that shows Code, on the board's folder and the file it was asked to open", () => {
      const dock = dockState();
      const { rerender } = render(<CanvasDock {...base} boardFolder="/repo" dock={dock} />);
      fireEvent.click(screen.getByRole("button", { name: "Code" }));
      expect(dock.show).toHaveBeenCalledWith("code");
      rerender(
        <CanvasDock {...base} boardFolder="/repo" dock={dockState({ app: "code", code: { request: { path: "/repo/a.ts", seq: 1 } } })} />,
      );
      expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("code-app")).toHaveAttribute("data-root", "/repo");
      expect(screen.getByTestId("code-app")).toHaveAttribute("data-open", "/repo/a.ts");
    });

    it("Escape closes Monaco's open widget first, and the Dock only when nothing in the editor is open", () => {
      const dock = dockState({ app: "code", code: { request: null } });
      render(<CanvasDock {...base} dock={dock} />);
      const input = screen.getByRole("textbox", { name: "Editor input" });
      const widget = screen.getByTestId("find-widget");
      widget.classList.add("visible");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(dock.close).not.toHaveBeenCalled();
      widget.classList.remove("visible");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(dock.close).toHaveBeenCalledTimes(1);
    });
  });

  it("badges the Automation rail item with what waits", () => {
    render(<CanvasDock {...base} dock={dockState({ waiting: [{ app: "automation", label: "Automation", count: 4 }], waitingTotal: 4 })} />);
    expect(screen.getByRole("button", { name: "Automation, 4 waiting" })).toHaveTextContent("4");
  });

  it("hosts Factory from its rail item, badged with the runs that need you", () => {
    const dock = dockState({ waiting: [{ app: "factory", label: "Factory", count: 2 }], waitingTotal: 2 });
    const { rerender } = render(<CanvasDock {...base} dock={dock} />);
    fireEvent.click(screen.getByRole("button", { name: "Factory, 2 waiting" }));
    expect(dock.show).toHaveBeenCalledWith("factory");
    rerender(<CanvasDock {...base} dock={dockState({ app: "factory", factory: { ...dock.factory, focusKey: "o/r#6" } })} />);
    expect(screen.getByTestId("factory-surface")).toHaveTextContent("o/r#6");
  });

  it("gives Factory the board's ticket sources, so Settings and New run see the repos Tasks has", () => {
    const dock = dockState({ app: "factory" });
    render(<CanvasDock {...base} dock={dock} />);
    const surface = screen.getByTestId("factory-surface");
    expect(surface).toHaveAttribute("data-new-run-repos", "1");
    expect(surface).toHaveAttribute("data-agent-repos", "1");
    expect(factorySources).toHaveBeenCalledWith(sharedBoard, expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "factory open tasks" }));
    expect(dock.show).toHaveBeenCalledWith("tasks");
    expect(screen.queryByTestId("automation-panel")).toBeNull();
  });

  it("Fleet's rail item switches the Dock to Fleet, without leaving the Dock", () => {
    const dock = dockState();
    render(<CanvasDock {...base} dock={dock} />);
    const item = screen.getByRole("button", { name: "Fleet" });
    expect(item).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(item);
    expect(dock.show).toHaveBeenCalledWith("fleet");
    expect(dock.close).not.toHaveBeenCalled();
  });

  it("lists the board's cells in the Fleet app, and a row press flies to that node", () => {
    const onFocusNode = vi.fn();
    const nodes = [{ id: "t1", type: "terminal", position: { x: 0, y: 0 }, data: { label: "build-server", cwd: "/r" } }] as Node[];
    const { container } = render(<CanvasDock {...base} fleet={{ ...fleet, nodes, onFocusNode }} dock={dockState({ app: "fleet" })} />);
    expect(screen.queryByTestId("automation-panel")).toBeNull();
    expect(screen.getByRole("button", { name: "Fleet" })).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".canvas-dock-fleet")).toHaveTextContent("build-server");
    const row = container.querySelector<HTMLElement>(".canvas-dock-fleet .canvas-fleet-focus");
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    expect(onFocusNode).toHaveBeenCalledWith("t1", expect.anything());
  });

  it("widens with the rail's last button and marks the wide state", () => {
    const dock = dockState({ wide: true });
    render(<CanvasDock {...base} dock={dock} />);
    expect(screen.getByRole("complementary", { name: "Dock" })).toHaveAttribute("data-wide", "true");
    fireEvent.click(screen.getByRole("button", { name: "Narrow the Dock" }));
    expect(dock.toggleWide).toHaveBeenCalledOnce();
  });

  it("gives focus back to where it was when it closes", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const { rerender } = render(<CanvasDock {...base} dock={dockState()} />);
    screen.getByRole("button", { name: "Automation" }).focus();
    rerender(<CanvasDock {...base} dock={dockState({ open: false })} />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  describe("one Needs-you queue (S5)", () => {
    const factoryAsk = { id: "factory:r1", source: "factory" as const, name: "#42 Fix login", line: "Answer 2 questions", askedAtMs: 0, onOpen: vi.fn() };
    const automationAsk = { id: "automation:d1", source: "automation" as const, name: "PR #7", line: "Review ready to send", askedAtMs: 0, onOpen: vi.fn() };

    it("lists Factory runs and waiting agents in Automation's Inbox, not its own rows", () => {
      const registry = createAgentStatusRegistry();
      registry.publish({ id: "n1", name: "Rex", status: "needs-you" });
      const close = vi.fn();
      const onFocusNode = vi.fn();
      render(<CanvasDock {...base} fleet={{ ...fleet, registry, onFocusNode }} dock={dockState({ asks: [factoryAsk, automationAsk], close })} />);
      expect(screen.queryByRole("button", { name: /elsewhere Automation/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "elsewhere Factory #42 Fix login" }));
      expect(factoryAsk.onOpen).toHaveBeenCalled();
      // An agent's terminal can sit behind the Dock: its row steps the Dock aside first.
      fireEvent.click(screen.getByRole("button", { name: "elsewhere Agent Rex" }));
      expect(close).toHaveBeenCalled();
      expect(onFocusNode).toHaveBeenCalledWith("n1");
    });

    it("puts the Dock apps' asks in Fleet's lane, each opening where it is answered", () => {
      render(<CanvasDock {...base} fleet={{ ...fleet, registry: createAgentStatusRegistry() }} dock={dockState({ app: "fleet", asks: [automationAsk] })} />);
      const lane = screen.getByTestId("needs-you-lane");
      expect(lane).toHaveAccessibleName("Needs you — 1 waiting");
      fireEvent.click(screen.getByRole("button", { name: /^Open PR #7 in Automation/ }));
      expect(automationAsk.onOpen).toHaveBeenCalled();
    });
  });

  describe("Tasks (S4)", () => {
    it("hosts the shared board's Tasks, polled while it shows, with Delegate saying it is not ready", () => {
      const showFactoryRun = vi.fn();
      const { unmount } = render(<CanvasDock {...base} dock={dockState({ app: "tasks", showFactoryRun, tasks: { focus: { id: "t1", seq: 1 } }, waiting: [{ app: "tasks", label: "Tasks", count: 2 }] })} />);
      expect(screen.getByRole("button", { name: "Tasks, 2 in review" })).toHaveAttribute("aria-pressed", "true");
      const surface = screen.getByTestId("tasks-surface");
      expect(surface).toHaveAttribute("data-open", "t1");
      expect(surface).toHaveAttribute("data-spawner", "null");
      expect(surface).toHaveTextContent("Delegating from the canvas is not ready yet");
      expect(sharedBoard.setViewing).toHaveBeenCalledWith("canvas-dock", true);
      fireEvent.click(screen.getByRole("button", { name: "open run" }));
      expect(showFactoryRun).toHaveBeenCalledWith("o/r", 42);
      unmount();
      expect(sharedBoard.setViewing).toHaveBeenLastCalledWith("canvas-dock", false);
    });

    it("delegates through the canvas spawner when the page gives one (S4b)", () => {
      const taskSpawner = { addPane: vi.fn() };
      render(<CanvasDock {...base} taskSpawner={taskSpawner} boardFolder="/x/flow-trader" dock={dockState({ app: "tasks" })} />);
      const surface = screen.getByTestId("tasks-surface");
      // A ticket goes to the workspace in the board's folder unless another is picked.
      expect(surface).toHaveAttribute("data-folder", "/x/flow-trader");
      expect(surface).toHaveAttribute("data-spawner", "[object Object]");
      expect(surface).not.toHaveTextContent("not ready");
    });

    it("marks a task with a node on this board, and its mark steps the Dock aside to centre it (board 18)", () => {
      const close = vi.fn();
      const reveal = vi.fn();
      render(<CanvasDock {...base} canvasTasks={{ nodes: new Map([["t9", "node-9"]]), reveal }} dock={dockState({ app: "tasks", close })} />);
      fireEvent.click(screen.getByRole("button", { name: "on canvas t9" }));
      expect(close).toHaveBeenCalled();
      expect(reveal).toHaveBeenCalledWith("node-9");
    });

    it("a row's live badge steps the Dock aside and centres its agent's terminal (LOT2-220)", () => {
      const close = vi.fn();
      const reveal = vi.fn();
      render(<CanvasDock {...base} canvasTasks={{ nodes: new Map(), panes: new Map([["pane-3", "term-3"]]), reveal }} dock={dockState({ app: "tasks", close })} />);
      fireEvent.click(screen.getByRole("button", { name: "show agent pane-3" }));
      expect(close).toHaveBeenCalled();
      expect(reveal).toHaveBeenCalledWith("term-3");
    });
  });
});
