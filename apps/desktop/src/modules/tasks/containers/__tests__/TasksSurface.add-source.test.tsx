import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject } from "@/modules/tasks/types";
import { GITHUB_CAPABILITIES, GITHUB_ISSUE_VOCABULARY } from "@/modules/tasks/services/github-issues-source";

/**
 * Adding a ticket source from the tracker's nav: "Add ticket source" opens the kind picker, and
 * picking Obsidian opens the vault's folder form in the nav, where the vault will live.
 */

const project: TrackerProject = { id: "ws-1", name: "Lotus", prefix: "LOT", vocabulary: LOTUS_VOCABULARY };

function board(): TrackerBoard {
  return {
    projects: [project],
    projectsById: new Map([[project.id, project]]),
    tasks: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    createFromTicket: vi.fn(async () => null),
    createTask: vi.fn(async () => null),
    editTask: vi.fn(async () => null),
    openTask: vi.fn(async () => null),
  };
}

function renderSurface(path = "") {
  render(
    <TasksSurface vault={{ path, connect: vi.fn(), disconnect: vi.fn() }} spawner={null} activities={new Map()}
      board={board()} layout={DEFAULT_LAYOUT} onLayoutChange={vi.fn()} onClose={vi.fn()} />,
  );
  return within(screen.getByRole("navigation", { name: "Tasks navigation" }));
}

describe("adding a ticket source", () => {
  it("opens the kind picker, and picking Obsidian opens the vault's folder form in the nav", () => {
    const nav = renderSurface();
    expect(nav.queryByLabelText("Vault folder")).toBeNull();

    fireEvent.click(nav.getByRole("button", { name: "Add ticket source" }));
    const dialog = screen.getByRole("dialog", { name: "Add a ticket source" });

    fireEvent.click(within(dialog).getByRole("button", { name: /Obsidian vault/ }));

    expect(screen.queryByRole("dialog", { name: "Add a ticket source" })).toBeNull();
    expect(nav.getByLabelText("Vault folder")).toBeTruthy();
  });

  it("Escape closes the picker without closing Tasks", () => {
    const nav = renderSurface();
    fireEvent.click(nav.getByRole("button", { name: "Add ticket source" }));

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Add a ticket source" }), { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Add a ticket source" })).toBeNull();
  });
});

describe("adding a GitHub repo", () => {
  const repoProject: TrackerProject = {
    id: "github-cli-cli",
    name: "cli/cli",
    prefix: "",
    vocabulary: GITHUB_ISSUE_VOCABULARY,
    capabilities: GITHUB_CAPABILITIES,
    source: { kind: "github", syncLine: "GitHub · synced 09:30" },
  };

  function renderGitHub({
    accounts = [{ login: "alwisofwan1", active: true }],
    projects = [project],
  }: { accounts?: { login: string; active: boolean }[]; projects?: TrackerProject[] } = {}) {
    const addGitHubSource = vi.fn();
    const removeSource = vi.fn();
    const onOpenConnectors = vi.fn();
    const github = {
      listRepos: vi.fn(async () => [{ full_name: "cli/cli", description: "", private: false, archived: false, has_issues: true, pushed_at: null }]),
      forget: vi.fn(async () => undefined),
      readIssue: vi.fn(async () => ({ issue: null, comments: [] })),
    };
    const tracker = { ...board(), projects, projectsById: new Map(projects.map((p) => [p.id, p])) };
    render(
      <TasksSurface
        vault={{ path: "", connect: vi.fn(), disconnect: vi.fn(), addGitHubSource, removeSource, sources: [] }}
        spawner={null}
        activities={new Map()}
        board={tracker}
        layout={DEFAULT_LAYOUT}
        onLayoutChange={vi.fn()}
        onClose={vi.fn()}
        githubClient={github}
        ghAccounts={accounts}
        onOpenConnectors={onOpenConnectors}
      />,
    );
    const nav = within(screen.getByRole("navigation", { name: "Tasks navigation" }));
    return { nav, addGitHubSource, removeSource, onOpenConnectors, github };
  }

  it("picks GitHub, then a repo, and writes the source as the gh account", async () => {
    const { nav, addGitHubSource } = renderGitHub();
    fireEvent.click(nav.getByRole("button", { name: "Add ticket source" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add a ticket source" })).getByRole("button", { name: /GitHub Issues/ }));

    const sheet = within(screen.getByRole("dialog", { name: "Add a GitHub repo" }));
    fireEvent.click(await sheet.findByRole("option", { name: /cli\/cli/ }));
    fireEvent.click(sheet.getByRole("button", { name: "Add cli/cli" }));

    expect(addGitHubSource).toHaveBeenCalledWith({ id: "github-cli-cli", kind: "github", account: "alwisofwan1", repo: "cli/cli", name: "cli/cli" });
    expect(screen.queryByRole("dialog", { name: "Add a GitHub repo" })).toBeNull();
  });

  it("with no gh login, the GitHub row opens Connectors", () => {
    const { nav, onOpenConnectors } = renderGitHub({ accounts: [] });
    fireEvent.click(nav.getByRole("button", { name: "Add ticket source" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add a ticket source" })).getByRole("button", { name: /GitHub Issues/ }));

    expect(onOpenConnectors).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Add a GitHub repo" })).toBeNull();
  });

  it("removes a repo from its own view, and its kept copy", async () => {
    const { nav, removeSource, github } = renderGitHub({ projects: [project, repoProject] });
    fireEvent.click(nav.getByRole("button", { name: /cli\/cli/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove source" }));

    expect(removeSource).toHaveBeenCalledWith("github-cli-cli");
    await waitFor(() => expect(github.forget).toHaveBeenCalledWith("github-cli-cli"));
  });
});
