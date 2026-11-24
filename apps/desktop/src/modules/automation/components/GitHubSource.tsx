"use client";

import { useState } from "react";

import { GitHubMark } from "@/components/icons/ServiceMarks";

import type { Automation, AutomationClient } from "../services/automation-api";

/**
 * Whether a PR review is also asked for on GitHub (ADR-0041): every few minutes Lotus looks for
 * PRs waiting for the account's review, or its team's, and reviews each new request once.
 */
export function GitHubSource({ automation: a, client }: { automation: Automation; client: AutomationClient }) {
  const [editing, setEditing] = useState(false);
  const [team, setTeam] = useState(a.github?.team ?? "");
  const [error, setError] = useState<string | null>(null);
  const account = a.config?.account ?? "you";

  const save = async (settings: { team?: string } | null) => {
    setError(null);
    try {
      await client.setRequestSource(a.id, "github", settings);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    }
  };

  if (editing) {
    const trimmed = team.trim();
    return (
      <div className="au-inline-form">
        <label className="au-field">
          <span className="au-label">GitHub team</span>
          <input
            className="au-input"
            placeholder="org/team-slug (optional)"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
          />
        </label>
        <p className="au-hint">
          Every few minutes, a PR that requests {account}
          {trimmed ? ` or ${trimmed}` : ""} as reviewer is reviewed once. Asked again after your review, it is reviewed
          again.
        </p>
        {error ? <p className="au-error">{error}</p> : null}
        <div className="au-draft-actions">
          <button type="button" className="rs-button rs-button--ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="button" className="rs-button rs-button--primary" onClick={() => void save(trimmed ? { team: trimmed } : {})}>
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="au-facts">
      <div className="au-fact au-fact--wide">
        <span className="au-fact-label">GitHub</span>
        <span className="au-fact-value">
          {a.github
            ? `Review requests to ${account}${a.github.team ? ` or ${a.github.team}` : ""}, checked every few minutes`
            : "Not watched"}
        </span>
      </div>
      {error ? <p className="au-error au-fact--wide">{error}</p> : null}
      <div className="au-draft-actions au-fact--wide">
        {a.github ? (
          <>
            <button type="button" className="rs-button rs-button--ghost" onClick={() => void save(null)}>
              Stop watching GitHub
            </button>
            <button type="button" className="rs-button rs-button--ghost" onClick={() => setEditing(true)}>
              <GitHubMark size={12} />
              Change team
            </button>
          </>
        ) : (
          <button type="button" className="rs-button rs-button--ghost" onClick={() => setEditing(true)}>
            <GitHubMark size={12} />
            Watch GitHub
          </button>
        )}
      </div>
    </div>
  );
}
