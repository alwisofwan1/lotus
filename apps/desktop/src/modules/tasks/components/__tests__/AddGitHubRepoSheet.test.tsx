import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddGitHubRepoSheet } from "@/modules/tasks/components/AddGitHubRepoSheet";
import type { GitHubRepoSummary } from "@/modules/tasks/services/github-issues-source";

function repo(full_name: string, over: Partial<GitHubRepoSummary> = {}): GitHubRepoSummary {
  return { full_name, description: "", private: false, archived: false, has_issues: true, pushed_at: null, ...over };
}

const ACCOUNTS = [
  { login: "alwisofwan1", active: true },
  { login: "work-login", active: false },
];

function client(byAccount: Record<string, GitHubRepoSummary[]>) {
  return { listRepos: vi.fn(async (account: string) => byAccount[account] ?? []) };
}

const option = (name: RegExp) => screen.getByRole("option", { name });
const addButton = () => screen.getByRole("button", { name: /^Add / }) as HTMLButtonElement;

describe("Add a GitHub repo", () => {
  it("lists the active account's repos, filters them, and adds the picked one as that account", async () => {
    const github = client({ alwisofwan1: [repo("initech/lotus"), repo("alwisofwan1/notes", { private: true })] });
    const onAdd = vi.fn();
    render(<AddGitHubRepoSheet accounts={ACCOUNTS} client={github} isAdded={() => false} onAdd={onAdd} onClose={vi.fn()} />);

    await waitFor(() => expect(option(/initech\/lotus/)).toBeTruthy());
    expect(github.listRepos).toHaveBeenCalledWith("alwisofwan1");
    expect(option(/alwisofwan1\/notes/).textContent).toContain("Private");

    fireEvent.change(screen.getByLabelText(/Search repositories/), { target: { value: "LOTUS" } });
    expect(screen.queryByRole("option", { name: /notes/ })).toBeNull();

    expect(addButton().disabled).toBe(true);
    fireEvent.click(option(/initech\/lotus/));
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledWith({
      id: "github-initech-lotus",
      kind: "github",
      account: "alwisofwan1",
      repo: "initech/lotus",
      name: "initech/lotus",
    });
  });

  it("reads the other account's repos when it is chosen, and adds as that account", async () => {
    const github = client({ alwisofwan1: [repo("initech/lotus")], "work-login": [repo("acme/api")] });
    const onAdd = vi.fn();
    render(<AddGitHubRepoSheet accounts={ACCOUNTS} client={github} isAdded={() => false} onAdd={onAdd} onClose={vi.fn()} />);
    await waitFor(() => expect(option(/initech\/lotus/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("GitHub account"), { target: { value: "work-login" } });
    await waitFor(() => expect(option(/acme\/api/)).toBeTruthy());
    expect(screen.queryByRole("option", { name: /initech/ })).toBeNull();

    fireEvent.click(option(/acme\/api/));
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ account: "work-login", repo: "acme/api" }));
  });

  it("adds a repo typed as owner/name that the list does not hold", async () => {
    const github = client({ alwisofwan1: [] });
    const onAdd = vi.fn();
    render(<AddGitHubRepoSheet accounts={ACCOUNTS.slice(0, 1)} client={github} isAdded={() => false} onAdd={onAdd} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/No repository matches/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/Search repositories/), { target: { value: "cli/cli" } });
    expect(option(/cli\/cli/).textContent).toContain("Typed");
    fireEvent.click(option(/cli\/cli/));
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: "github-cli-cli", repo: "cli/cli" }));

    // Not a repo name: nothing to pick.
    fireEvent.change(screen.getByLabelText(/Search repositories/), { target: { value: "cli; rm -rf" } });
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("refuses a repo that is already a source", async () => {
    const github = client({ alwisofwan1: [repo("cli/cli")] });
    const onAdd = vi.fn();
    render(
      <AddGitHubRepoSheet
        accounts={ACCOUNTS}
        client={github}
        isAdded={(name) => name.toLowerCase() === "cli/cli"}
        onAdd={onAdd}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(option(/cli\/cli/).textContent).toContain("Added"));

    fireEvent.click(option(/cli\/cli/));
    expect(screen.getByText("This repo is already a ticket source.")).toBeTruthy();
    expect(addButton().disabled).toBe(true);
    fireEvent.click(addButton());
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("says why when the repos cannot be read", async () => {
    const github = { listRepos: vi.fn(async () => Promise.reject(new Error("gh is not logged in"))) };
    render(<AddGitHubRepoSheet accounts={ACCOUNTS} client={github} isAdded={() => false} onAdd={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("gh is not logged in"));
  });
});
