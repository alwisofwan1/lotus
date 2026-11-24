import { tauriInvoke } from "@/lib/tauri/runtime";
import type { SourceHealth } from "@/modules/tasks/services/source-health";
import type { StatusVocabulary } from "@/modules/tasks/services/task-vocabulary";
import type { ProjectCapabilities, TrackerTask } from "@/modules/tasks/types";

/**
 * A GitHub repo's issues as a ticket source (ADR-0048, plans/github-issues-source slice 03).
 *
 * Everything that talks to GitHub is in Rust (`github_issues_host.rs`), as the source's `gh`
 * account; this file holds the shapes the commands answer in, the board's two words, and how an
 * issue becomes a row. Read only: nothing here writes to GitHub.
 */

/** One issue, as `lotus_automation::github_issues::Issue` serialises it (snake_case). */
export interface GitHubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  /** `completed`, `not_planned`, `duplicate`, `reopened`, or null. */
  state_reason: string | null;
  labels: { name: string; color: string }[];
  /** Logins. */
  assignees: string[];
  author: string;
  url: string;
  body: string;
  /** How many comments it has; they are read when the issue is opened. */
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface GitHubIssueComment {
  id: number;
  author: string;
  body: string;
  created_at: string;
  url: string;
}

export interface GitHubRepoSummary {
  full_name: string;
  description: string;
  private: boolean;
  archived: boolean;
  has_issues: boolean;
  pushed_at: string | null;
}

/**
 * A source after a sync (`github_issues_host::IssueSourceSync`): its issues — the last good copy
 * whenever GitHub could not be read — and the state it is in, in Notion's words.
 */
export interface IssueSourceSync {
  issues: GitHubIssue[];
  syncedAtMs: number | null;
  reconciledAtMs: number | null;
  format: number;
  health: SourceHealth;
}

/** One issue and its comments, for its panel. `issue` is null when it is gone or is a pull request. */
export interface GitHubIssueDetail {
  issue: GitHubIssue | null;
  comments: GitHubIssueComment[];
}

/**
 * One GitHub source as `~/.claude/settings.json` keeps it, in `ticketSources` (PLAN G16). Rust
 * reads `account` and `repo` from there itself; the board only passes the id.
 */
export interface GitHubSourceConfig {
  id: string;
  kind: "github";
  /** The `gh` login every call acts as. */
  account: string;
  /** `owner/name`. */
  repo: string;
  name: string;
}

/** Read only (ADR-0048 §6). A manual order is Lotus's own, kept in the layout. */
export const GITHUB_CAPABILITIES: ProjectCapabilities = {
  holdsTasks: false,
  editRows: false,
  reorder: true,
  hasPriority: false,
};

/** An issue's two states, open first (PLAN G3). Why one was closed is shown when it is opened. */
export const GITHUB_ISSUE_VOCABULARY: StatusVocabulary = {
  order: ["open", "closed"],
  labels: { open: "Open", closed: "Closed" },
  tones: { open: "open", closed: "done" },
  open: ["open"],
};

/** The source id a repo gets (PLAN G14). Derived from the repo, so it cannot be added twice. */
export function githubSourceId(repo: string): string {
  return `github-${repo.replace("/", "-")}`
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 80);
}

/** An issue as a tracker row: `#123` by its number, never a `PREFIX-123` key (PLAN G6). */
export function toTrackerTaskFromIssue(issue: GitHubIssue, projectId: string): TrackerTask {
  const created = Date.parse(issue.created_at);
  const updated = Date.parse(issue.updated_at);
  return {
    id: String(issue.number),
    projectId,
    number: issue.number,
    title: issue.title || "Untitled",
    status: issue.state as TrackerTask["status"],
    priority: "none",
    createdAt: Number.isNaN(created) ? 0 : created,
    updatedAt: Number.isNaN(updated) ? 0 : updated,
    assignees: issue.assignees.map((login) => ({ id: login, name: login })),
    labels: issue.labels.map((label) => label.name),
  };
}

/** How a GitHub row's key reads: `#123`. */
export function githubIssueKey(number: number | undefined): string | null {
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? `#${number}` : null;
}

/** An issue's state as its panel reads it: why it was closed, when GitHub says why (PLAN G9). */
export function issueStateLabel(issue: Pick<GitHubIssue, "state" | "state_reason">): string {
  if (issue.state === "open") return "Open";
  return issue.state_reason ? `Closed · ${issue.state_reason.replace(/_/g, " ")}` : "Closed";
}

export interface GitHubIssuesClient {
  /** One sync. `full` reads every issue, due or not — when the source appears or on Refresh. */
  sync(sourceId: string, options: { full: boolean }): Promise<IssueSourceSync>;
  readIssue(sourceId: string, number: number): Promise<GitHubIssueDetail>;
  listRepos(account: string): Promise<GitHubRepoSummary[]>;
  forget(sourceId: string): Promise<void>;
}

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function createTauriGitHubIssuesClient(invokeFn: InvokeFn = tauriInvoke as InvokeFn): GitHubIssuesClient {
  return {
    sync: (sourceId, { full }) => invokeFn<IssueSourceSync>("github_issues_sync_source", { sourceId, full }),
    readIssue: (sourceId, number) => invokeFn<GitHubIssueDetail>("github_issues_read_issue", { sourceId, number }),
    listRepos: (account) => invokeFn<GitHubRepoSummary[]>("github_issues_list_repos", { account }),
    forget: (sourceId) => invokeFn<void>("github_issues_forget_source", { sourceId }),
  };
}
