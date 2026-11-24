"use client";

import { CircleStop, GitPullRequestDraft, MessagesSquare, X } from "lucide-react";
import { useState } from "react";
import { DetailHeader, DetailSection, IconButton } from "@/components/resource/resource-kit";
import { openExternalLink } from "@/lib/tauri-api";
import {
  factoryFindSlackThread,
  factoryOpenWorktree,
  graphRunAbort,
  graphRunDecide,
  graphRunRaiseCap,
  graphRunStart,
  type FactoryDecision,
  type FactorySlackThread,
  type GraphRunStartInput,
} from "@/lib/tauri/graph-run";
import { factoryRetryInput, factoryRunDetail, failingLines, type FactoryAction } from "../services/factory-run-detail";
import { factoryRunElapsedMs, formatElapsed, type FactoryRunRow } from "../services/factory-run-list";
import { factoryRefLabel, openIntakeTurn, type FactoryRef } from "../services/factory-run";
import { factoryBrainstormPrompt } from "../services/factory-brainstorm";
import { FactoryIntakePanel } from "./FactoryIntakePanel";
import { FactoryTriagePanel } from "./FactoryTriagePanel";
import { FactoryRunTimeline } from "./FactoryRunTimeline";
import { FactoryStageBar } from "./FactoryStageBar";
import { SlackThreadCheck } from "./SlackThreadCheck";
import { DitherPixels } from "./FactoryDither";
import { factoryTries } from "../services/factory-progress";
import { factoryTimeline, factoryTimelineSummary } from "../services/factory-timeline";
import { factoryRoundLines } from "../services/factory-board";
import "@/styles/factory.css";

/** What the pane asks of the app; a port, so it is testable with no Tauri. */
export interface FactoryRunActions {
  start(input: GraphRunStartInput): Promise<string>;
  raiseCap(runId: string): Promise<number>;
  abort(runId: string): Promise<void>;
  /** Answers, approves or sends back a run waiting on its intake (FI2). */
  decide(runId: string, decision: FactoryDecision): Promise<void>;
  openUrl(url: string): Promise<void>;
  /**
   * Brainstorm live: opens an agent in a terminal with this prompt, in the workspace on `checkout`.
   * Resolves to why it could not, or null. Absent where there is nowhere to open one.
   */
  brainstorm?: (prompt: string, checkout: string, run?: { repo: string; issue: FactoryRef; title: string }) => Promise<string | null>;
  /** The ticket as GitHub or Notion has it now, for Try again; null when it cannot be read. */
  readIssue(repo: string, issue: FactoryRef): Promise<{ title: string; body: string | null } | null>;
  /** Opens the run's worktree in Finder (Chief of Staff "Open worktree"). */
  openWorktree?: (runId: string) => Promise<void>;
  /** The Slack thread the run's PR link was shared in, as Slack search finds it now (CoS 12). */
  findSlackThread?: (runId: string) => Promise<FactorySlackThread | null>;
}

export function createTauriFactoryRunActions(readIssue: FactoryRunActions["readIssue"]): FactoryRunActions {
  return {
    start: graphRunStart,
    raiseCap: graphRunRaiseCap,
    abort: graphRunAbort,
    decide: graphRunDecide,
    openUrl: openExternalLink,
    readIssue,
    openWorktree: factoryOpenWorktree,
    findSlackThread: factoryFindSlackThread,
  };
}

const PRIMARY_LABEL: Record<Exclude<FactoryAction, "abort">, string> = {
  "try-again": "Try again",
  "raise-cap": "Raise cap",
  "review-pr": "Review PR",
};

const usd = (n: number) => `$${n.toFixed(2)}`;

/** `https://github.com/o/r/pull/9` → `o/r#9`; anything else stays as it is. */
function prLabel(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]}#${m[2]}` : url;
}

/**
 * One run, in full: what it is, where it stands in one sentence, and the one thing to do next.
 * Abort is an icon beside the title, never a second filled button.
 */
export function FactoryRunDetailPane({
  row,
  now,
  actions,
  onClose,
}: {
  row: FactoryRunRow;
  now: number;
  actions: FactoryRunActions;
  /** Closes the panel; the run goes on. Absent where the pane cannot be closed. */
  onClose?: () => void;
}) {
  const detail = factoryRunDetail(row);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: FactoryAction) => {
    setBusy(true);
    setError(null);
    try {
      if (action === "try-again") {
        // The issue may have been edited since this run read it; the stored copy is the fallback.
        const fresh = await actions.readIssue(row.repo, row.issue).catch(() => null);
        await actions.start(factoryRetryInput(row, fresh));
      }
      else if (action === "raise-cap") await actions.raiseCap(row.id);
      else if (action === "abort") await actions.abort(row.id);
      else if (row.prUrl) await actions.openUrl(row.prUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: FactoryDecision) => {
    setBusy(true);
    setError(null);
    try {
      await actions.decide(row.id, decision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const brainstorm = async () => {
    if (!actions.brainstorm) return;
    setBusy(true);
    setError(null);
    try {
      const why = await actions.brainstorm(factoryBrainstormPrompt(row), row.ticket.checkout, { repo: row.repo, issue: row.issue, title: row.title });
      if (why) setError(why);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const waitingTurn = row.state === "needs-answers" || row.state === "needs-approval" ? openIntakeTurn(row.intake) : null;
  const spend = row.spentUsd !== null && row.capUsd !== null ? `${usd(row.spentUsd)} of ${usd(row.capUsd)}` : null;
  const notion = row.ticket.notion;
  const issueUrl = notion ? notion.url : `https://github.com/${row.repo}/issues/${row.issue}`;
  const lines = row.state === "check-failed" ? failingLines(row.output) : [];
  const events = factoryTimeline(row, now);
  const tries = factoryTries(row.progress, row.state);
  const summary = row.state === "done" ? row.progress?.summary : undefined;
  const rounds = factoryRoundLines(row.prWatch?.rounds);

  return (
    <div className="fa-detail">
      <DetailHeader
        level={2}
        icon={<span className="fa-glyph" data-group={row.group} />}
        title={`${factoryRefLabel(row.issue)} ${row.title}`}
        meta={
          <span className="fa-meta">
            <button type="button" className="fa-link" onClick={() => void actions.openUrl(issueUrl)}>
              {notion ? `${notion.key} in Notion` : `${row.repo}#${row.issue}`}
            </button>
            {notion ? <span>code in {row.repo}</span> : null}
            <span className="fa-status" data-group={row.group}>
              {detail.statusWord}
            </span>
            <span className="fa-time">{formatElapsed(factoryRunElapsedMs(row, now))}</span>
            {spend ? <span>{spend}</span> : null}
          </span>
        }
        actions={
          <>
            {detail.secondary.includes("abort") ? (
              <IconButton label="Abort run" onClick={() => void run("abort")} disabled={busy}>
                <CircleStop size={15} strokeWidth={1.75} aria-hidden />
              </IconButton>
            ) : null}
            {onClose ? (
              <IconButton label="Close run detail (Esc)" onClick={onClose}>
                <X size={15} strokeWidth={1.75} aria-hidden />
              </IconButton>
            ) : null}
          </>
        }
      />
      <div className="fa-next" data-tone={detail.statusWord === "Needs you" ? "needs-you" : undefined}>
        <span className="fa-next-tag">{detail.statusWord === "Needs you" ? "Next step" : "Status"}</span>
        <p className="fa-sentence">{detail.sentence}</p>
        {detail.primary && detail.primary !== "abort" ? (
          <button type="button" className="rs-button rs-button--primary" disabled={busy} onClick={() => void run(detail.primary!)}>
            {PRIMARY_LABEL[detail.primary]}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="fa-error">
          {error}
        </p>
      ) : null}

      {row.state === "recovery-required" ? <DetailSection title="Recovery inspection">
        <p className="fa-note">Recovery-aware Resume is not available yet. Do not start a replacement run until you have checked whether an old agent or publication is still active.</p>
        <p className="fa-note">From <code>{row.ticket.checkout}</code>, use <code>git worktree list</code> to find this run&apos;s worktree. Inspect its edits, branch and GitHub PR before taking further action.</p>
        <p className="fa-note">Run ID: <code>{row.id}</code>. Abort ends the recorded run, not an unverified process left by a crash; retained artifacts remain subject to the existing cleanup policy.</p>
      </DetailSection> : null}
      {row.state !== "recovery-required" && row.intake?.triage ? (
        <FactoryTriagePanel
          triage={row.intake.triage}
          repo={row.repo}
          busy={busy}
          proceed={() => void decide({ kind: "proceed" })}
          openUrl={(url) => void actions.openUrl(url)}
        />
      ) : null}
      {waitingTurn ? (
        <FactoryIntakePanel key={`${waitingTurn.kind}-${waitingTurn.at}`} turn={waitingTurn} busy={busy} decide={(d) => void decide(d)} />
      ) : null}
      {waitingTurn && actions.brainstorm ? (
        <div className="fa-brainstorm">
          <button type="button" className="rs-button" disabled={busy} onClick={() => void brainstorm()}>
            <MessagesSquare size={14} strokeWidth={1.75} aria-hidden />
            Brainstorm live
          </button>
          <span className="fa-note">Talk it through with an agent in a terminal instead. Its spec comes back here for you to approve.</span>
        </div>
      ) : null}

      {row.state === "check-failed" && row.output ? (
        <DetailSection title="Why the check failed">
          <pre className="fa-well">{lines.join("\n")}</pre>
          <details className="fa-full">
            <summary>Full output</summary>
            <pre className="fa-well">{row.output}</pre>
          </details>
        </DetailSection>
      ) : null}

      {row.progress ? (
        <div className="fa-detail-strip">
          <FactoryStageBar progress={row.progress} state={row.state} pixel={6} rows={4} />
          {tries ? (
            <p className="fa-tries">
              <span className="fa-tries-tag">Tries</span>
              <span className="fa-tries-cells">
                {tries.cells.map((status, i) => (
                  <span key={i} className="fa-try" data-status={status}>
                    <DitherPixels status={status} pixel={4} />
                  </span>
                ))}
              </span>
              <span>{tries.label}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {events ? <FactoryRunTimeline events={events} summary={factoryTimelineSummary(row, events, now)} /> : null}
      {summary ? (
        <DetailSection title="Agent's summary">
          <p className="fa-note">Written by the agent, not verified.</p>
          <p className="fa-summary">{summary}</p>
        </DetailSection>
      ) : null}

      {row.state === "done" && row.prUrl ? (
        <DetailSection title="Pull request">
          <div className="fa-pr">
            <GitPullRequestDraft size={15} strokeWidth={1.75} aria-hidden />
            <span className="fa-pr-name">{prLabel(row.prUrl)}</span>
            <span className="fa-pr-state">Draft</span>
          </div>
          {rounds.length > 0 ? (
            <ol className="fa-rounds" aria-label="Rounds">
              {rounds.map((r) => (
                <li key={r.runId} className="fa-round" data-tone={r.tone}>
                  <span className="fa-round-name">Round {r.round}</span>
                  <span className="fa-round-state">{r.state}</span>
                  <span className="fa-round-line">{r.line}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {actions.findSlackThread && row.prWatch && row.prWatch.phase !== "merged" && row.prWatch.phase !== "closed" ? (
            <SlackThreadCheck runId={row.id} onFind={actions.findSlackThread} onError={setError} />
          ) : null}
        </DetailSection>
      ) : null}

    </div>
  );
}
