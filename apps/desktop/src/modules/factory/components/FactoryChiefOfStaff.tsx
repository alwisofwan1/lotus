"use client";

import { useEffect, useState } from "react";
import { EmptyState } from "@/components/resource/resource-kit";
import { FACTORY_FEEDBACK_LABELS, type FactoryFeedbackItem, type FactoryFeedbackLabel } from "@/lib/tauri/graph-run";
import {
  FACTORY_CHIEF_ACTION_LABEL,
  FACTORY_FEEDBACK_LABEL_TEXT,
  factoryAmendmentLine,
  factoryChiefLog,
  factoryCriteriaLines,
  factoryAnswerable,
  factoryReplyDrafts,
  factoryFeedbackNeedingYou,
  factoryFeedbackNotCounted,
  factoryFeedbackPlace,
  factoryChiefStripLine,
  factoryProposedCriteria,
  factoryRoundBlocked,
  factorySpecChangeOpen,
  type FactoryChiefAction,
  type FactoryChiefInbox,
  type FactoryChiefItem,
  type FactoryReplyDraft,
} from "../services/factory-chief";
import { factoryRefLabel } from "../services/factory-run";
import type { FactoryRunActions } from "./FactoryRunDetailPane";
import { DitherPixels, EmptyDither } from "./FactoryDither";
import "@/styles/factory-chief.css";

/**
 * The Chief of Staff on the Factory page (ADR-0056, "Chief of Staff UI"): a count and a line on its
 * tab, and its own pane with one inbox, the selected item, and that run's log under it. The pane
 * only proposes: every action is the user's click.
 */

/**
 * The Chief of Staff's one line ("1 needs you · checked 3 min ago"), for its tab's tooltip and
 * screen-reader hint. `now` is injectable for tests; live, a tick every 30 s.
 */
export function useFactoryChiefLine(needsYou: number, prsInReview: number, checkedAt: number | null | undefined, now?: number): string | null {
  // `undefined`: no Chief of Staff runs here, so no line and no clock.
  const clock = useSlowClock(checkedAt !== undefined && now === undefined);
  return checkedAt === undefined ? null : factoryChiefStripLine(needsYou, checkedAt, now ?? clock, prsInReview);
}

/** What the pane's buttons call. Each is the user's click; a missing one hides its button. */
export interface FactoryChiefHandlers {
  actions?: Pick<FactoryRunActions, "raiseCap" | "abort">;
  /** Opens the run's detail, where the user answers, approves or reads it. */
  onOpenRun?: (key: string) => void;
  /** Opens the run's worktree in Finder. */
  onOpenWorktree?: (runId: string) => Promise<void>;
  /** Sets a Feedback Item's label (CoS 5). Missing = the labels are read-only. */
  onSetFeedbackLabel?: (runId: string, itemId: string, label: FactoryFeedbackLabel) => Promise<void>;
  /** Starts the next Revision Run on the PR (CoS 6). Missing = no Start round button. */
  onStartRound?: (runId: string) => Promise<unknown>;
  /** Accepts a spec change as new criteria on the approved spec (CoS 8). Missing = no Accept. */
  onAcceptSpecChange?: (runId: string, itemId: string, criteria: string[]) => Promise<void>;
  /** Declines a spec change as out of scope; a reply is drafted (CoS 8). Missing = no Decline. */
  onDeclineSpecChange?: (runId: string, itemId: string) => Promise<void>;
  /** Sets a reply draft's text, or a question's answer (CoS 9). Missing = drafts are read-only. */
  onEditDraft?: (runId: string, key: string, text: string) => Promise<void>;
  /** Send: posts one draft as the user (CoS 9). Missing = no Send. */
  onSendDraft?: (runId: string, key: string) => Promise<void>;
  /** Send all: every draft, then the re-request of review (CoS 9). Missing = no Send all. */
  onSendAll?: (runId: string) => Promise<void>;
  /** Answers "Who is GitHub @x on Slack?" with a member ID (CoS 12). Missing = not asked here. */
  onSetSlackIdentity?: (github: string, slack: string) => Promise<void>;
}

export function FactoryChiefPane({
  inbox,
  actions,
  onOpenRun,
  onOpenWorktree,
  onSetFeedbackLabel,
  onStartRound,
  onAcceptSpecChange,
  onDeclineSpecChange,
  onEditDraft,
  onSendDraft,
  onSendAll,
  onSetSlackIdentity,
  focusKey,
  now,
}: FactoryChiefHandlers & {
  inbox: FactoryChiefInbox;
  now: number;
  /** The run whose item to select, by its row key: the Tasks card's "Open in Chief of Staff" (CoS 10). */
  focusKey?: string | null;
}) {
  const handlers = { actions, onOpenRun, onOpenWorktree, onSetFeedbackLabel, onStartRound, onAcceptSpecChange, onDeclineSpecChange, onEditDraft, onSendDraft, onSendAll, onSetSlackIdentity };
  const [selected, setSelected] = useState<string | null>(focusKey ?? null);
  // A new focus selects its item; adjusted while rendering, as the Factory's own focus is.
  const [seenFocus, setSeenFocus] = useState(focusKey);
  if (focusKey !== seenFocus) {
    setSeenFocus(focusKey);
    if (focusKey) setSelected(focusKey);
  }
  const item = inbox.needsYou.find((i) => i.key === selected) ?? inbox.needsYou[0] ?? null;
  if (inbox.needsYou.length === 0 && inbox.watching.length === 0) {
    return <EmptyState art={<EmptyDither />}>Nothing to watch. The Chief of Staff looks at every Factory Run once a minute.</EmptyState>;
  }
  return (
    <div className="fa-chief">
      <div className="fa-chief-inbox" aria-label="Chief of Staff inbox">
        <h3 className="fa-chief-heading">Needs you</h3>
        {inbox.needsYou.length === 0 ? (
          <p className="fa-chief-quiet">
            <span className="fa-chief-quiet-mark" aria-hidden>
              <DitherPixels status="done" pixel={2} />
            </span>
            Nothing needs you.
          </p>
        ) : (
          <ul className="fa-chief-list">
            {inbox.needsYou.map((i) => (
              <li key={`${i.key}:${i.signal}`}>
                <button
                  type="button"
                  className="fa-chief-item"
                  data-selected={item?.key === i.key && item.signal === i.signal}
                  onClick={() => setSelected(i.key)}
                >
                  <span className="fa-chief-item-title">
                    {factoryRefLabel(i.row.issue)} {i.row.title}
                  </span>
                  <span className="fa-chief-item-reason">{i.reason}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {inbox.watching.length > 0 ? (
          <>
            <h3 className="fa-chief-heading">Nothing to do</h3>
            <ul className="fa-chief-list">
              {inbox.watching.map((row) => (
                <li key={row.id} className="fa-chief-watching">
                  {factoryRefLabel(row.issue)} {row.title}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      <div className="fa-chief-detail" aria-label="Selected item">
        {item ? <ChiefDetail key={`${item.row.id}:${item.signal}`} item={item} handlers={handlers} now={now} /> : null}
      </div>
    </div>
  );
}

/** The click behind each action, or null when this pane was given no way to do it. */
function doer(action: FactoryChiefAction, item: FactoryChiefItem, h: FactoryChiefHandlers): (() => Promise<void> | void) | null {
  switch (action) {
    case "raise-cap":
      return h.actions ? () => h.actions!.raiseCap(item.row.id).then(() => undefined) : null;
    case "abort":
      return h.actions ? () => h.actions!.abort(item.row.id) : null;
    case "open-run":
      return h.onOpenRun ? () => h.onOpenRun!(item.key) : null;
    case "open-worktree":
      return h.onOpenWorktree ? () => h.onOpenWorktree!(item.row.id) : null;
    case "start-round":
      return h.onStartRound ? () => h.onStartRound!(item.row.id).then(() => undefined) : null;
  }
}

function ChiefDetail({ item, handlers, now }: { item: FactoryChiefItem; handlers: FactoryChiefHandlers; now: number }) {
  const [busy, setBusy] = useState<FactoryChiefAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offered = item.actions.flatMap((action) => {
    const act = doer(action, item, handlers);
    return act ? [{ action, act }] : [];
  });
  const roundBlocked = item.signal === "feedback" ? factoryRoundBlocked(item.row) : null;
  const run = async (action: FactoryChiefAction, act: () => Promise<void> | void) => {
    setBusy(action);
    setError(null);
    try {
      await act();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <h3 className="fa-chief-detail-title">
        {factoryRefLabel(item.row.issue)} {item.row.title}
      </h3>
      <p className="fa-chief-detail-repo">{item.row.repo}</p>
      <p className="fa-chief-detail-reason">{item.reason}</p>
      {item.signal === "feedback" ? <FeedbackBatch item={item} handlers={handlers} onError={setError} /> : null}
      {offered.length > 0 ? (
        <div className="fa-chief-actions">
          {offered.map(({ action, act }) => {
            const blocked = action === "start-round" ? roundBlocked : null;
            return (
              <button
                key={action}
                type="button"
                className={action === "abort" ? "rs-button fa-chief-danger" : "rs-button"}
                disabled={busy !== null || blocked !== null}
                title={blocked ?? undefined}
                onClick={() => void run(action, act)}
              >
                {busy === action ? "…" : FACTORY_CHIEF_ACTION_LABEL[action]}
              </button>
            );
          })}
        </div>
      ) : null}
      {roundBlocked && offered.some((o) => o.action === "start-round") ? <p className="fa-chief-quiet">{roundBlocked}</p> : null}
      {error ? (
        <p className="fa-chief-error" role="alert">
          {error}
        </p>
      ) : null}
      <h4 className="fa-chief-heading">Log</h4>
      <ol className="fa-chief-log">
        {factoryChiefLog(item.row).map((entry, i) => (
          <li key={i}>
            <span className="fa-chief-log-at">{ago(entry.at, now)}</span>
            <span>{entry.text}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

/** The PR's feedback that waits for the user, each label editable; then what does not count. */
function FeedbackBatch({
  item,
  handlers,
  onError,
}: {
  item: FactoryChiefItem;
  handlers: FactoryChiefHandlers;
  onError: (message: string | null) => void;
}) {
  const onSetLabel = handlers.onSetFeedbackLabel;
  const waiting = factoryFeedbackNeedingYou(item.row);
  const others = factoryFeedbackNotCounted(item.row);
  const drafts = factoryReplyDrafts(item.row);
  const relabel = async (feedback: FactoryFeedbackItem, label: FactoryFeedbackLabel) => {
    onError(null);
    try {
      await onSetLabel?.(item.row.id, feedback.id, label);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <h4 className="fa-chief-heading">Feedback</h4>
      <ul className="fa-chief-feedback" aria-label="Feedback batch">
        {waiting.map((feedback) => (
          <li key={feedback.id} className="fa-chief-feedback-item" data-unsure={feedback.unsure ? true : undefined}>
            <span className="fa-chief-feedback-meta">
              Batch {feedback.batch} · {feedback.author} · {factoryFeedbackPlace(feedback)}
            </span>
            <span className="fa-chief-feedback-body">{feedback.body}</span>
            {feedback.labelBy === "rule" ? (
              <span className="fa-chip">{FACTORY_FEEDBACK_LABEL_TEXT.change} (CI)</span>
            ) : (
              <select
                className="fa-chief-feedback-label"
                aria-label={`Label for ${feedback.id}`}
                value={feedback.label ?? ""}
                disabled={!onSetLabel}
                onChange={(e) => void relabel(feedback, e.target.value as FactoryFeedbackLabel)}
              >
                {feedback.label ? null : <option value="">No label</option>}
                {FACTORY_FEEDBACK_LABELS.map((label) => (
                  <option key={label} value={label}>
                    {FACTORY_FEEDBACK_LABEL_TEXT[label]}
                  </option>
                ))}
              </select>
            )}
            {feedback.unsure ? <span className="fa-chief-feedback-unsure">Unsure: {feedback.unsure}</span> : null}
            {factorySpecChangeOpen(feedback) ? <SpecChangeDecision runId={item.row.id} feedback={feedback} handlers={handlers} onError={onError} /> : null}
            {factoryAnswerable(feedback) && handlers.onEditDraft ? <AnswerQuestion runId={item.row.id} feedback={feedback} onEditDraft={handlers.onEditDraft} onError={onError} /> : null}
            {feedback.amendment !== undefined ? <span className="fa-chip">{factoryAmendmentLine(item.row, feedback) ?? `Amendment ${feedback.amendment}`}</span> : null}
            {feedback.status === "declined" || feedback.status === "not-addressed" ? (
              <span className="fa-chief-feedback-unsure">
                {feedback.status === "declined" ? "Declined" : "Not addressed"}
                {feedback.why ? `: ${feedback.why}` : ""}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {drafts.length > 0 ? <ReplyDrafts runId={item.row.id} drafts={drafts} handlers={handlers} onError={onError} /> : null}
      {others.length > 0 ? (
        <>
          <h4 className="fa-chief-heading">Not from a reviewer</h4>
          <ul className="fa-chief-feedback" aria-label="Feedback that does not count">
            {others.map((feedback) => (
              <li key={feedback.id} className="fa-chief-feedback-item" data-counts="false">
                <span className="fa-chief-feedback-meta">
                  {feedback.author} · {factoryFeedbackPlace(feedback)}
                </span>
                <span className="fa-chief-feedback-body">{feedback.body}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

/**
 * Accept or Decline on a spec change (CoS 8). Accept first shows the proposed criteria, one per
 * line, for the user to edit; they become an Amendment on the approved spec. Decline drafts an
 * out-of-scope reply; nothing is posted.
 */
function SpecChangeDecision({
  runId,
  feedback,
  handlers,
  onError,
}: {
  runId: string;
  feedback: FactoryFeedbackItem;
  handlers: FactoryChiefHandlers;
  onError: (message: string | null) => void;
}) {
  const [criteria, setCriteria] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { onAcceptSpecChange, onDeclineSpecChange } = handlers;
  if (!onAcceptSpecChange && !onDeclineSpecChange) return null;
  const run = async (act: () => Promise<void>) => {
    setBusy(true);
    onError(null);
    try {
      await act();
      setCriteria(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (criteria !== null && onAcceptSpecChange) {
    const lines = factoryCriteriaLines(criteria);
    return (
      <div className="fa-chief-spec-change">
        <label className="fa-chief-feedback-meta" htmlFor={`criteria-${feedback.id}`}>
          New criteria, one per line. They are added to the approved spec; the next round builds them.
        </label>
        <textarea
          id={`criteria-${feedback.id}`}
          className="fa-textarea fa-chief-criteria"
          rows={3}
          value={criteria}
          disabled={busy}
          onChange={(e) => setCriteria(e.target.value)}
        />
        <div className="fa-chief-actions">
          <button type="button" className="rs-button" disabled={busy || lines.length === 0} onClick={() => void run(() => onAcceptSpecChange(runId, feedback.id, lines))}>
            {busy ? "…" : "Add to spec"}
          </button>
          <button type="button" className="rs-button" disabled={busy} onClick={() => setCriteria(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="fa-chief-actions">
      {onAcceptSpecChange ? (
        <button type="button" className="rs-button" disabled={busy} onClick={() => setCriteria(factoryProposedCriteria(feedback))}>
          Accept…
        </button>
      ) : null}
      {onDeclineSpecChange ? (
        <button type="button" className="rs-button" disabled={busy} onClick={() => void run(() => onDeclineSpecChange(runId, feedback.id))}>
          {busy ? "…" : "Decline"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The reply drafts and round summaries not sent yet (CoS 9). Each is editable in place and has its
 * own Send; Send all at the bottom posts them all and asks the reviewers again. Nothing is posted
 * without a click, except under `replies = "auto-addressed"`, which the app does by itself.
 */
function ReplyDrafts({
  runId,
  drafts,
  handlers,
  onError,
}: {
  runId: string;
  drafts: FactoryReplyDraft[];
  handlers: FactoryChiefHandlers;
  onError: (message: string | null) => void;
}) {
  const { onEditDraft, onSendDraft, onSendAll, onSetSlackIdentity } = handlers;
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, act: () => Promise<void>) => {
    setBusy(key);
    onError(null);
    try {
      await act();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  /** Saves the drafts the user changed, so a Send posts what the box shows. */
  const saveEdits = async (keys: string[]) => {
    for (const key of keys) {
      const text = edits[key];
      const draft = drafts.find((d) => d.key === key);
      if (text === undefined || !draft || text === draft.text || !onEditDraft) continue;
      await onEditDraft(runId, key, text);
    }
    setEdits((all) => Object.fromEntries(Object.entries(all).filter(([key]) => !keys.includes(key))));
  };
  return (
    <>
      <h4 className="fa-chief-heading">Drafted replies</h4>
      <ul className="fa-chief-feedback" aria-label="Drafted replies">
        {drafts.map((draft) => (
          <li key={draft.key} className="fa-chief-feedback-item">
            <span className="fa-chief-feedback-meta">{draft.meta} · not sent</span>
            {onEditDraft ? (
              <textarea
                className="fa-textarea fa-chief-criteria"
                aria-label={`Draft for ${draft.key}`}
                rows={2}
                value={edits[draft.key] ?? draft.text}
                disabled={busy !== null}
                onChange={(e) => setEdits((all) => ({ ...all, [draft.key]: e.target.value }))}
                onBlur={() => void run(draft.key, () => saveEdits([draft.key]))}
              />
            ) : (
              <span className="fa-chief-feedback-body">{draft.text}</span>
            )}
            {onSetSlackIdentity
              ? (draft.unknownPeople ?? []).map((github) => <SlackIdentityQuestion key={github} github={github} onSave={onSetSlackIdentity} onError={onError} />)
              : null}
            {onSendDraft ? (
              <div className="fa-chief-actions">
                <button
                  type="button"
                  className="rs-button"
                  aria-label={`Send ${draft.key}`}
                  disabled={busy !== null || !(edits[draft.key] ?? draft.text).trim()}
                  onClick={() => void run(draft.key, async () => {
                    await saveEdits([draft.key]);
                    await onSendDraft(runId, draft.key);
                  })}
                >
                  {busy === draft.key ? "…" : "Send"}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {onSendAll ? (
        <div className="fa-chief-actions">
          <button
            type="button"
            className="rs-button"
            disabled={busy !== null}
            title="Posts every draft as you, then asks the reviewers whose comments were addressed to review again"
            onClick={() => void run("all", async () => {
              await saveEdits(drafts.map((d) => d.key));
              await onSendAll(runId);
            })}
          >
            {busy === "all" ? "…" : "Send all"}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** "Who is GitHub @x on Slack?": the reviewer's Slack member ID, asked once and remembered (CoS 12). */
function SlackIdentityQuestion({
  github,
  onSave,
  onError,
}: {
  github: string;
  onSave: (github: string, slack: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    onError(null);
    try {
      await onSave(github, id.trim());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fa-chief-actions">
      <input
        className="fa-input"
        aria-label={`Who is GitHub @${github} on Slack?`}
        placeholder={`@${github}'s Slack member ID, like U07ABC123`}
        title="In Slack: their profile → ⋮ → Copy member ID"
        value={id}
        disabled={busy}
        onChange={(e) => setId(e.target.value)}
      />
      <button type="button" className="rs-button" aria-label={`Save @${github}`} disabled={busy || !id.trim()} onClick={() => void save()}>
        {busy ? "…" : "Save"}
      </button>
    </div>
  );
}

/** "Answer…" on a question: the user writes the answer, which becomes a draft to Send (CoS 9). */
function AnswerQuestion({
  runId,
  feedback,
  onEditDraft,
  onError,
}: {
  runId: string;
  feedback: FactoryFeedbackItem;
  onEditDraft: (runId: string, key: string, text: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (answer === null) {
    return (
      <div className="fa-chief-actions">
        <button type="button" className="rs-button" onClick={() => setAnswer("")}>
          Answer…
        </button>
      </div>
    );
  }
  const save = async () => {
    setBusy(true);
    onError(null);
    try {
      await onEditDraft(runId, feedback.id, answer);
      setAnswer(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fa-chief-spec-change">
      <label className="fa-chief-feedback-meta" htmlFor={`answer-${feedback.id}`}>
        Your answer to {feedback.author}. It waits in Drafted replies until you press Send.
      </label>
      <textarea id={`answer-${feedback.id}`} className="fa-textarea fa-chief-criteria" rows={3} value={answer} disabled={busy} onChange={(e) => setAnswer(e.target.value)} />
      <div className="fa-chief-actions">
        <button type="button" className="rs-button" disabled={busy || !answer.trim()} onClick={() => void save()}>
          {busy ? "…" : "Save answer"}
        </button>
        <button type="button" className="rs-button" disabled={busy} onClick={() => setAnswer(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes === 0) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/** "checked N min ago" needs no second hand: a tick every 30 s, and none at all in tests. */
function useSlowClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
