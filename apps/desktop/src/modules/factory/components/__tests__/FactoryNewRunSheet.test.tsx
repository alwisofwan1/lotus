import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FactoryNewRunSheet } from "@/modules/factory/components/FactoryNewRunSheet";
import type { FactoryNewRunSource } from "@/modules/factory/services/factory-new-run";

function source(over: Partial<FactoryNewRunSource> = {}): FactoryNewRunSource {
  return {
    repos: [
      { id: "s1", repo: "o/r", account: "me", name: "o/r" },
      { id: "s2", repo: "o/other", account: "me", name: "o/other" },
    ],
    issues: (id) =>
      id === "s1"
        ? [
            { number: 1, title: "Fix the login" },
            { number: 2, title: "Add a helper" },
            { number: 3, title: "Running already" },
          ]
        : [{ number: 9, title: "Other repo issue" }],
    presets: vi.fn(async () => [
      { id: "p1", name: "Claude opus" },
      { id: "p2", name: "Claude sonnet" },
    ]),
    start: vi.fn(async ({ issues }) => issues.map((issue: number) => ({ issue, error: null }))),
    ...over,
  };
}

const rows = [{ repo: "o/r", issue: 3, state: "running" as const }];
const issue = (n: number) => screen.getByRole("checkbox", { name: new RegExp(`#${n} `) });

describe("FactoryNewRunSheet", () => {
  it("lists the open issues of the first repo; a running one is greyed and cannot be ticked", async () => {
    render(<FactoryNewRunSheet source={source()} rows={rows} onClose={vi.fn()} />);
    expect(issue(1)).toBeEnabled();
    expect(issue(3)).toBeDisabled();
    expect(screen.getByText("already running")).toBeInTheDocument();
  });

  it("searches the issues", () => {
    render(<FactoryNewRunSheet source={source()} rows={rows} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search issues" }), { target: { value: "login" } });
    expect(within(screen.getByRole("list", { name: "Open issues" })).getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["#1 Fix the login"]);
  });

  it("switching the repo shows its issues and clears the ticks", () => {
    render(<FactoryNewRunSheet source={source()} rows={rows} onClose={vi.fn()} />);
    fireEvent.click(issue(1));
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "s2" } });
    expect(within(screen.getByRole("list", { name: "Open issues" })).getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["#9 Other repo issue"]);
    expect(screen.getByText("No ticket picked")).toBeInTheDocument();
  });

  it("the footer says how many runs and the most they cost; tries are fixed at 2", () => {
    render(<FactoryNewRunSheet source={source()} rows={rows} onClose={vi.fn()} />);
    fireEvent.click(issue(1));
    fireEvent.click(issue(2));
    expect(screen.getByText("2 runs · up to $4.00")).toBeInTheDocument();
    const cap = screen.getByRole("spinbutton", { name: "Cap per run (USD)" }) as HTMLInputElement;
    fireEvent.change(cap, { target: { value: "3" } });
    fireEvent.blur(cap);
    expect(screen.getByText("2 runs · up to $6.00")).toBeInTheDocument();
    expect(screen.getByText(/2 tries/)).toBeInTheDocument();
  });

  it("starts every ticked issue as the chosen preset and closes when all started", async () => {
    const src = source();
    const onClose = vi.fn();
    render(<FactoryNewRunSheet source={src} rows={rows} onClose={onClose} />);
    await waitFor(() => expect(screen.getByLabelText("Implementer")).toHaveValue("p1"));
    fireEvent.change(screen.getByLabelText("Implementer"), { target: { value: "p2" } });
    fireEvent.click(issue(2));
    fireEvent.click(issue(1));
    fireEvent.click(screen.getByRole("button", { name: "Start 2 runs" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(src.start).toHaveBeenCalledWith({ repo: src.repos[0], sourceId: "s1", issues: [1, 2], implementer: "p2", capUsd: 2 });
  });

  it("builds Notion tickets in the repo picked beside them, and remembers that repo per database", async () => {
    window.localStorage.removeItem("factory-notion-repo:n1");
    const src = source({
      notion: [{ id: "n1", name: "Sprint board" }],
      issues: (id) =>
        id === "n1"
          ? [
              { number: "TKT-12", title: "Export the report" },
              { number: "TKT-7", title: "Fix the badge" },
            ]
          : [{ number: 1, title: "Fix the login" }],
      start: vi.fn(async ({ issues }) => issues.map((issue: string) => ({ issue, error: null }))),
    });
    const onClose = vi.fn();
    render(<FactoryNewRunSheet source={src} rows={[{ repo: "o/other", issue: "TKT-7", state: "running" }]} onClose={onClose} />);
    await waitFor(() => expect(screen.getByLabelText("Implementer")).toHaveValue("p1"));
    fireEvent.change(screen.getByLabelText("Tickets from"), { target: { value: "n1" } });
    fireEvent.change(screen.getByLabelText("Code in"), { target: { value: "s2" } });
    expect(window.localStorage.getItem("factory-notion-repo:n1")).toBe("s2");
    // The same ticket running in that repo holds it.
    expect(screen.getByRole("checkbox", { name: /^TKT-7 / })).toBeDisabled();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tickets" }), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "TKT-12 Export the report" }));
    fireEvent.click(screen.getByRole("button", { name: "Start 1 run" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(src.start).toHaveBeenCalledWith({ repo: src.repos[1], sourceId: "n1", issues: ["TKT-12"], implementer: "p1", capUsd: 2 });
  });

  it("shows the issues that failed to start, keeps them ticked, and stays open", async () => {
    const src = source({
      start: vi.fn(async () => [
        { issue: 1, error: "MemberBusy" },
        { issue: 2, error: null },
      ]),
    });
    const onClose = vi.fn();
    render(<FactoryNewRunSheet source={src} rows={rows} onClose={onClose} />);
    await waitFor(() => expect(screen.getByLabelText("Implementer")).toHaveValue("p1"));
    fireEvent.click(issue(1));
    fireEvent.click(issue(2));
    fireEvent.click(screen.getByRole("button", { name: "Start 2 runs" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1 of 2 started");
    // The reason sits under the ticket it belongs to.
    expect(within(issue(1).closest("li")!).getByText("Did not start: MemberBusy")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(issue(1)).toBeChecked();
    expect(issue(2)).not.toBeChecked();
  });

  it("cannot start with nothing ticked, or with no preset", async () => {
    render(<FactoryNewRunSheet source={source({ presets: vi.fn(async () => []) })} rows={rows} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Start/ })).toBeDisabled();
    fireEvent.click(issue(1));
    expect(await screen.findByText(/Make a Claude preset first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start/ })).toBeDisabled();
  });

  it("the implementer starts at the Implement role's preset in Settings; a change is for this batch", async () => {
    const src = source({ defaultsOf: vi.fn(async () => ({ implementer: "p2", base: null })) });
    render(<FactoryNewRunSheet source={src} rows={rows} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Implementer")).toHaveValue("p2"));
    expect(src.defaultsOf).toHaveBeenCalledWith("o/r");
    expect(screen.getByText("from Settings")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Implementer"), { target: { value: "p1" } });
    expect(screen.getByText("this batch only")).toBeInTheDocument();
  });

  it("says which branch the PRs go into before the run starts (LOT2-192)", async () => {
    const defaultsOf = vi.fn(async (repo: string) =>
      repo === "o/r"
        ? { implementer: null, base: { name: "develop", fromFile: true } }
        : { implementer: null, base: { name: "main", fromFile: false } },
    );
    render(<FactoryNewRunSheet source={source({ defaultsOf })} rows={rows} onClose={vi.fn()} />);
    expect(await screen.findByText("PRs go into: develop (from .lotus/factory.toml)")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "s2" } });
    expect(await screen.findByText("PRs go into: main (the default branch)")).toBeInTheDocument();
  });

  it("Select all ticks every ticket that can start, and again clears them", () => {
    render(<FactoryNewRunSheet source={source()} rows={rows} onClose={vi.fn()} />);
    const all = screen.getByRole("checkbox", { name: "Select all 2" });
    fireEvent.click(all);
    expect([issue(1), issue(2), issue(3)].map((c) => (c as HTMLInputElement).checked)).toEqual([true, true, false]);
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(all);
    expect(issue(1)).not.toBeChecked();
  });

  it("closes with Escape", () => {
    const onClose = vi.fn();
    render(<FactoryNewRunSheet source={source()} rows={rows} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  describe("Workspace (Notion)", () => {
    const withWorkspaces = (over: Partial<FactoryNewRunSource> = {}) =>
      source({
        notion: [{ id: "n1", name: "Sprint board" }],
        workspaces: [
          { id: "w1", path: "/w/solo", name: "solo" },
          { id: "w2", path: "/w/meta", name: "meta" },
        ],
        inspectWorkspace: vi.fn(async (path: string) =>
          path === "/w/solo" ? { repo: { id: "s1", repo: "o/r", account: "me", name: "o/r" }, subRepos: [] } : { repo: null, subRepos: ["back", "front"] },
        ),
        issues: (id) => (id === "n1" ? [{ number: "TKT-1", title: "One" }, { number: "TKT-2", title: "Two" }] : []),
        start: vi.fn(async ({ issues }) => issues.map((issue: string) => ({ issue, error: null }))),
        ...over,
      });

    it("calls the picker Workspace, remembers it per database, and starts in that folder", async () => {
      window.localStorage.removeItem("factory-notion-workspace:n1");
      const src = withWorkspaces();
      const onClose = vi.fn();
      render(<FactoryNewRunSheet source={src} rows={[]} onClose={onClose} />);
      fireEvent.change(screen.getByLabelText("Tickets from"), { target: { value: "n1" } });
      fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "w1" } });
      expect(window.localStorage.getItem("factory-notion-workspace:n1")).toBe("w1");
      await waitFor(() => expect(screen.getByLabelText("Implementer")).toHaveValue("p1"));
      fireEvent.click(screen.getByRole("checkbox", { name: "TKT-1 One" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Start 1 run" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Start 1 run" }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(src.start).toHaveBeenCalledWith(expect.objectContaining({ workspace: "/w/solo", sourceId: "n1", issues: ["TKT-1"] }));
    });

    it("lists the sub-repos of the workspace", async () => {
      window.localStorage.setItem("factory-notion-workspace:n1", "w2");
      render(<FactoryNewRunSheet source={withWorkspaces()} rows={[]} onClose={vi.fn()} />);
      fireEvent.change(screen.getByLabelText("Tickets from"), { target: { value: "n1" } });
      expect(await screen.findByText("Sub-repos: back, front")).toBeInTheDocument();
    });

    it("a ticket running in any sub-repo of the workspace is held", async () => {
      window.localStorage.setItem("factory-notion-workspace:n1", "w2");
      const held = [{ repo: "o/back", issue: "TKT-2", state: "running" as const, ticket: { checkout: "/w/meta/back" } }];
      render(<FactoryNewRunSheet source={withWorkspaces()} rows={held} onClose={vi.fn()} />);
      fireEvent.change(screen.getByLabelText("Tickets from"), { target: { value: "n1" } });
      expect(screen.getByRole("checkbox", { name: "TKT-2 Two" })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: "TKT-1 One" })).toBeEnabled();
    });

    it("starts in a meta-repo workspace and tells triage picks the sub-repo (FM8)", async () => {
      window.localStorage.setItem("factory-notion-workspace:n1", "w2");
      const src = withWorkspaces({
        inspectWorkspace: vi.fn(async () => ({ repo: { id: "", repo: "meta", account: "me", name: "meta" }, subRepos: ["back", "front"], meta: true })),
      });
      render(<FactoryNewRunSheet source={src} rows={[]} onClose={vi.fn()} />);
      fireEvent.change(screen.getByLabelText("Tickets from"), { target: { value: "n1" } });
      expect(await screen.findByText(/triage picks the sub-repo/)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText("Implementer")).toHaveValue("p1"));
      fireEvent.click(screen.getByRole("checkbox", { name: "TKT-1 One" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Start 1 run" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Start 1 run" }));
      await waitFor(() => expect(src.start).toHaveBeenCalledWith(expect.objectContaining({ workspace: "/w/meta", meta: true })));
      // Triage picks the sub-repo mid-run: the run carries every connected source's account by repo.
      expect(src.start).toHaveBeenCalledWith(expect.objectContaining({ repoAccounts: { "o/r": "me", "o/other": "me" } }));
    });

    it("cannot start where no connected GitHub repo is the workspace itself", async () => {
      window.localStorage.setItem("factory-notion-workspace:n1", "w2");
      render(<FactoryNewRunSheet source={withWorkspaces()} rows={[]} onClose={vi.fn()} />);
      fireEvent.change(screen.getByLabelText("Tickets from"), { target: { value: "n1" } });
      await screen.findByText("Sub-repos: back, front");
      await waitFor(() => expect(screen.getByLabelText("Implementer")).toHaveValue("p1"));
      fireEvent.click(screen.getByRole("checkbox", { name: "TKT-1 One" }));
      expect(screen.getByRole("button", { name: "Start 1 run" })).toBeDisabled();
    });
  });
});
