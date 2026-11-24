"use client";

import { CalendarClock, GitPullRequest, MessageCircleQuestion, MessagesSquare } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { EmptyState } from "@/components/resource/resource-kit";

import { useSlackChannelNames } from "../hooks/useSlackChannelNames";
import { useSlackUserNames } from "../hooks/useSlackUserNames";
import type { Automation, AutomationClient, AutomationDraft, AutomationProject, AutomationRun, Verdict } from "../services/automation-api";
import { formatShortWhen } from "../services/format";
import { AnsweredAsks, AskCard } from "./AskCard";
import {
  isAsk,
  isReReview,
  latestReviewRounds,
  needsAttention,
  newerRuns,
  openFindings,
  previewLine,
  requestKey,
  requesterLabel,
  reviewPreview,
  reviewRoomKey,
  rowStatus,
  shortPr,
  waitingGroupLabel,
  waitingItems,
  waitingRequests,
  wasDelivered,
} from "../services/inbox-model";
import { DraftCard } from "./DraftCard";
import { ResultCard } from "./ResultCard";
import { RunningLine, RunningNow } from "./RunningNow";
import { RunThread } from "./RunThread";
import { SentReviews } from "./SentReviews";
import { ReviewRoom } from "./ReviewRoom";
import { AutomationBoundary } from "./AutomationBoundary";
import { RequesterAvatar } from "./Requester";
import { NeedsAttention } from "./NeedsAttention";

export { latestReviewRounds, newerRuns, previewLine, reviewRoomKey, waitsForYou, wasDelivered } from "../services/inbox-model";

const HISTORY_STEP = 5;
const optionId = (id: string) => `au-waiting-${id}`;

/**
 * Inbox: what automations made that needs the user. Everything waiting is one short row in a
 * list; the open row is read, edited and sent on the right, so many items stay scannable. Reviews
 * already sent, and results that were only for the user, are kept below.
 */
export function InboxTab({
  drafts,
  results,
  sent = [],
  answered = [],
  automations,
  client,
  loaded,
  runs = [],
  initialSelectedId = null,
  readerTarget,
  hideReader = false,
  projects = [],
  show = "all",
  onOpenItem,
  readerOpen = true,
  quiet = false,
  onOpenAutomation,
}: {
  drafts: AutomationDraft[];
  results: AutomationDraft[];
  sent?: AutomationDraft[];
  /** Answered Asks, newest first. */
  answered?: AutomationDraft[];
  automations: Automation[];
  client: AutomationClient;
  loaded: boolean;
  /** Recent runs, to show the ones working right now. */
  runs?: AutomationRun[];
  /** The row open first (an Ask a notification pointed to); the top row when absent or gone. */
  initialSelectedId?: string | null;
  /**
   * Where the open row is read: the surface's right pane. Absent reads it beside the list; null is
   * a pane not mounted yet, so nothing is read until it is.
   */
  readerTarget?: HTMLElement | null;
  /** The pane shows something else (Settings): the list stays, the reader steps aside. */
  hideReader?: boolean;
  /** The window's workspaces, so a run in a pane can say which project to look in. */
  projects?: AutomationProject[];
  /** Which part to show: what is running and waits (`waiting`), what is finished (`done`), or both. */
  show?: "all" | "waiting" | "done";
  /** The user opened a row to read: the host opens its pane on it. */
  onOpenItem?: () => void;
  /**
   * The pane is open on the selected row. While it is closed, j/k only move the selection; a
   * click, Enter or Space opens the row. Absent: always open (the reader sits beside the list).
   */
  readerOpen?: boolean;
  /**
   * The Dock's quiet list (`.pen` 16 v2): Running is one live line, and the list has no heading of
   * its own — the Inbox tab above it already says what it is and how many.
   */
  quiet?: boolean;
  /** Opens an automation's channel: a "Needs attention" card's fix. */
  onOpenAutomation?: (id: string) => void;
}) {
  const automationOf = (id: string) => automations.find((a) => a.id === id);
  const fromSlack = drafts.some((d) => d.slack) || sent.some((d) => d.slack) || results.some((r) => r.result?.channel);
  const channels = useSlackChannelNames(client, fromSlack);
  const channelName = (id: string) => channels.get(id) ?? id;
  // An Ask blocks an agent's work, so every Ask comes before every draft; newest first within each.
  // The PR reviews one Slack thread asked for sit together, so j/k walks a request's PRs in turn.
  const requests = waitingRequests(waitingItems(drafts, results));
  const waiting = requests.flatMap((r) => r.items);
  const users = useSlackUserNames(client, waiting.flatMap((d) => (d.slack?.requester ? [d.slack.requester] : [])));
  const delivered = results.filter(wasDelivered).slice(0, 20);
  const rooms = latestReviewRounds(sent).filter((d) => !waiting.some((w) => reviewRoomKey(w) === reviewRoomKey(d)));
  const roomRunning = (d: AutomationDraft) => runs.some((r) => r.automationId === d.automationId && (r.status === "running" || r.status === "queued") && r.key.toLowerCase().startsWith(`${d.content?.repo.toLowerCase()}#${d.content?.number}@`));
  const newer = newerRuns(waiting);

  const [selected, setSelected] = useState<{ id: string | null; index: number }>({ id: initialSelectedId, index: 0 });
  /** Result edits, kept while another row is open. Review drafts save their own edits. */
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [sentShown, setSentShown] = useState(HISTORY_STEP);
  const [deliveredShown, setDeliveredShown] = useState(HISTORY_STEP);

  if (!loaded) return null;
  const showWaiting = show !== "done";
  const showDone = show !== "waiting";

  // A row that was sent or discarded leaves the list: the one now in its place opens.
  let index = waiting.findIndex((d) => d.id === selected.id);
  if (index < 0) index = Math.min(selected.index, waiting.length - 1);
  const open = waiting[index];
  // The open PR's request, for the reader's sibling chips; none for a PR not asked for in Slack.
  const openRequest = open && requestKey(open) ? (requests.find((r) => r.items.includes(open))?.items ?? []) : [];

  const select = (at: number, focus = false, openIt = true) => {
    const d = waiting[at];
    if (!d) return;
    setSelected({ id: d.id, index: at });
    if (openIt) onOpenItem?.();
    if (focus) document.getElementById(optionId(d.id))?.focus();
  };
  const listKeys = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      return select(index, false, true);
    }
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[event.key];
    const to =
      step !== undefined
        ? Math.max(0, Math.min(waiting.length - 1, index + step))
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? waiting.length - 1
            : null;
    if (to === null) return;
    event.preventDefault();
    select(to, true, readerOpen);
  };

  // The reader goes to the right pane when the surface has one; beside the list otherwise.
  // A card that throws takes down only the reader, not the list beside it.
  const readInPlace = (content: ReactNode) => {
    if (hideReader || !showWaiting) return null;
    const reader = (
      <AutomationBoundary region="reader" resetKey={open?.id}>
        {content}
      </AutomationBoundary>
    );
    return readerTarget === undefined ? reader : readerTarget ? createPortal(reader, readerTarget) : null;
  };

  return (
    <div className="au-inbox">
      {showWaiting ? (
        quiet ? (
          <RunningLine runs={runs} automations={automations} client={client} projects={projects} />
        ) : (
          <RunningNow runs={runs} automations={automations} client={client} projects={projects} />
        )
      ) : null}
      {showWaiting ? (
        <NeedsAttention items={needsAttention(automations, runs)} client={client} onOpenAutomation={onOpenAutomation} />
      ) : null}
      {showWaiting ? (
      <section aria-labelledby={quiet ? undefined : "au-waiting"} aria-label={quiet ? "Waiting for you" : undefined} className="au-inbox-group">
        {quiet ? null : <div className="au-group-head">
          <h2 id="au-waiting" className="au-group-title">
            Waiting for you <span className="rs-tab-count">{waiting.length || ""}</span>
          </h2>
          {waiting.length > 1 ? (
            <span className="au-hint">
              <kbd>↑</kbd> <kbd>↓</kbd> or <kbd>j</kbd> <kbd>k</kbd> to move
            </span>
          ) : null}
        </div>}
        {(waiting.length === 0 || !open) && readerTarget !== undefined
          ? readInPlace(
              <div className="au-pane-empty">
                <strong>Nothing open</strong>
                <span>When something waits for you, it opens here to read, edit and send.</span>
              </div>,
            )
          : null}
        {waiting.length === 0 || !open ? (
          <EmptyState>
            <strong>Nothing waiting</strong>
            Review drafts and channel posts stop here until you press Send. Nothing goes to other people on its own.
          </EmptyState>
        ) : (
          <div className="au-triage" data-reader={readerTarget === undefined ? undefined : "pane"} data-quiet={quiet || undefined}>
            <ul className="au-triage-list" role="listbox" aria-label="Waiting items" onKeyDown={listKeys}>
              {quiet ? waiting.map((d, at) => (
                <QuietRow
                  key={d.id}
                  draft={d}
                  selected={at === index}
                  opened={at === index && readerOpen}
                  older={newer.has(d.id)}
                  automationName={automationOf(d.automationId)?.name}
                  channelName={channelName}
                  onSelect={() => select(at)}
                />
              )) : requests.map((request, n) => {
                const newest = request.items[request.items.length - 1];
                const group = waitingGroupLabel(newest);
                const heading = n === 0 || waitingGroupLabel(requests[n - 1].items[requests[n - 1].items.length - 1]) !== group;
                const slack = request.key ? newest.slack : null;
                const asker = slack ? requesterLabel(slack, users) : null;
                const many = request.items.length > 1;
                return [
                  heading ? (
                    <li key={`g:${group}:${n}`} role="presentation" className="au-day">
                      {group}
                    </li>
                  ) : null,
                  slack && asker && many ? (
                    <li key={`r:${request.key}`} role="presentation" className="au-request-head">
                      <RequesterAvatar id={slack.requester} {...asker} />
                      <span className="au-request-who">{asker.who}</span>
                      <span className="au-request-what">
                        asked for {request.items.length} reviews · #{channelName(slack.channel)}
                      </span>
                      <time className="au-triage-when" dateTime={new Date(newest.createdAtMs).toISOString()}>
                        {formatShortWhen(newest.createdAtMs)}
                      </time>
                    </li>
                  ) : null,
                  ...request.items.map((d) => {
                    const at = waiting.indexOf(d);
                    return (
                      <WaitingRow
                        key={d.id}
                        draft={d}
                        selected={at === index}
                        opened={at === index && readerOpen}
                        older={newer.has(d.id)}
                        automationName={automationOf(d.automationId)?.name}
                        channelName={channelName}
                        text={edits[d.id]}
                        request={asker ? (many ? { in: "group", last: d === newest } : { in: "single", ...asker, id: slack?.requester }) : undefined}
                        onSelect={() => select(at)}
                      />
                    );
                  }),
                ];
              })}
            </ul>
            {readInPlace(<div className="au-triage-reader">
              {isAsk(open) ? (
                <AskCard key={open.id} ask={open} client={client} />
              ) : open.kind === "pr_review" ? (
                <DraftCard
                  key={open.id}
                  draft={open}
                  client={client}
                  automationName={automationOf(open.automationId)?.name}
                  account={automationOf(open.automationId)?.config?.account}
                  channelName={open.slack ? channels.get(open.slack.channel) : undefined}
                  requester={open.slack ? requesterLabel(open.slack, users) : undefined}
                  siblings={openRequest.map((d) => ({ id: d.id, label: shortPr(d), verdict: d.content?.reply?.verdict }))}
                  onOpenSibling={(id) => select(waiting.findIndex((d) => d.id === id))}
                  quiet={quiet}
                />
              ) : (
                <ResultCard
                  key={open.id}
                  result={open}
                  client={client}
                  channelName={open.result?.channel ? channels.get(open.result.channel) : undefined}
                  newerAtMs={newer.get(open.id)}
                  text={edits[open.id]}
                  onTextChange={(text) => setEdits((prev) => ({ ...prev, [open.id]: text }))}
                />
              )}
              {isAsk(open) ? null : <RunThread key={`thread-${open.runId}`} client={client} runId={open.runId} kind={open.kind} />}
              {open.kind === "pr_review" ? <ReviewRoom key={`room-${open.id}`} draft={open} client={client} running={roomRunning(open)} defaultOpen={readerTarget !== undefined} /> : null}
            </div>)}
          </div>
        )}
      </section>
      ) : null}

      {show === "done" && answered.length === 0 && rooms.length === 0 && delivered.length === 0 ? (
        <EmptyState>
          <strong>Nothing finished yet</strong>
          Reviews you sent, answered questions and delivered results are kept here.
        </EmptyState>
      ) : null}

      {showDone && answered.length > 0 ? (
        <section aria-labelledby="au-answered" className="au-inbox-group">
          <h2 id="au-answered" className="au-group-title">
            Answered
          </h2>
          <AnsweredAsks answered={answered} />
        </section>
      ) : null}

      {showDone && rooms.length > 0 ? (
        <section aria-labelledby="au-sent" className="au-inbox-group">
          <h2 id="au-sent" className="au-group-title">
            Sent
          </h2>
          <SentReviews sent={rooms.slice(0, sentShown)} channelName={channelName} client={client} running={roomRunning} />
          <ShowMore shown={sentShown} total={rooms.length} onMore={() => setSentShown(rooms.length)} />
        </section>
      ) : null}

      {showDone && delivered.length > 0 ? (
        <section aria-labelledby="au-delivered" className="au-inbox-group">
          <h2 id="au-delivered" className="au-group-title">
            Recent results
          </h2>
          {delivered.slice(0, deliveredShown).map((r) => (
            <ResultCard key={r.id} result={r} client={client} />
          ))}
          <ShowMore shown={deliveredShown} total={delivered.length} onMore={() => setDeliveredShown(delivered.length)} />
        </section>
      ) : null}
    </div>
  );
}

type RowRequest =
  | { in: "group"; last: boolean }
  | { in: "single"; id: string | null | undefined; who: string; known: boolean; you: boolean };

const VERDICT: Record<Verdict, string> = { "changes-needed": "Changes needed", questions: "Questions", "looks-good": "LGTM" };

function WaitingRow({
  draft,
  selected,
  opened,
  older,
  automationName,
  channelName,
  text,
  request,
  onSelect,
}: {
  draft: AutomationDraft;
  selected: boolean;
  /** Its thread is open in the pane right now. */
  opened: boolean;
  older: boolean;
  automationName?: string;
  channelName: (id: string) => string;
  text?: string;
  /** The Slack request it answers: one PR of a group under a request head, or a request of one. */
  request?: RowRequest;
  onSelect: () => void;
}) {
  const review = draft.kind === "pr_review";
  const asking = isAsk(draft);
  const Icon = asking ? MessageCircleQuestion : review ? GitPullRequest : CalendarClock;
  const open = review ? openFindings(draft) : 0;
  const verdict = review ? draft.content?.reply?.verdict : undefined;
  // Who asked is the request's; a PR nobody asked for in Slack says which automation made it.
  const where = review
    ? (request ? "" : (automationName ?? ""))
    : draft.result?.channel
      ? `#${channelName(draft.result.channel)}`
      : "";
  const preview = asking ? previewLine(draft.ask?.question ?? "") : review ? reviewPreview(draft) : previewLine(text ?? draft.result?.text ?? "");
  return (
    <li
      id={optionId(draft.id)}
      className="au-triage-row"
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-opened={opened || undefined}
      data-request={request?.in}
      data-last={request?.in === "group" && request.last ? "" : undefined}
      onClick={onSelect}
    >
      {request?.in === "single" ? (
        <RequesterAvatar id={request.id} who={request.who} known={request.known} you={request.you} size={16} />
      ) : (
        <Icon size={14} className="au-triage-icon" aria-hidden />
      )}
      <span className="au-triage-title">
        {request ? shortPr(draft) : draft.subject}
        {request?.in === "single" ? <span className="au-triage-from"> from {request.who}</span> : null}
      </span>
      <time className="au-triage-when" dateTime={new Date(draft.createdAtMs).toISOString()}>
        {formatShortWhen(draft.createdAtMs)}
      </time>
      <span className="au-triage-meta">
        {asking ? <span className="au-triage-tag au-triage-tag--ask">Needs your answer</span> : null}
        {draft.status === "sending" ? <span className="au-triage-tag au-triage-tag--quiet">Sending</span> : null}
        {verdict ? <span className="au-triage-verdict" data-verdict={verdict}>{VERDICT[verdict]}</span> : null}
        {review && isReReview(draft) ? <span className="au-triage-tag au-triage-tag--quiet">Re-review</span> : null}
        {open > 0 ? <span className="au-triage-open-count">{open} open</span> : null}
        {older ? <span className="au-triage-tag">Older run</span> : null}
        {where}
      </span>
      {preview ? <span className="au-triage-preview">{preview}</span> : null}
      {/* The row itself is the control; this only says what a press does, as Slack's hover bar. */}
      <span className="au-triage-open" aria-hidden>
        <MessagesSquare size={13} strokeWidth={1.75} />
        {asking ? "Answer" : opened ? "Open" : "Open thread"}
      </span>
    </li>
  );
}

/**
 * One waiting row of the Dock's quiet list (`.pen` 16 v2, 16a): where it came from and when, one
 * line of what it is, one status in words. A 6px dot carries the kind; nothing else is permanent —
 * "Open ↵" shows only on hover or keyboard focus.
 */
function QuietRow({
  draft,
  selected,
  opened,
  older,
  automationName,
  channelName,
  onSelect,
}: {
  draft: AutomationDraft;
  selected: boolean;
  opened: boolean;
  older: boolean;
  automationName?: string;
  channelName: (id: string) => string;
  onSelect: () => void;
}) {
  const status = rowStatus(draft, { channelName, older });
  const c = draft.content;
  const where = c ? `${c.repo}#${c.number}` : draft.result?.channel ? `#${channelName(draft.result.channel)}` : null;
  const source = [automationName, where].filter(Boolean).join(" · ");
  const title = isAsk(draft) ? previewLine(draft.ask?.question ?? "", 120) || draft.subject : draft.subject;
  return (
    <li
      id={optionId(draft.id)}
      className="au-qrow"
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-opened={opened || undefined}
      data-tone={status.tone}
      onClick={onSelect}
    >
      <span className="au-qrow-meta">
        <span className="au-qrow-dot" aria-hidden />
        <span className="au-qrow-source">{source}</span>
        <time className="au-qrow-when" dateTime={new Date(draft.createdAtMs).toISOString()}>
          {formatShortWhen(draft.createdAtMs)}
        </time>
      </span>
      <span className="au-qrow-title">{title}</span>
      <span className="au-qrow-foot">
        <span className="au-qrow-status">{status.text}</span>
        <span className="au-qrow-open" aria-hidden>
          {isAsk(draft) ? "Answer" : "Open"} <kbd>↵</kbd>
        </span>
      </span>
    </li>
  );
}

export function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (total <= shown) return null;
  return (
    <button type="button" className="au-link au-show-more" onClick={onMore}>
      Show all {total}
    </button>
  );
}
