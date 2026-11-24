"use client";

import { Check, Copy, UserRound } from "lucide-react";
import { useState } from "react";

import { DetailHeader, DetailSection, EmptyState, Pill, ResourceList, ResourceRow } from "@/components/resource/resource-kit";
import { GitHubMark } from "@/components/icons/ServiceMarks";
import { SourceHealthDot } from "@/modules/tasks/components/SourceHealthBanner";
import type { HealthView } from "@/modules/tasks/services/source-health";

import { describeGitHub, type AutomationUse, type GhAccount } from "../services/connectors-api";
import { HealthPill, UsedBy } from "./connector-parts";

const LOGIN = "gh auth login";

/**
 * GitHub, through the `gh` CLI (bb's GitHub plugin works the same way: no account card, gh's own
 * login). Each automation names the account it acts as; Lotus reads that account's token per run
 * with `gh auth token --user`, so the terminal's active account never changes.
 */
/** One GitHub repo used as a ticket source, as the Tasks board last saw it (ADR-0048). */
export interface GitHubSourceHealth {
  id: string;
  name: string;
  /** The gh login it reads as. */
  account: string;
  health: HealthView;
}

export function GitHubConnector({
  accounts,
  usedBy,
  sources = [],
}: {
  accounts: GhAccount[] | null;
  usedBy: AutomationUse[];
  sources?: readonly GitHubSourceHealth[];
}) {
  const { health, status } = describeGitHub(accounts);
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard
      .writeText(LOGIN)
      .then(() => setCopied(true))
      .catch(() => undefined);

  return (
    <>
      <DetailHeader
        icon={<GitHubMark size={16} />}
        title="GitHub"
        meta={
          <span className="cn-headmeta">
            <HealthPill health={health}>{status}</HealthPill>
          </span>
        }
      />

      <DetailSection title="Accounts" id="cn-gh-accounts">
        {accounts === null ? (
          <p className="au-note">Reading gh’s logins…</p>
        ) : accounts.length === 0 ? (
          <EmptyState>
            <strong>No gh login found</strong>
            Log in with the GitHub CLI, then come back. Lotus never asks for a GitHub token itself.
          </EmptyState>
        ) : (
          <ResourceList label="GitHub accounts">
            {accounts.map((a) => (
              <ResourceRow
                key={a.login}
                label={a.login}
                leading={<UserRound size={16} strokeWidth={1.75} aria-hidden />}
                title={a.login}
                meta="github.com"
                trailing={a.active ? <Pill>Active in gh</Pill> : null}
              />
            ))}
          </ResourceList>
        )}
      </DetailSection>

      <DetailSection title="Add an account" id="cn-gh-add">
        <div className="cn-command">
          <code>{LOGIN}</code>
          <button type="button" className="rs-icon-button" aria-label="Copy command" title="Copy command" onClick={copy}>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          </button>
        </div>
        <p className="au-hint">
          Run it in any terminal, once per account. The new login shows up here on its own, and each automation can act as
          a different account.
        </p>
      </DetailSection>

      {sources.length > 0 ? (
        // The same line as the Tasks nav row, as Notion's page does (SOURCES 06).
        <DetailSection title="Ticket sources" id="cn-gh-sources">
          <ul className="cn-sources">
            {sources.map((source) => (
              <li key={source.id} className="cn-source" aria-label={source.name}>
                <span className="cn-source-name">{source.name}</span>
                <span className="cn-source-line">
                  <SourceHealthDot health={source.health} />
                  {source.health.line} · as {source.account}
                </span>
                {source.health.banner ? <p className="cn-source-banner">{source.health.banner}</p> : null}
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      <UsedBy automations={usedBy} empty="No automation uses GitHub yet." />
    </>
  );
}
