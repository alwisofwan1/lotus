import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import {
  GITHUB_CAPABILITIES,
  GITHUB_ISSUE_VOCABULARY,
  type GitHubIssue,
  type GitHubIssueComment,
} from "@/modules/tasks/services/github-issues-source";
import { GITHUB_ISSUE_WRITE_DENY_RULES, namesakeCheckoutNote } from "@/modules/tasks/services/github-delegation";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";
import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";
import type { FactoryRunClient } from "@/modules/factory";

/** Delegating a GitHub issue (LOT2-101): the task it becomes, the one it reuses, and what the agent is denied. */

const delegate = vi.fn(async () => null);
/** The workspace each render handed `useDelegation` — the mock is ready either way, so this is checked by hand. */
const workspaceIds: (string | null)[] = [];
const claude = { id: "c", name: "Alwi", agent: "claude", args: "", instructions: "" };
vi.mock("@/modules/tasks/hooks/useDelegation", () => ({
  DENY_NEEDS_CLAUDE: "",
  useDelegation: (workspaceId: string | null) => (workspaceIds.push(workspaceId), {
    presets: [claude],
    ready: true,
    delegate,
    savePreset: vi.fn(),
    updatePreset: vi.fn(),
    removePreset: vi.fn(),
    resume: vi.fn(),
    inFlight: new Set(),
  }),
}));

const SOURCE = "github-initech-lotus";
const lotus: TrackerProject = { id: "ws-1", name: "Workspace 3", prefix: "W3", vocabulary: LOTUS_VOCABULARY };
const repo: TrackerProject = {
  id: SOURCE,
  name: "initech/lotus",
  prefix: "",
  vocabulary: GITHUB_ISSUE_VOCABULARY,
  capabilities: GITHUB_CAPABILITIES,
  source: { kind: "github", syncLine: "GitHub · synced" },
};
const issue: GitHubIssue = {
  number: 42,
  title: "Run Node loses its gate",
  state: "open",
  state_reason: null,
  labels: [],
  assignees: [],
  author: "teammate",
  url: "https://github.com/initech/lotus/issues/42",
  body: "Steps",
  comments: 1,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-02T10:00:00Z",
  closed_at: null,
};
const comment: GitHubIssueComment = { id: 9, author: "reviewer", body: "Seen it twice.", created_at: "2026-09-03T10:00:00Z", url: "" };
const issueRow: TrackerTask = {
  id: "42", projectId: SOURCE, number: 42, title: issue.title, status: "open" as TrackerTask["status"], priority: "none", createdAt: 1, updatedAt: 1,
};
const earlier: TrackerTask = {
  id: "task_9", projectId: lotus.id, number: 5, title: "#42 — Run Node loses its gate", status: "in-progress",
  priority: "none", createdAt: 1, updatedAt: 1, sourceRef: "initech/lotus#42",
};
const made = { id: "task_new", workspaceId: lotus.id } as unknown as BridgeTask;
const reopened = { id: "task_9", workspaceId: lotus.id } as unknown as BridgeTask;

function board(tasks: TrackerTask[]): TrackerBoard {
  return {
    projects: [lotus, repo],
    projectsById: new Map([[lotus.id, lotus], [repo.id, repo]]),
    tasks,
    loading: false,
    error: null,
    refresh: vi.fn(),
    createFromTicket: vi.fn(async () => made),
    createTask: vi.fn(async () => null),
    editTask: vi.fn(async () => null),
    openTask: vi.fn(async (projectId: string) =>
      projectId === SOURCE ? { kind: "github" as const, projectId, issue } : { kind: "task" as const, task: reopened },
    ),
  } as unknown as TrackerBoard;
}

function factoryClient(): FactoryRunClient {
  return {
    findCheckout: vi.fn(async () => ({ workspaceId: "ws-1", cwd: "/code/lotus" })),
    listRuns: vi.fn(async () => []),
    start: vi.fn(async () => "r1"),
    raiseCap: vi.fn(async () => 1),
    abort: vi.fn(async () => {}),
    onChanged: vi.fn(async () => () => {}),
  };
}

function renderSurface(b: TrackerBoard, factory: FactoryRunClient = factoryClient(), onOpenFactoryRun?: (repo: string, issue: number | string) => void) {
  render(
    <TasksSurface
      vault={{
        path: "", connect: vi.fn(), disconnect: vi.fn(),
        sources: [{ id: SOURCE, kind: "github", account: "alwi", repo: "initech/lotus", name: "initech/lotus" }],
      }}
      spawner={{ addPane: () => "pane_1", workspaces: () => [{ id: "ws-1", cwd: "/code", remote: false }, { id: "ws-2", cwd: "/far", remote: true }] }}
      activities={new Map()}
      board={b}
      layout={DEFAULT_LAYOUT}
      onLayoutChange={vi.fn()}
      onClose={vi.fn()}
      githubClient={{ listRepos: vi.fn(), forget: vi.fn(), readIssue: vi.fn(async () => ({ issue, comments: [comment] })) }}
      factoryClient={factory}
      onOpenFactoryRun={onOpenFactoryRun}
    />,
  );
}

async function delegateIssue() {
  fireEvent.click(screen.getByRole("button", { name: issue.title }));
  await screen.findByRole("region", { name: "Comments" });
  const props = screen.getByRole("complementary", { name: "Properties" });
  fireEvent.click(within(props).getByRole("button", { name: /^Alwi/, hidden: true }));
  await waitFor(() => expect(delegate).toHaveBeenCalled());
}

describe("delegating a GitHub issue", () => {
  beforeEach(() => {
    delegate.mockClear();
    workspaceIds.length = 0;
  });

  it("makes a task alongside the issue and denies the agent the issue writes", async () => {
    const b = board([issueRow]);
    renderSurface(b);
    await delegateIssue();

    expect(b.createFromTicket).toHaveBeenCalledTimes(1);
    const [projectId, draft] = (b.createFromTicket as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(projectId).toBe(lotus.id);
    expect(draft.title).toBe("#42 — Run Node loses its gate");
    expect(draft.source).toEqual({ kind: "github", ref: "initech/lotus#42", label: "#42" });
    expect(draft.knowledge).toContain("Seen it twice.");
    expect(delegate).toHaveBeenCalledWith(made, claude, "#42", { denyTools: GITHUB_ISSUE_WRITE_DENY_RULES });
    // An issue belongs to no workspace: the agent goes to the one chosen, not nowhere.
    expect(workspaceIds.at(-1)).toBe(lotus.id);
  });

  it("refuses, rather than guess, when the repo cannot be told", async () => {
    const b = board([issueRow]);
    render(
      <TasksSurface
        vault={{ path: "", connect: vi.fn(), disconnect: vi.fn(), sources: [] }}
        spawner={{ addPane: () => "pane_1" }}
        activities={new Map()}
        board={b}
        layout={DEFAULT_LAYOUT}
        onLayoutChange={vi.fn()}
        onClose={vi.fn()}
        githubClient={{
          listRepos: vi.fn(),
          forget: vi.fn(),
          readIssue: vi.fn(async () => ({ issue: { ...issue, url: "https://ghe.example.com/o/r/issues/42" }, comments: [] })),
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: issue.title }));
    await screen.findByRole("region", { name: "Comments" });
    const props = screen.getByRole("complementary", { name: "Properties" });
    fireEvent.click(within(props).getByRole("button", { name: /^Alwi/, hidden: true }));
    expect(await screen.findByText(/repo this issue belongs to/)).toBeTruthy();
    expect(b.createFromTicket).not.toHaveBeenCalled();
    expect(delegate).not.toHaveBeenCalled();
  });

  it("joins the open task already made from the same owner/name#42", async () => {
    const b = board([issueRow, earlier]);
    renderSurface(b);
    await delegateIssue();

    expect(b.openTask).toHaveBeenCalledWith(lotus.id, "task_9");
    expect(b.createFromTicket).not.toHaveBeenCalled();
    expect(delegate).toHaveBeenCalledWith(reopened, claude, "#42", { denyTools: GITHUB_ISSUE_WRITE_DENY_RULES });
  });
});

describe("a GitHub issue's default target is its checkout", () => {
  beforeEach(() => {
    delegate.mockClear();
    workspaceIds.length = 0;
  });

  // Measured 2026-10-17: `donisapu/e-coursetradding#18` went to the rail's first workspace while its
  // checkout was `clients/flow-trader`. The checkout can be a repo inside a parent workspace.
  it("delegates to the workspace holding the repo, in the repo's folder", async () => {
    const flow: TrackerProject = { id: "ws-3", name: "Clients", prefix: "CL", vocabulary: LOTUS_VOCABULARY };
    const b = board([issueRow]);
    (b as { projects: TrackerProject[] }).projects = [lotus, flow, repo];
    (b as { projectsById: Map<string, TrackerProject> }).projectsById = new Map([[lotus.id, lotus], [flow.id, flow], [repo.id, repo]]);
    const findCheckout = vi.fn(async () => ({ workspaceId: "ws-3", cwd: "/clients/flow-trader" }));
    render(
      <TasksSurface
        vault={{
          path: "", connect: vi.fn(), disconnect: vi.fn(),
          sources: [{ id: SOURCE, kind: "github", account: "alwi", repo: "initech/lotus", name: "initech/lotus" }],
        }}
        spawner={{
          addPane: () => "pane_1",
          workspaces: () => [{ id: "ws-1", cwd: "/code", remote: false }, { id: "ws-2", cwd: "/far", remote: true }, { id: "ws-3", cwd: "/clients", remote: false }],
        }}
        activities={new Map()}
        board={b}
        layout={DEFAULT_LAYOUT}
        onLayoutChange={vi.fn()}
        onClose={vi.fn()}
        githubClient={{ listRepos: vi.fn(), forget: vi.fn(), readIssue: vi.fn(async () => ({ issue, comments: [comment] })) }}
        factoryClient={factoryClient()}
        findCheckout={findCheckout}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: issue.title }));
    await screen.findByRole("region", { name: "Comments" });
    expect(findCheckout).toHaveBeenCalledWith("initech/lotus", [{ id: "ws-1", cwd: "/code" }, { id: "ws-3", cwd: "/clients" }], null, { namesake: true });
    await waitFor(() => expect(workspaceIds.at(-1)).toBe("ws-3"));
    const props = screen.getByRole("complementary", { name: "Properties" });
    fireEvent.click(within(props).getByRole("button", { name: /^Alwi/, hidden: true }));
    await waitFor(() => expect(delegate).toHaveBeenCalled());

    expect((b.createFromTicket as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("ws-3");
    expect(delegate).toHaveBeenCalledWith(made, claude, "#42", { denyTools: GITHUB_ISSUE_WRITE_DENY_RULES, cwd: "/clients/flow-trader" });
  });
});

describe("delegating into a namesake clone of the issue's repo", () => {
  beforeEach(() => {
    delegate.mockClear();
  });

  // `donisapu/e-coursetradding#18` defaults to `flow-trader`, a clone of `mapantekno/…`. Pushing stays
  // allowed (the person chose that, 2026-10-17); the agent is told where a push would go.
  const findCheckout = vi.fn(async () => ({ workspaceId: "ws-1", cwd: "/code/lotus", namesake: "someone/lotus" }));
  const surface = (b: TrackerBoard) =>
    render(
      <TasksSurface
        vault={{
          path: "", connect: vi.fn(), disconnect: vi.fn(),
          sources: [{ id: SOURCE, kind: "github", account: "alwi", repo: "initech/lotus", name: "initech/lotus" }],
        }}
        spawner={{ addPane: () => "pane_1", workspaces: () => [{ id: "ws-1", cwd: "/code", remote: false }] }}
        activities={new Map()}
        board={b}
        layout={DEFAULT_LAYOUT}
        onLayoutChange={vi.fn()}
        onClose={vi.fn()}
        githubClient={{ listRepos: vi.fn(), forget: vi.fn(), readIssue: vi.fn(async () => ({ issue, comments: [comment] })) }}
        factoryClient={factoryClient()}
        findCheckout={findCheckout}
      />,
    );
  const note = namesakeCheckoutNote("initech/lotus", "someone/lotus");

  it("says so to the agent, and denies it nothing more than the issue writes", async () => {
    surface(board([issueRow]));
    await delegateIssue();
    expect(delegate).toHaveBeenCalledWith(made, claude, "#42", { denyTools: GITHUB_ISSUE_WRITE_DENY_RULES, cwd: "/code/lotus", note });
  });

  it("says so again when the issue's task is delegated from its own row", async () => {
    const fromIssue = {
      ...reopened, title: earlier.title, goal: "Steps", knowledge: "", status: "in-progress", priority: "none", createdAt: 1, updatedAt: 1,
      source: { kind: "github", ref: "initech/lotus#42", label: "#42" },
    } as unknown as BridgeTask;
    const b = board([earlier]);
    (b as { openTask: unknown }).openTask = vi.fn(async () => ({ kind: "task" as const, task: fromIssue }));
    surface(b);
    fireEvent.click(screen.getByRole("button", { name: earlier.title }));
    const props = await screen.findByRole("complementary", { name: "Properties" });
    fireEvent.click(within(props).getByRole("button", { name: /^Alwi/, hidden: true }));
    await waitFor(() => expect(delegate).toHaveBeenCalled());
    expect(findCheckout).toHaveBeenLastCalledWith("initech/lotus", [{ id: "ws-1", cwd: "/code" }], "ws-1", { namesake: true });
    expect(delegate).toHaveBeenCalledWith(fromIssue, claude, null, { denyTools: GITHUB_ISSUE_WRITE_DENY_RULES, note });
  });
});

describe("running a GitHub issue as a Factory Run", () => {
  it("starts it with the source's repo and account, from the checkout a local workspace holds", async () => {
    const factory = factoryClient();
    renderSurface(board([issueRow]), factory);
    fireEvent.click(screen.getByRole("button", { name: issue.title }));
    await screen.findByRole("region", { name: "Comments" });
    const props = screen.getByRole("complementary", { name: "Properties" });
    const run = await within(props).findByRole("button", { name: "Run in Factory" });
    await waitFor(() => expect(run).toBeEnabled());
    expect(factory.findCheckout).toHaveBeenCalledWith("initech/lotus", [{ id: "ws-1", cwd: "/code" }], null);
    fireEvent.click(run);
    await waitFor(() => expect(factory.start).toHaveBeenCalled());
    const [input] = (factory.start as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(input.factory).toMatchObject({ repo: "initech/lotus", issue: 42, account: "alwi", checkout: "/code/lotus", implementer: "c" });
  });

  it("opens an issue's run in the Factory, by repo and issue", async () => {
    const factory = factoryClient();
    (factory.listRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "r1",
        projectId: "cp",
        workflowId: "factory:initech/lotus#42",
        status: "running",
        checkpoint: { nodeIds: ["factory:initech/lotus#42"], deps: [], completed: {}, failed: [], pending: [], blocked: [], engine: { kind: "rust", budgetCap: 2 } },
        startedAt: 1,
        endedAt: null,
        updatedAt: 1,
      },
    ]);
    const onOpenFactoryRun = vi.fn();
    renderSurface(board([issueRow]), factory, onOpenFactoryRun);
    fireEvent.click(screen.getByRole("button", { name: issue.title }));
    await screen.findByRole("region", { name: "Comments" });
    const props = screen.getByRole("complementary", { name: "Properties" });
    fireEvent.click(await within(props).findByRole("button", { name: /Open in Factory/ }));
    expect(onOpenFactoryRun).toHaveBeenCalledWith("initech/lotus", 42);
  });
});
