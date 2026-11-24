import { describe, expect, it, vi } from "vitest";
import {
  createTauriGitHubIssuesClient,
  githubIssueKey,
  githubSourceId,
  issueStateLabel,
  toTrackerTaskFromIssue,
  type GitHubIssue,
  type InvokeFn,
} from "@/modules/tasks/services/github-issues-source";

const issue: GitHubIssue = {
  number: 42,
  title: "",
  state: "closed",
  state_reason: "not_planned",
  labels: [{ name: "bug", color: "d73a4a" }, { name: "ui", color: "000000" }],
  assignees: [],
  author: "teammate",
  url: "https://github.com/initech/lotus/issues/42",
  body: "",
  comments: 0,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "not a time",
  closed_at: "2026-10-01T10:00:00Z",
};

describe("GitHub issues as rows (ADR-0048)", () => {
  it("an issue is a row keyed by its number, in its state, with no key of its own", () => {
    const row = toTrackerTaskFromIssue(issue, "github-initech-lotus");
    expect(row).toEqual({
      id: "42",
      projectId: "github-initech-lotus",
      number: 42,
      title: "Untitled",
      status: "closed",
      priority: "none",
      createdAt: Date.parse("2026-09-01T10:00:00Z"),
      updatedAt: 0,
      assignees: [],
      labels: ["bug", "ui"],
    });
  });

  it("prints #123, and nothing for a row without a number", () => {
    expect(githubIssueKey(123)).toBe("#123");
    expect(githubIssueKey(undefined)).toBeNull();
    expect(githubIssueKey(0)).toBeNull();
  });

  it("an issue's state says why it was closed, when GitHub says why (PLAN G9)", () => {
    expect(issueStateLabel({ state: "open", state_reason: null })).toBe("Open");
    expect(issueStateLabel({ state: "open", state_reason: "reopened" })).toBe("Open");
    expect(issueStateLabel({ state: "closed", state_reason: "completed" })).toBe("Closed · completed");
    expect(issueStateLabel({ state: "closed", state_reason: "not_planned" })).toBe("Closed · not planned");
    expect(issueStateLabel({ state: "closed", state_reason: "duplicate" })).toBe("Closed · duplicate");
    expect(issueStateLabel({ state: "closed", state_reason: null })).toBe("Closed");
  });

  it("a repo's source id is derived from it, and fits a file name (PLAN G14)", () => {
    expect(githubSourceId("initech/lotus")).toBe("github-initech-lotus");
    expect(githubSourceId("a/b.c")).toBe("github-a-b_c");
    expect(githubSourceId(`a/${"x".repeat(100)}`)).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
  });

  it("the client calls the four Tauri commands, passing only the source id", async () => {
    const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<never>>();
    const client = createTauriGitHubIssuesClient(invoke as InvokeFn);
    await client.sync("github-x", { full: true });
    await client.readIssue("github-x", 7);
    await client.listRepos("alwisofwan1");
    await client.forget("github-x");
    expect(invoke.mock.calls).toEqual([
      ["github_issues_sync_source", { sourceId: "github-x", full: true }],
      ["github_issues_read_issue", { sourceId: "github-x", number: 7 }],
      ["github_issues_list_repos", { account: "alwisofwan1" }],
      ["github_issues_forget_source", { sourceId: "github-x" }],
    ]);
  });
});
