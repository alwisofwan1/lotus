"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { openExternalLink } from "@/lib/tauri-api";
import { DelegateMenu } from "@/modules/tasks/components/DelegateMenu";
import { FactoryRun } from "@/modules/tasks/components/FactoryRunSection";
import type { FactoryRef, FactoryRunClient } from "@/modules/factory";
import { TaskDetailBar } from "@/modules/tasks/components/TaskDetailBar";
import { TaskStatusGlyph } from "@/modules/tasks/components/TaskGlyphs";
import { TaskMarkdown } from "@/modules/tasks/components/TaskMarkdown";
import { TicketSourceMark } from "@/modules/tasks/components/TicketSourceMark";
import {
  GITHUB_ISSUE_VOCABULARY,
  githubIssueKey,
  issueStateLabel,
  type GitHubIssue,
  type GitHubIssueComment,
  type GitHubIssueDetail,
  type GitHubIssuesClient,
} from "@/modules/tasks/services/github-issues-source";
import { supportsChosenSession, type DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import { formatTaskEventAge, type ListPosition } from "@/modules/tasks/services/task-detail";
import type { BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";

/** Delegating the issue (ADR-0048 §11). Same shape as a Notion ticket's, but what is handed on is the issue as read. */
export interface GitHubIssueDelegation {
  presets: readonly DelegationPreset[];
  ready: boolean;
  busy: boolean;
  /** The Lotus workspaces a task made from this issue could live in. */
  targets: readonly { id: string; name: string }[];
  targetId: string;
  onTargetChange: (id: string) => void;
  /** The issue and its comments as GitHub last answered — the synced copy and no comments when unread. */
  onDelegate: (preset: DelegationPreset, read: { issue: GitHubIssue; comments: readonly GitHubIssueComment[] }) => void;
  onNewPreset: () => void;
  onEditPreset: (preset: DelegationPreset) => void;
  /** Why the last Delegate did not happen; shown on the panel, where it was pressed. */
  error?: string | null;
}

/** Running the issue as a Factory Run (ADR-0049, F2b). Absent when the repo or account is unknown. */
export interface GitHubIssueFactory {
  client: FactoryRunClient;
  repo: string;
  account: string;
  workspaces: () => { id: string; cwd: string; remote: boolean }[];
  /** Opens the Factory on this issue's run; `"chief"` opens the Chief of Staff on its PR (CoS 10). */
  onOpenRun?: (repo: string, issue: FactoryRef, tab?: "chief") => void;
}

/**
 * A GitHub issue opened from the list (ADR-0048 §10). Read only: there is no path here that writes
 * to GitHub — the one way to change an issue is "Open on GitHub".
 *
 * What the last sync holds is drawn at once: title, state, labels, assignees and the body. The
 * comments are not synced; they are read when the panel opens (PLAN G18), and that same read
 * brings the issue as GitHub has it now, which replaces the synced copy on screen.
 */
export function GitHubIssuePanel({
  issue: synced,
  sourceId,
  client,
  projectName,
  position,
  onBack,
  onStep,
  barTrailing,
  delegation,
  factory,
}: {
  issue: GitHubIssue;
  /** The source (= project) the issue belongs to; Rust reads its account and repo itself. */
  sourceId: string;
  client: Pick<GitHubIssuesClient, "readIssue">;
  projectName: string;
  position: ListPosition | null;
  onBack: () => void;
  onStep?: (taskId: string) => void;
  barTrailing?: ReactNode;
  delegation?: GitHubIssueDelegation;
  factory?: GitHubIssueFactory;
}) {
  const detail = useIssueDetail(client, sourceId, synced.number);
  const issue = (detail.state === "read" && detail.detail.issue) || synced;
  const gone = detail.state === "read" && detail.detail.issue === null;
  const body = issue.body.trim();
  // Only a preset that can be denied the issue writes is offered (PLAN G7); `useDelegation` refuses any other too.
  const presets = delegation?.presets.filter(supportsChosenSession) ?? [];

  return (
    <>
      <TaskDetailBar
        mark={<TicketSourceMark kind="github" size={13} />}
        projectName={projectName}
        taskKey={githubIssueKey(issue.number)}
        position={position}
        onBack={onBack}
        onStep={onStep}
        trailing={barTrailing}
      />
      <div className="tk-detail-scroll">
        <div className="tk-detail-page">
          <article className="tk-detail-main">
            <h2 className="tk-detail-title">{issue.title || "Untitled"}</h2>
            <p className="tk-notion-body-note">
              Issue from GitHub · read only here
              {" · "}
              <button type="button" className="tk-props-link" onClick={() => void openExternalLink(issue.url)}>
                Open on GitHub
                <ExternalLink size={11} strokeWidth={2} aria-hidden />
              </button>
            </p>
            {delegation?.error ? (
              <p className="tk-callout tk-callout--blocked tk-notion-notice" role="alert">
                {delegation.error}
              </p>
            ) : null}
            {gone ? (
              <p className="tk-callout tk-callout--blocked tk-notion-notice" role="note">
                This issue is no longer on GitHub, or it is now a pull request. What is shown is the last synced copy.
              </p>
            ) : null}

            {body ? (
              <section className="tk-detail-section" aria-label="Description">
                <TaskMarkdown html="github">{body}</TaskMarkdown>
              </section>
            ) : (
              <p className="tk-empty tk-notion-body-state">This issue has no description.</p>
            )}

            <IssueComments detail={detail} />
          </article>

          <aside className="tk-props" aria-label="Properties">
            <h3 className="tk-props-h">Status</h3>
            <p className="tk-props-value">
              <TaskStatusGlyph status={issue.state as BridgeTaskStatus} vocabulary={GITHUB_ISSUE_VOCABULARY} decorative />
              {issueStateLabel(issue)}
            </p>

            {issue.assignees.length > 0 ? (
              <>
                <h3 className="tk-props-h">Assignee</h3>
                <p className="tk-props-value">{issue.assignees.join(", ")}</p>
              </>
            ) : null}

            {issue.labels.length > 0 ? (
              <>
                <h3 className="tk-props-h">Labels</h3>
                <p className="tk-props-value">{issue.labels.map((label) => label.name).join(", ")}</p>
              </>
            ) : null}

            {issue.author ? (
              <>
                <h3 className="tk-props-h">Opened by</h3>
                <p className="tk-props-value">{issue.author}</p>
              </>
            ) : null}

            {delegation ? (
              <>
                <h3 className="tk-props-h">Agent</h3>
                {/* Shown, not assumed: the issue belongs to no workspace. */}
                {delegation.targets.length > 1 ? (
                  <label className="tk-select-chip tk-select-chip--block">
                    <span className="tk-select-chip-value">
                      in {delegation.targets.find((target) => target.id === delegation.targetId)?.name ?? "…"}
                    </span>
                    <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
                    <select
                      value={delegation.targetId}
                      aria-label="Workspace for this work"
                      onChange={(event) => delegation.onTargetChange(event.target.value)}
                    >
                      {delegation.targets.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : delegation.targets[0] ? (
                  <p className="tk-props-note">in {delegation.targets[0].name}</p>
                ) : null}
                <DelegateMenu
                  presets={presets}
                  ready={delegation.ready && delegation.targets.length > 0}
                  busy={delegation.busy}
                  onDelegate={(preset) =>
                    delegation.onDelegate(preset, {
                      issue,
                      comments: detail.state === "read" ? detail.detail.comments : [],
                    })
                  }
                  onNewPreset={delegation.onNewPreset}
                  onEditPreset={delegation.onEditPreset}
                />
                <p className="tk-props-note">
                  The agent can push and open a pull request, but cannot write to the issue — so only Claude presets are offered.
                </p>
              </>
            ) : null}

            {factory ? (
              <FactoryRun
                client={factory.client}
                repo={factory.repo}
                account={factory.account}
                workspaces={factory.workspaces}
                issue={{ number: issue.number, title: issue.title, body: issue.body }}
                presets={presets}
                onOpenInFactory={factory.onOpenRun ? () => factory.onOpenRun!(factory.repo, issue.number) : undefined}
                onOpenInChief={factory.onOpenRun ? () => factory.onOpenRun!(factory.repo, issue.number, "chief") : undefined}
              />
            ) : null}
          </aside>
        </div>
      </div>
    </>
  );
}

function IssueComments({ detail }: { detail: IssueRead }) {
  if (detail.state === "reading") return <p className="tk-empty tk-notion-body-state">Reading the comments…</p>;
  if (detail.state === "failed") {
    return (
      <p className="tk-error" role="alert">
        The comments could not be read: {detail.error}
      </p>
    );
  }
  const { detail: { comments }, readAtMs } = detail;
  return (
    <section className="tk-detail-section" aria-labelledby="tk-gh-comments-h">
      <h3 className="tk-detail-h" id="tk-gh-comments-h">
        Comments
      </h3>
      {comments.length === 0 ? (
        <p className="tk-detail-empty">No comments yet.</p>
      ) : (
        <ol className="tk-gh-comments">
          {comments.map((comment) => (
            <li key={comment.id} className="tk-gh-comment">
              <p className="tk-gh-comment-meta">
                <span className="tk-gh-comment-author">{comment.author}</span>
                <time dateTime={comment.created_at} title={comment.created_at}>
                  {formatTaskEventAge(readAtMs - Date.parse(comment.created_at))}
                </time>
              </p>
              {comment.body.trim() ? <TaskMarkdown html="github">{comment.body}</TaskMarkdown> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

type IssueRead =
  | { state: "reading" }
  /** `readAtMs`: when the answer came, so a comment's age is measured from it, not from each render. */
  | { state: "read"; detail: GitHubIssueDetail; readAtMs: number }
  | { state: "failed"; error: string };

/**
 * The issue and its comments, read once when the panel opens. The panel is keyed by issue number,
 * so stepping to another issue mounts a fresh one; `for` only guards a late answer.
 */
function useIssueDetail(client: Pick<GitHubIssuesClient, "readIssue">, sourceId: string, number: number): IssueRead {
  const key = `${sourceId}#${number}`;
  const [read, setRead] = useState<IssueRead & { for: string }>({ state: "reading", for: key });

  useEffect(() => {
    let cancelled = false;
    void client
      .readIssue(sourceId, number)
      .then((detail) => {
        if (!cancelled) setRead({ state: "read", detail, readAtMs: Date.now(), for: key });
      })
      .catch((cause) => {
        if (!cancelled) setRead({ state: "failed", error: String(cause), for: key });
      });
    return () => {
      cancelled = true;
    };
  }, [client, sourceId, number, key]);

  return read.for === key ? read : { state: "reading" };
}
