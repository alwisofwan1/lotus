import type { TaskSource } from "@/modules/codespace/services/bridge/task-store";
import { githubIssueKey, type GitHubIssue, type GitHubIssueComment } from "@/modules/tasks/services/github-issues-source";
import { TASK_GOAL_CAP, TASK_KNOWLEDGE_CAP, TASK_TITLE_CAP, cutToBytes } from "@/modules/tasks/services/task-draft";

/**
 * Delegating a GitHub issue (ADR-0048 §11, plans/github-issues-source slice 06).
 *
 * The task is made ALONGSIDE the issue — nothing is written to GitHub. The agent works the code:
 * it may push and open a pull request ("Fixes #123" closes the issue when a human merges it), but it
 * must not write to the issue itself. That is kept from it on its command line, not left to the
 * prompt — with a caveat the ADR spells out: a Bash rule matches by prefix, so it is best effort
 * (`gh api -X PATCH …` or `curl` with a token still get through). The common ways are blocked.
 */

/** `gh issue` subcommands that change an issue, from `gh issue --help` (gh 2.x, checked 2026-10-05). */
export const GH_ISSUE_WRITE_SUBCOMMANDS: readonly string[] = [
  "close",
  "comment",
  "create",
  "delete",
  "develop",
  "edit",
  "lock",
  "pin",
  "reopen",
  "transfer",
  "unlock",
  "unpin",
];

/**
 * The GitHub MCP server's tools that write to an issue, from
 * https://github.com/github/github-mcp-server/blob/main/README.md (checked 2026-10-05). The older
 * one-tool-per-action names are kept too: a pinned or older server still ships them.
 * `add_issue_comment` also comments on pull requests; the agent can still open one.
 */
export const GITHUB_MCP_ISSUE_WRITE_TOOLS: readonly string[] = [
  "issue_write",
  "add_issue_comment",
  "update_issue_comment",
  "sub_issue_write",
  "assign_copilot_to_issue",
  "assign_copilot_to_issue_with_intent",
  // Older names.
  "create_issue",
  "update_issue",
  "add_sub_issue",
  "remove_sub_issue",
  "reprioritize_sub_issue",
];

/**
 * Deny rules for both. MCP tools on ANY server name, as for Notion (`notion-delegation.ts`): the
 * server is whatever the person called it (`github`, `claude_ai_GitHub`, …).
 */
export const GITHUB_ISSUE_WRITE_DENY_RULES: readonly string[] = [
  ...GH_ISSUE_WRITE_SUBCOMMANDS.map((sub) => `Bash(gh issue ${sub}:*)`),
  ...GITHUB_MCP_ISSUE_WRITE_TOOLS.map((tool) => `mcp__*__${tool}`),
];

/**
 * Said to the agent when its folder is only a NAMESAKE of the issue's repo (`useIssueCheckout`):
 * `flow-trader` is a clone of `mapantekno/e-coursetradding`, the issue is in
 * `donisapu/e-coursetradding`. Pushing is not kept from it — the team may well work in the clone's
 * repo (the person chose this, 2026-10-17) — but a push or a pull request goes to `origin`, so the
 * agent is told which repo that is, and asked before it sends code anywhere.
 */
export function namesakeCheckoutNote(issueRepo: string, folderRepo: string): string {
  return `Note: this issue is in ${issueRepo}, but this folder is a clone of ${folderRepo} — a push or a pull request from here goes to ${folderRepo}. Ask before pushing or opening a pull request if it is unclear which repo should get the code.`;
}

/** What a task made from an issue points back at: `owner/name#123`. */
export function githubIssueRef(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/** A GitHub issue as a workable Lotus task (PLAN G17), made alongside it. */
export function taskDraftFromGitHubIssue(
  issue: GitHubIssue,
  /** The comments as read when the panel opened; empty when they could not be read. */
  comments: readonly GitHubIssueComment[],
  repo: string,
  sourceName: string,
): { title: string; goal: string; knowledge: string; source: TaskSource } {
  const key = githubIssueKey(issue.number) ?? `#${issue.number}`;
  const ref = githubIssueRef(repo, issue.number);
  const title = cutToBytes(`${key} — ${issue.title || "Untitled"}`.trim(), TASK_TITLE_CAP);
  const goal = cutToBytes(`Work GitHub issue ${ref} from ${sourceName}. Read it first: ${issue.url}`, TASK_GOAL_CAP);

  const knowledge = [
    "## GitHub issue",
    [
      `- Issue: ${issue.url}`,
      `- Repo: ${repo}`,
      `- State: ${issue.state}${issue.state_reason ? ` (${issue.state_reason.replace(/_/g, " ")})` : ""}`,
      issue.author ? `- Opened by: ${issue.author}` : null,
      issue.assignees.length ? `- Assignee: ${issue.assignees.join(", ")}` : null,
      issue.labels.length ? `- Labels: ${issue.labels.map((label) => label.name).join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    "## Before you start",
    [
      `Read the issue again with \`gh issue view ${issue.number} -R ${repo} --comments\` before starting —`,
      "it may have changed since it was copied below, and what is there wins.",
      "Do not write to the issue: no comments, edits, labels, closing or reopening. Report back here instead.",
      `Pushing code and opening a pull request are fine; put "Fixes #${issue.number}" in the pull request body.`,
    ].join("\n"),
    issue.body.trim() ? `## Issue, as read when delegated\n\n${issue.body.trim()}` : null,
    comments.length
      ? `## Comments\n\n${comments
          .map((comment) => `**${comment.author}** · ${comment.created_at}\n\n${comment.body.trim()}`)
          .join("\n\n---\n\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    title,
    goal,
    knowledge: cutToBytes(knowledge, TASK_KNOWLEDGE_CAP),
    source: { kind: "github", ref, label: key },
  };
}
