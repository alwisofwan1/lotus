import { describe, expect, it } from "vitest";
import {
  GH_ISSUE_WRITE_SUBCOMMANDS,
  GITHUB_ISSUE_WRITE_DENY_RULES,
  GITHUB_MCP_ISSUE_WRITE_TOOLS,
  githubIssueRef,
  taskDraftFromGitHubIssue,
} from "@/modules/tasks/services/github-delegation";
import { denyToolsArgs, startCommand, withDeniedTools, type DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import { TASK_GOAL_CAP, TASK_KNOWLEDGE_CAP, TASK_TITLE_CAP, utf8Length } from "@/modules/tasks/services/task-draft";
import type { GitHubIssue, GitHubIssueComment } from "@/modules/tasks/services/github-issues-source";

const issue: GitHubIssue = {
  number: 123,
  title: "Run Node loses its gate",
  state: "open",
  state_reason: null,
  labels: [{ name: "bug", color: "d73a4a" }, { name: "canvas", color: "000000" }],
  assignees: ["alwi"],
  author: "teammate",
  url: "https://github.com/initech/lotus/issues/123",
  body: "Steps:\n\n- open a run",
  comments: 1,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-02T10:00:00Z",
  closed_at: null,
};
const comment: GitHubIssueComment = {
  id: 9,
  author: "reviewer",
  body: "Seen it twice.",
  created_at: "2026-09-03T10:00:00Z",
  url: "https://github.com/initech/lotus/issues/123#issuecomment-9",
};

describe("a GitHub issue as a task to delegate (PLAN G17)", () => {
  it("is called #123 — title, and points back at owner/name#123", () => {
    const draft = taskDraftFromGitHubIssue(issue, [comment], "initech/lotus", "Lotus issues");
    expect(draft.title).toBe("#123 — Run Node loses its gate");
    expect(draft.source).toEqual({ kind: "github", ref: "initech/lotus#123", label: "#123" });
    expect(draft.goal).toContain("initech/lotus#123");
    expect(draft.goal).toContain(issue.url);
  });

  it("carries the URL, labels, body and comments in its knowledge", () => {
    const { knowledge } = taskDraftFromGitHubIssue(issue, [comment], "initech/lotus", "Lotus issues");
    expect(knowledge).toContain(issue.url);
    expect(knowledge).toContain("- Labels: bug, canvas");
    expect(knowledge).toContain("- Assignee: alwi");
    expect(knowledge).toContain("Steps:\n\n- open a run");
    expect(knowledge).toContain("reviewer");
    expect(knowledge).toContain("Seen it twice.");
    // How to read it again, and what not to do.
    expect(knowledge).toContain("gh issue view 123 -R initech/lotus --comments");
    expect(knowledge).toMatch(/Do not write to the issue/);
    expect(knowledge).toMatch(/Fixes #123/);
  });

  it("leaves out what the issue does not have", () => {
    const { knowledge } = taskDraftFromGitHubIssue(
      { ...issue, labels: [], assignees: [], body: "  " },
      [],
      "initech/lotus",
      "Lotus issues",
    );
    expect(knowledge).not.toContain("- Labels:");
    expect(knowledge).not.toContain("- Assignee:");
    expect(knowledge).not.toContain("## Issue, as read");
    expect(knowledge).not.toContain("## Comments");
  });

  it("keeps to the store's caps", () => {
    const long = taskDraftFromGitHubIssue(
      { ...issue, title: "é".repeat(300), url: `https://github.com/${"x".repeat(600)}` },
      Array.from({ length: 3 }, (_, i) => ({ ...comment, id: i, body: "z".repeat(90_000) })),
      "initech/lotus",
      "Lotus issues",
    );
    expect(utf8Length(long.title)).toBeLessThanOrEqual(TASK_TITLE_CAP);
    expect(utf8Length(long.goal)).toBeLessThanOrEqual(TASK_GOAL_CAP);
    expect(utf8Length(long.knowledge)).toBeLessThanOrEqual(TASK_KNOWLEDGE_CAP);
  });

  it("an untitled issue is still named", () => {
    expect(taskDraftFromGitHubIssue({ ...issue, title: "" }, [], "a/b", "b").title).toBe("#123 — Untitled");
  });

  it("the ref is owner/name#number", () => {
    expect(githubIssueRef("initech/lotus", 7)).toBe("initech/lotus#7");
  });
});

describe("keeping a delegated agent from writing to the issue (PLAN G7, ADR-0048 §11)", () => {
  it("denies every gh issue subcommand that writes, and none that read", () => {
    for (const sub of ["close", "comment", "create", "delete", "develop", "edit", "lock", "pin", "reopen", "transfer", "unlock", "unpin"]) {
      expect(GH_ISSUE_WRITE_SUBCOMMANDS).toContain(sub);
      expect(GITHUB_ISSUE_WRITE_DENY_RULES).toContain(`Bash(gh issue ${sub}:*)`);
    }
    for (const read of ["view", "list", "status"]) {
      expect(GITHUB_ISSUE_WRITE_DENY_RULES.some((rule) => rule.includes(`gh issue ${read}`))).toBe(false);
    }
  });

  it("denies the GitHub MCP issue write tools on any server name, and not the read ones", () => {
    for (const tool of ["issue_write", "add_issue_comment", "update_issue_comment", "sub_issue_write", "assign_copilot_to_issue"]) {
      expect(GITHUB_MCP_ISSUE_WRITE_TOOLS).toContain(tool);
      expect(GITHUB_ISSUE_WRITE_DENY_RULES).toContain(`mcp__*__${tool}`);
    }
    for (const read of ["issue_read", "list_issues", "search_issues"]) {
      expect(GITHUB_ISSUE_WRITE_DENY_RULES).not.toContain(`mcp__*__${read}`);
    }
  });

  it("leaves pushing code and opening a pull request alone", () => {
    const rules = GITHUB_ISSUE_WRITE_DENY_RULES.join(" ");
    expect(rules).not.toMatch(/git push|gh pr|create_pull_request/);
  });

  it("reaches claude as quoted arguments, spaces and all", () => {
    const claude: DelegationPreset = { id: "p", name: "Claude", agent: "claude", args: "", instructions: "" };
    expect(withDeniedTools(startCommand(claude, "s1"), ["Bash(gh issue close:*)", "mcp__*__issue_write"])).toBe(
      "claude --session-id s1 --disallowedTools 'Bash(gh issue close:*)' 'mcp__*__issue_write'",
    );
    // Every rule here passes the quoting guard.
    expect(() => denyToolsArgs(GITHUB_ISSUE_WRITE_DENY_RULES)).not.toThrow();
  });
});
