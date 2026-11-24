"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { TasksModal } from "@/modules/tasks/components/TasksModal";
import { TicketSourceMark } from "@/modules/tasks/components/TicketSourceMark";
import type { GhAccount } from "@/modules/connectors/services/connectors-api";
import {
  githubSourceId,
  type GitHubIssuesClient,
  type GitHubRepoSummary,
  type GitHubSourceConfig,
} from "@/modules/tasks/services/github-issues-source";
import { isGitHubRepoName } from "@/modules/tasks/services/ticket-source-settings";

/**
 * Add a GitHub repo as a ticket source (ADR-0048, PLAN G2 · G14 · G16): pick the `gh` account it
 * reads as, then a repo — from the account's list, or typed as `owner/name` for one the list does
 * not hold (an org repo the account was invited to, say). Read only, so there is nothing else to
 * choose. A repo that is already a source is shown as Added and cannot be added again.
 */

export interface AddGitHubRepoSheetProps {
  /** At least one; with none, Tasks points to Connectors instead of opening this. */
  accounts: readonly GhAccount[];
  client: Pick<GitHubIssuesClient, "listRepos">;
  /** `repo` is already a source, in any letter case. */
  isAdded: (repo: string) => boolean;
  onAdd: (source: GitHubSourceConfig) => void;
  onClose: () => void;
}

export function AddGitHubRepoSheet({ accounts, client, isAdded, onAdd, onClose }: AddGitHubRepoSheetProps) {
  const headingId = useId();
  const [account, setAccount] = useState(() => (accounts.find((a) => a.active) ?? accounts[0])?.login ?? "");
  /** The last list read, with the account it was read for: a list for another account is not shown. */
  const [read, setRead] = useState<{ account: string; repos: GitHubRepoSummary[] | null; error: string | null } | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    void client
      .listRepos(account)
      .then((found) => {
        if (!cancelled) setRead({ account, repos: found, error: null });
      })
      .catch((cause) => {
        if (!cancelled) setRead({ account, repos: null, error: String(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [account, client]);

  const current = read?.account === account ? read : null;
  const repos = current?.repos ?? null;
  const listError = current?.error ?? null;

  const typed = query.trim();
  const shown = useMemo(() => {
    const needle = typed.toLowerCase();
    return (repos ?? []).filter((repo) => repo.full_name.toLowerCase().includes(needle));
  }, [repos, typed]);
  // A typed `owner/name` the list does not hold is offered as its own row.
  const typedRepo =
    isGitHubRepoName(typed) && !shown.some((repo) => repo.full_name.toLowerCase() === typed.toLowerCase()) ? typed : null;

  const already = picked ? isAdded(picked) : false;
  const canAdd = Boolean(picked && account) && !already;

  const add = () => {
    if (!picked || !canAdd) return;
    onAdd({ id: githubSourceId(picked), kind: "github", account, repo: picked, name: picked });
  };

  const row = (repo: string, note: string | null) => (
    <li key={repo}>
      <button
        type="button"
        role="option"
        aria-selected={picked === repo}
        className="tk-add-notion-db"
        onClick={() => setPicked(repo)}
      >
        {repo}
        {isAdded(repo) ? (
          <span className="tk-add-source-badge">Added</span>
        ) : note ? (
          <span className="tk-add-source-badge">{note}</span>
        ) : null}
      </button>
    </li>
  );

  return (
    <TasksModal labelledBy={headingId} onClose={onClose} size="lg" className="tk-add-notion">
      <div className="tk-add-source-body">
        <h2 className="tk-add-source-title" id={headingId}>
          <TicketSourceMark kind="github" size={15} />
          Add a GitHub repo
        </h2>

        <section className="tk-add-notion-section" aria-label="Account">
          <h3 className="tk-add-notion-h">Account</h3>
          {accounts.length > 1 ? (
            <label className="tk-add-notion-field">
              <span className="tk-add-notion-field-name">Read as</span>
              <select
                aria-label="GitHub account"
                value={account}
                onChange={(event) => {
                  setAccount(event.target.value);
                  setPicked(null);
                }}
              >
                {accounts.map((a) => (
                  <option key={a.login} value={a.login}>
                    {a.login}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="tk-add-notion-note">Read as {account}, from gh.</p>
          )}
        </section>

        <section className="tk-add-notion-section" aria-label="Repository">
          <h3 className="tk-add-notion-h">Repository</h3>
          <label className="tk-add-notion-search">
            <Search size={13} strokeWidth={1.75} aria-hidden />
            <input
              autoFocus
              value={query}
              placeholder="Search, or type owner/name"
              aria-label="Search repositories, or type owner/name"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {listError ? <p className="tk-error" role="alert">{listError}</p> : null}
          {repos === null && !listError ? <p className="tk-add-notion-note">Reading {account}’s repositories…</p> : null}
          {repos !== null && shown.length === 0 && !typedRepo ? (
            <p className="tk-add-notion-note">No repository matches. Type it as owner/name to add one not listed.</p>
          ) : null}
          {shown.length > 0 || typedRepo ? (
            <ul className="tk-add-notion-list" role="listbox" aria-label="Repositories">
              {typedRepo ? row(typedRepo, "Typed") : null}
              {shown.map((repo) =>
                row(repo.full_name, !repo.has_issues ? "Issues off" : repo.archived ? "Archived" : repo.private ? "Private" : null),
              )}
            </ul>
          ) : null}
        </section>

        <div className="tk-add-notion-foot">
          {already ? <span className="tk-add-notion-note">This repo is already a ticket source.</span> : null}
          <button type="button" className="tk-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="tk-button tk-button--primary" disabled={!canAdd} onClick={add}>
            {picked ? `Add ${picked}` : "Add repo"}
          </button>
        </div>
      </div>
    </TasksModal>
  );
}
