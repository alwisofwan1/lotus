"use client";

import { Check, ChevronDown, ExternalLink, GitPullRequest, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { MenuItem, MenuLabel, MenuSeparator, Pill, ResourceMenu } from "@/components/resource/resource-kit";
import { GitHubMark, SlackMark } from "@/components/icons/ServiceMarks";

import type { AutomationClient, AutomationDraft, EditedReview, ReviewComment, Severity, SlackPreview, Verdict } from "../services/automation-api";
import { formatShortWhen, formatWhen } from "../services/format";
import { ReviewText } from "./ReviewText";
import { ReviewDecision } from "./ReviewDecision";
import { RequesterAvatar } from "./Requester";
import { SlackText, SlackUserNames } from "./SlackText";

/**
 * A review draft waiting for its reviewer. It reads like the review GitHub will show; any part can
 * be edited in place until Send. "Send to" picks the destinations — GitHub (Comment or Approve) and
 * the Slack thread — and the one Send button names them. Approve is never chosen for the reviewer.
 */

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "stale"; reviewed: string; current: string }
  | { kind: "sent"; url: string; slackReply: string | null; github: "approved" | "commented" | "skipped" }
  | { kind: "error"; message: string };

/** Where a review goes, remembered per automation. Approve is never remembered. */
type SendTo = { github: boolean; slack: boolean };
const sendToKey = (automationId: string) => `lotus.automation.send-to.${automationId}`;
export function readSendTo(automationId: string): SendTo {
  try {
    const saved = JSON.parse(localStorage.getItem(sendToKey(automationId)) ?? "null");
    if (typeof saved?.github === "boolean" && typeof saved?.slack === "boolean") return { github: saved.github, slack: saved.slack };
  } catch { /* No storage here: the defaults. */ }
  return { github: true, slack: true };
}
function writeSendTo(automationId: string, sendTo: SendTo) {
  try {
    localStorage.setItem(sendToKey(automationId), JSON.stringify(sendTo));
  } catch { /* Not remembered; this card still uses it. */ }
}

/** The Send button names where the review goes. */
export function sendLabel(github: boolean, approve: boolean, slack: boolean): string {
  if (!github) return slack ? "Reply in Slack" : "Choose where to send";
  if (approve) return slack ? "Approve & reply in Slack" : "Approve on GitHub";
  return slack ? "Send review & reply in Slack" : "Comment on GitHub";
}

/**
 * One quiet sentence of where Send puts the review (16b v2): "GitHub comment as alwi · #eng thread".
 * The button says what happens; this says where.
 */
export function whereItGoes({ github, approve, slack, account, channel }: { github: boolean; approve: boolean; slack: boolean; account?: string | null; channel?: string | null }): string {
  const parts = [
    github ? `GitHub ${approve ? "approval" : "comment"}${account ? ` as ${account}` : ""}` : null,
    slack ? `${channel ?? "Slack"} thread` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nowhere yet: pick GitHub or the Slack thread";
}

const DISCARD_REASONS = ["Wrong findings", "Too nitpicky", "Already reviewed", "PR changed"];

/** What is open for editing: the summary, one comment by index, or nothing. */
type Editing = "summary" | number | null;

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const SEVERITIES: { value: Severity; label: string }[] = [
  { value: "blocker", label: "Blocker" },
  { value: "should-fix", label: "Should fix" },
  { value: "question", label: "Question" },
  { value: "suggestion", label: "Suggestion" },
];

const EARLIER: Record<string, string> = { fixed: "Fixed", answered: "Answered", "not-fixed": "Still open" };
const MAX_POINTS = 2;
/** The host's limit on a rewritten Slack message (`slack_reply::MAX_EDITED_CHARS`). */
const MAX_SLACK_CHARS = 4000;

/** Tall enough for the text it holds, so nothing scrolls inside the box. */
export const rowsFor = (text: string, min: number) => Math.max(min, text.split("\n").length + 1);

export function DraftCard({
  draft,
  client,
  automationName,
  account,
  channelName,
  requester,
  siblings = [],
  onOpenSibling,
  quiet = false,
}: {
  draft: AutomationDraft;
  client: AutomationClient;
  automationName?: string;
  /** The GitHub login the review posts as. */
  account?: string | null;
  /** The name of the Slack channel the request came from, when known. */
  channelName?: string;
  /** Who asked for it in Slack (`requesterLabel`), for a draft from a Slack request. */
  requester?: { who: string; known: boolean; you: boolean };
  /** The waiting PRs of the same Slack request, this one included, in the order they were asked. */
  siblings?: { id: string; label: string; verdict?: Verdict }[];
  onOpenSibling?: (id: string) => void;
  /**
   * The Dock's quiet list (`.pen` 16 v2, 16b): the verdict is one chip, findings are lines, and
   * where it goes lives behind Send's caret with one sentence saying it.
   */
  quiet?: boolean;
}) {
  const content = draft.content;
  const [previewing, setPreviewing] = useState(false);
  const [summary, setSummary] = useState(content?.summary ?? "");
  const [comments, setComments] = useState<ReviewComment[]>(content?.comments ?? []);
  const [editing, setEditing] = useState<Editing>(null);
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  // A draft not from Slack has only GitHub to go to.
  const [sendTo, setSendToState] = useState<SendTo>(() => {
    const saved = readSendTo(draft.automationId);
    return draft.slack ? (saved.github || saved.slack ? saved : { github: true, slack: true }) : { github: true, slack: false };
  });
  const setSendTo = (next: SendTo) => {
    setSendToState(next);
    if (draft.slack) writeSendTo(draft.automationId, next);
  };
  const github = sendTo.github;
  const replyInThread = draft.slack !== null && sendTo.slack;
  const [points] = useState<string[]>(() =>
    Array.from({ length: MAX_POINTS }, (_, i) => content?.reply?.points[i] ?? ""),
  );
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Comment by default; Approve only when the reviewer picks it. A stale override never approves.
  const [approving, setApproving] = useState(false);
  const [closeThreads, setCloseThreads] = useState(true);
  const [verdict, setVerdict] = useState<Verdict>(content?.reply?.verdict ?? "looks-good");
  const [decisionChosen, setDecisionChosen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  // The Slack thread's message as Lotus renders it from the saved draft, and the reviewer's own
  // rewrite of it (null: not rewritten). Re-read after each save (ADR-0052 §8).
  const [slackPreview, setSlackPreview] = useState<SlackPreview | null>(null);
  const [slackText, setSlackText] = useState<string | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const groupSize = draft.slackGroup ?? 0;
  useEffect(() => {
    if (!draft.slack || !content) return;
    let live = true;
    client
      .slackPreview(draft.id, groupSize > 1)
      .then((p) => live && setSlackPreview(p))
      .catch(() => live && setSlackPreview(null));
    return () => {
      live = false;
    };
  }, [client, draft.id, draft.slack, content, groupSize, previewTick]);

  if (!content) {
    return (
      <article className="au-draft" aria-label={draft.subject}>
        <p className="au-note">This draft is of a kind this panel cannot show yet ({draft.kind}).</p>
      </article>
    );
  }

  // Suggestions never raise the minimum; a comment without a severity counts as a question.
  const previous = content.previous ?? [];
  const mustFix = (s?: Severity | null) => s === "blocker" || s === "should-fix";
  const offDiffHolds = content.offDiffSeverities ? content.offDiffSeverities.some((s) => s !== "suggestion") : content.droppedComments > 0;
  const openEarlier = previous.some((p) => p.status === "not-fixed" && p.severity !== "suggestion");
  const holding = comments.filter((c) => c.severity !== "suggestion");
  const minimum: Verdict = offDiffHolds || openEarlier || comments.some((c) => mustFix(c.severity))
    ? "changes-needed" : holding.length > 0 ? "questions" : "looks-good";
  // LGTM over line findings may turn them into suggestions, when nothing else holds it back.
  const downgradable = offDiffHolds || openEarlier ? 0 : holding.length;
  const effectiveVerdict: Verdict = minimum === "changes-needed" || verdict === "changes-needed" ? "changes-needed"
    : minimum === "questions" || verdict === "questions" ? "questions" : "looks-good";
  const reply = { verdict: effectiveVerdict, points: effectiveVerdict === "looks-good" ? [] : points.map((p) => p.trim()).filter(Boolean) };
  const edited = (): EditedReview => draft.slack || decisionChosen ? { summary, comments, reply } : { summary, comments };
  const save = (review: EditedReview = edited()) => {
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const saved = await client.updateDraft(draft.id, review);
        setSaveError(saved ? null : "Could not save: this draft is no longer editable.");
        if (saved) setPreviewTick((t) => t + 1);
      } catch (error) {
        setSaveError(`Could not save your edits. They are still here. ${String(error)}`);
      }
    });
  };
  const setSeverity = (index: number, severity: Severity | undefined) => {
    const next = comments.map((c, i) => {
      if (i !== index) return c;
      const rest = { ...c };
      delete rest.severity;
      return severity ? { ...rest, severity } : rest;
    });
    setComments(next);
    save({ ...edited(), comments: next });
  };
  const finishEditing = () => {
    setEditing(null);
    save();
  };
  const editKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      event.stopPropagation();
      finishEditing();
    }
  };

  const submit = async (sendEvenIfStale: boolean, approve = approving && approvable) => {
    setEditing(null);
    setApproving(approve);
    setSend({ kind: "sending" });
    try {
      await saveQueue.current;
      const post: typeof client.sendDraft = approve ? client.approveDraft : client.sendDraft;
      const inSlack = replyInThread;
      const ownText = inSlack ? slackText : null;
      // Only what differs from the defaults is passed: close threads, own text, GitHub off.
      const tail: [boolean?, string?, boolean?] = [closable && github ? closeThreads : undefined, ownText ?? undefined, github ? undefined : false];
      while (tail.length && tail[tail.length - 1] === undefined) tail.pop();
      if (tail.length > 1 && tail[0] === undefined) tail[0] = false;
      const result = await post(draft.id, edited(), sendEvenIfStale, inSlack, ...tail);
      setSend(
        result.status === "sent"
          ? { kind: "sent", url: result.url, slackReply: result.slackReply ?? null, github: !github ? "skipped" : approve ? "approved" : "commented" }
          : { kind: "stale", ...result },
      );
    } catch (error) {
      setSend({ kind: "error", message: String(error) });
    }
  };

  // Every pending review in this Slack thread, then one reply (ADR-0052 §8).
  const sendAll = async () => {
    setEditing(null);
    setApproving(false);
    setSend({ kind: "sending" });
    try {
      await saveQueue.current;
      const closing = closable ? closeThreads : true;
      const results =
        replyInThread && slackText !== null
          ? await client.sendAll(draft.id, replyInThread, closing, slackText)
          : await client.sendAll(draft.id, replyInThread, closing);
      const own = results.find(([id]) => id === draft.id)?.[1];
      const failed = results.find(([, r]) => r.status !== "sent");
      if (own?.status === "stale") setSend({ kind: "stale", ...own });
      else if (failed) setSend({ kind: "error", message: `Stopped before every review was sent: ${failed[0]} moved since its review. Open it to send it anyway.` });
      else if (own?.status === "sent") {
        const last = results[results.length - 1][1];
        const slackReply = last.status === "sent" ? (last.slackReply ?? own.slackReply ?? null) : null;
        setSend({ kind: "sent", url: own.url, slackReply, github: "commented" });
      } else setSend({ kind: "error", message: "Nothing was sent." });
    } catch (error) {
      setSend({ kind: "error", message: String(error) });
    }
  };

  const discard = async (reason?: string) => {
    try {
      await (reason ? client.discardDraft(draft.id, reason) : client.discardDraft(draft.id));
    } catch (error) {
      setConfirmDiscard(false);
      setSend({ kind: "error", message: String(error) });
    }
  };

  const locked = send.kind === "sending" || send.kind === "sent";
  // A re-review's resolved earlier findings that have a GitHub thread to reply ✅ on.
  const closable = previous.filter((p) => p.status !== "not-fixed" && p.hasThread).length;
  // Approve only a review whose findings are all suggestions (ADR-0042), earlier findings resolved
  // and coverage complete; the engine checks the same again.
  const approvable = github && effectiveVerdict === "looks-good" && holding.length === 0 && content.coverage === "complete";
  const approve = approving && approvable;
  const nowhere = !github && !replyInThread;
  const channel = draft.slack ? `#${channelName ?? draft.slack.channel}` : null;
  // Reviews asked for in the same Slack thread, this one included: Send all is offered from two.
  // Send all posts on GitHub, so it needs GitHub on.
  const group = draft.slack && replyInThread && github ? (draft.slackGroup ?? 0) : 0;
  // The preview reads `<@U…>` as the person; the message still carries the id, so it pings.
  const mentionNames = new Map(draft.slack?.requester && requester?.known ? [[draft.slack.requester, requester.who]] : []);
  // Two buttons that both send need to say how they differ (`.pen` round 1, decision 4).
  const replyTo = requester && !requester.you && requester.known ? `reply to ${requester.who}` : "reply in Slack";
  const sendAllLabel = `${group === 2 ? "Send both" : `Send all ${group}`} + ${replyTo}`;

  return (
    <SlackUserNames.Provider value={mentionNames}>
    <article className="au-draft au-review-card" aria-label={draft.subject} data-quiet={quiet || undefined}>
      {quiet ? (
        <header className="au-qhead">
          <span className="au-qhead-meta">
            {content.repo}#{content.number} · reviewed at <code title={content.headSha}>{short(content.headSha)}</code>
            {channel ? ` · from ${channel}` : ""} · {formatWhen(draft.createdAtMs)}
          </span>
          <a className="au-qhead-title" href={content.url} target="_blank" rel="noreferrer">
            {draft.subject}
            <ExternalLink size={12} aria-hidden />
          </a>
        </header>
      ) : (
      <>
      {draft.slack && requester ? (
        <div className="au-request-strip">
          <RequesterAvatar id={draft.slack.requester} {...requester} />
          <span className="au-request-who">{requester.who}</span>
          <span className="au-request-what">
            asked for {siblings.length > 1 ? `${siblings.length} reviews` : "a review"} in {channel} · {formatShortWhen(draft.createdAtMs)}
          </span>
          {siblings.length > 1 ? (
            <span className="au-request-sibs" role="group" aria-label="Reviews in this request">
              {siblings.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="au-request-sib"
                  aria-pressed={s.id === draft.id}
                  data-verdict={s.verdict}
                  title={s.id === draft.id ? "Open now" : `Open ${s.label}`}
                  onClick={() => s.id !== draft.id && onOpenSibling?.(s.id)}
                >
                  {/* Only the repo's last word: "orbit-recording-desktop#146" → "desktop#146". */}
                  {s.label.replace(/^[^#]*?-(?=[^-#]*#)/, "")}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
      <header className="au-draft-head">
        <GitPullRequest size={15} className="au-draft-icon" aria-hidden />
        <div className="au-draft-heading">
          <a className="au-draft-title" href={content.url} target="_blank" rel="noreferrer">
            {draft.subject}
            <ExternalLink size={12} aria-hidden />
          </a>
          <span className="au-draft-meta">
            {automationName ? `${automationName} · ` : ""}
            {plural(comments.length, "comment")} · reviewed at <code title={content.headSha}>{short(content.headSha)}</code> ·{" "}
            {formatWhen(draft.createdAtMs)}
          </span>
        </div>
        {channel ? (
          requester ? null : (
            <Pill title={`Asked for in ${channel}`}>
              <SlackMark size={10} />
              {channel}
            </Pill>
          )
        ) : (
          <Pill title="Started with the Review button">Manual</Pill>
        )}
      </header>
      </>
      )}

      {quiet && content.coverage === "complete" ? null : (
      <p className="au-note au-coverage">
        <strong>{content.coverage === "complete" ? "Review complete" : content.coverage === "partial" ? "Partial review" : content.coverage === "blocked" ? "Review blocked" : "Coverage not recorded"}</strong>
        <span>{content.coverage === "complete" ? "Analysis finished. Check the summary for test evidence." : "You can send feedback. Formal approval needs a complete review."}</span>
      </p>
      )}

      <ReviewDecision variant={quiet ? "chip" : "segmented"} verdict={effectiveVerdict} minimum={minimum} locked={locked} downgradable={downgradable}
        onChange={(next) => {
          setVerdict(next);
          setDecisionChosen(true);
          save({ summary, comments, reply: { verdict: next, points: next === "looks-good" ? [] : reply.points } });
        }}
        onDowngrade={() => {
          const next = comments.map((c) => (c.severity === "suggestion" ? c : { ...c, severity: "suggestion" as const }));
          setComments(next);
          setVerdict("looks-good");
          setDecisionChosen(true);
          save({ summary, comments: next, reply: { verdict: "looks-good", points: [] } });
        }} />
      {saveError ? <p className="au-error" role="alert">{saveError} <button type="button" className="au-link" disabled={locked} onClick={() => save()}>Retry save</button></p> : null}

      {previous.length ? (
        <section className="au-review-part" aria-label="Since the last review">
          <div className="au-review-part-head">
            <span className="au-label">Since the last review ({short(content.sinceSha ?? "")})</span>
          </div>
          <ul className="au-earlier">
            {previous.map((p, i) => (
              <li key={i} className="au-earlier-item">
                <Pill tone={p.status === "not-fixed" ? "danger" : p.status === "fixed" ? "ok" : "accent"}>
                  {EARLIER[p.status] ?? p.status}
                </Pill>
                <code className="au-earlier-where">
                  {p.path}:{p.line}
                </code>
                <span className="au-earlier-body">
                  {p.body.split("\n")[0]}
                  {p.note ? <span className="au-hint"> — {p.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="au-review-part">
        <div className="au-review-part-head">
          <span className="au-label">Summary</span>
          {editing === "summary" ? (
            <EditDone onClick={finishEditing} />
          ) : (
            <EditButton label="Edit summary" disabled={locked} onClick={() => setEditing("summary")} />
          )}
        </div>
        {editing === "summary" ? (
          <textarea
            className="au-textarea au-review-input"
            aria-label="Summary"
            value={summary}
            rows={rowsFor(summary, 4)}
            autoFocus
            onChange={(e) => setSummary(e.target.value)}
            onBlur={() => save()}
            onKeyDown={editKeys}
          />
        ) : (
          <ReviewText empty="No summary. Only the line comments are posted.">{summary}</ReviewText>
        )}
      </section>

      <section className="au-review-part">
        <div className="au-review-part-head">
          <span className="au-label">
            {quiet ? plural(comments.length, "comment") : <>Line comments <span className="au-count">{comments.length}</span></>}
          </span>
        </div>
        {comments.length > 0 ? (
          <ol className="au-comments" aria-label="Line comments">
            {comments.map((comment, index) => {
              const where = `${comment.path}:${comment.line}`;
              const open = editing === index;
              return (
                <li key={`${where}-${index}`} className="au-comment" data-editing={open || undefined}>
                  <div className="au-comment-head">
                    <select
                      className="au-severity"
                      data-severity={comment.severity ?? "none"}
                      aria-label={`Severity of comment on ${where}`}
                      title="Written at the start of the comment on Send"
                      value={comment.severity ?? ""}
                      disabled={locked}
                      onChange={(e) => setSeverity(index, (e.target.value || undefined) as Severity | undefined)}
                    >
                      {SEVERITIES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                      <option value="">No severity</option>
                    </select>
                    <code className="au-comment-where" title={where}>
                      {where}
                    </code>
                    <span className="au-comment-actions">
                      {open ? (
                        <EditDone onClick={finishEditing} />
                      ) : (
                        <EditButton label={`Edit comment on ${where}`} disabled={locked} onClick={() => setEditing(index)} />
                      )}
                      <button
                        type="button"
                        className="rs-icon-button au-comment-remove"
                        disabled={locked}
                        aria-label={`Remove comment on ${where}`}
                        title="Remove comment"
                        onClick={() => {
                          setEditing(null);
                          const next = comments.filter((_, i) => i !== index);
                          setComments(next);
                          save({ ...edited(), comments: next });
                        }}
                      >
                        <X size={13} aria-hidden />
                      </button>
                    </span>
                  </div>
                  {open ? (
                    <textarea
                      className="au-textarea au-review-input"
                      aria-label={`Comment on ${where}`}
                      value={comment.body}
                      rows={rowsFor(comment.body, 3)}
                      autoFocus
                      onChange={(e) =>
                        setComments((prev) => prev.map((c, i) => (i === index ? { ...c, body: e.target.value } : c)))
                      }
                      onBlur={() => save()}
                      onKeyDown={editKeys}
                    />
                  ) : (
                    <ReviewText>{comment.body}</ReviewText>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="au-note">No line comments. Only the summary is posted.</p>
        )}
        {content.droppedComments > 0 ? (
          <p className="au-hint">
            {content.droppedComments} finding{content.droppedComments === 1 ? " was" : "s were"} not on the diff: {content.droppedComments === 1 ? "it is" : "they are"} in
            the summary, under “Not on the diff”.
          </p>
        ) : null}
      </section>

      {send.kind === "stale" ? (
        <div className="au-callout au-callout--warn" role="alert">
          <p>
            This pull request moved from {short(send.reviewed)} to {short(send.current)} since the review. Comments stay
            on the reviewed commit.
          </p>
          <button type="button" className="rs-button" onClick={() => void submit(true, false)}>
            Send anyway
          </button>
        </div>
      ) : null}
      {send.kind === "error" ? (
        <p className="au-error" role="alert">
          {send.message}
        </p>
      ) : null}

      <footer className="au-review-foot">
        {send.kind === "sent" ? (
          <div className="au-review-dest" role="status">
            {send.github === "skipped" ? (
              <span className="au-dest-row au-dest-muted">
                <GitHubMark size={12} />
                Not posted on GitHub
              </span>
            ) : (
              <span className="au-dest-row">
                <Check size={13} className="au-dest-ok" aria-hidden />
                <a className="au-sent" href={send.url} target="_blank" rel="noreferrer">
                  {send.github === "approved" ? "Approved on GitHub" : "Commented on GitHub"}
                </a>
              </span>
            )}
            {send.slackReply ? <SlackOutcome reply={send.slackReply} draftId={draft.id} client={client} /> : null}
          </div>
        ) : quiet ? (
          <div className="au-qfoot">
            {!github && comments.length > 0 ? (
              <p className="au-callout au-callout--warn" role="note">
                GitHub is off: the {plural(comments.length, "line comment")} {comments.length === 1 ? "is" : "are"} not posted anywhere.
              </p>
            ) : null}
            {replyInThread && previewing ? (
              <SlackMessage preview={slackPreview} text={slackText} group={group} alone={quiet ? "Send alone" : "“Send this review only”"} disabled={locked} onChange={setSlackText} />
            ) : null}
            {confirmDiscard ? (
              <span className="au-discard" role="group" aria-label="Discard this draft">
                <span className="au-note">Why discard? Optional.</span>
                {DISCARD_REASONS.map((reason) => (
                  <button key={reason} type="button" className="au-chip" onClick={() => void discard(reason)}>
                    {reason}
                  </button>
                ))}
                <button type="button" className="rs-button rs-button--ghost" onClick={() => setConfirmDiscard(false)}>
                  Keep
                </button>
                <button type="button" className="rs-button rs-button--danger" onClick={() => void discard()}>
                  Discard without reason
                </button>
              </span>
            ) : (
              <div className="au-qfoot-bar">
                <button type="button" className="au-qfoot-discard" disabled={locked} onClick={() => setConfirmDiscard(true)}>
                  Discard
                </button>
                <span className="au-qfoot-where">{whereItGoes({ github, approve, slack: replyInThread, account, channel })}</span>
                {group > 1 ? (
                  <button
                    type="button"
                    className="rs-button"
                    disabled={locked}
                    title="Send every review asked for in this Slack thread as a comment, then post one reply. Approve stays per PR."
                    onClick={() => void sendAll()}
                  >
                    Send all {group}
                  </button>
                ) : null}
                <div className="rs-split au-send-split">
                  <button type="button" className="rs-button rs-button--primary rs-split-main" disabled={locked || nowhere} onClick={() => void submit(false)}>
                    {send.kind === "sending" ? (approve ? "Approving…" : "Sending…") : sendLabel(github, approve, replyInThread)}
                  </button>
                  <ResourceMenu className="rs-split-menu" label="Where it goes" trigger={<ChevronDown size={14} aria-hidden />}>
                    <MenuLabel>{`GitHub${account ? ` as ${account}` : ""}`}</MenuLabel>
                    <MenuItem checked={github} keepOpen disabled={locked || !draft.slack} onSelect={() => setSendTo({ ...sendTo, github: !github })}>
                      Post on GitHub
                    </MenuItem>
                    {github ? (
                      <>
                        <MenuItem checked={!approve} keepOpen disabled={locked} onSelect={() => setApproving(false)}>
                          Comment
                        </MenuItem>
                        <MenuItem checked={approve} keepOpen disabled={locked || !approvable} onSelect={() => setApproving(true)}>
                          {approvable ? "Approve" : content.coverage !== "complete" ? "Approve · needs a complete review" : "Approve · needs LGTM, only suggestions left"}
                        </MenuItem>
                      </>
                    ) : null}
                    {github && closable ? (
                      <MenuItem checked={closeThreads} keepOpen disabled={locked} onSelect={() => setCloseThreads(!closeThreads)}>
                        Reply ✅ on {closable} resolved thread{closable === 1 ? "" : "s"}
                      </MenuItem>
                    ) : null}
                    <MenuSeparator />
                    {draft.slack ? (
                      <>
                        <MenuItem checked={replyInThread} keepOpen disabled={locked} onSelect={() => setSendTo({ ...sendTo, slack: !replyInThread })}>
                          {`Reply in the ${channel ?? "Slack"} thread`}
                        </MenuItem>
                        {replyInThread ? (
                          <MenuItem icon={<SlackMark size={11} />} onSelect={() => setPreviewing((was) => !was)}>
                            {previewing ? "Hide the Slack reply" : "Preview the Slack reply"}
                          </MenuItem>
                        ) : null}
                      </>
                    ) : (
                      <MenuLabel>No Slack thread: this PR was not asked for in Slack</MenuLabel>
                    )}
                  </ResourceMenu>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            <section className="au-send-to" aria-label="Send to">
              <span className="au-label">Send to</span>
              <div className="au-dest">
                <label className="au-switch">
                  <input
                    type="checkbox"
                    checked={github}
                    disabled={locked || !draft.slack}
                    onChange={(e) => setSendTo({ ...sendTo, github: e.target.checked })}
                  />
                  <span className="au-switch-track" aria-hidden />
                  <GitHubMark size={12} />
                  {`Post on GitHub${account ? ` as ${account}` : ""}`}
                </label>
                {github ? (
                  <div className="au-segmented au-segmented--small" role="group" aria-label="GitHub review">
                    <button type="button" className="au-segment" aria-pressed={!approve} disabled={locked} onClick={() => setApproving(false)}>
                      Comment
                    </button>
                    <button
                      type="button"
                      className="au-segment"
                      aria-pressed={approve}
                      disabled={locked || !approvable}
                      title={approvable ? "Formal approval on GitHub" : content.coverage !== "complete" ? "Approval needs a complete review" : "Approval needs LGTM, with only suggestions left"}
                      onClick={() => setApproving(true)}
                    >
                      Approve
                    </button>
                  </div>
                ) : null}
                {github && closable ? (
                  <label className="au-check au-dest-row">
                    <input type="checkbox" checked={closeThreads} disabled={locked} onChange={(e) => setCloseThreads(e.target.checked)} />
                    Reply ✅ on {closable} resolved GitHub thread{closable === 1 ? "" : "s"}
                  </label>
                ) : null}
              </div>
              {!github && comments.length > 0 ? (
                <p className="au-callout au-callout--warn" role="note">
                  GitHub is off: the {plural(comments.length, "line comment")} {comments.length === 1 ? "is" : "are"} not posted anywhere.
                </p>
              ) : null}
              {draft.slack ? (
                <div className="au-dest">
                  <label className="au-switch">
                    <input
                      type="checkbox"
                      checked={replyInThread}
                      disabled={locked}
                      onChange={(e) => setSendTo({ ...sendTo, slack: e.target.checked })}
                    />
                    <span className="au-switch-track" aria-hidden />
                    <SlackMark size={11} />
                    {`Reply in the Slack thread${channelName ? ` in #${channelName}` : ""}`}
                  </label>
                  {replyInThread ? (
                    <SlackMessage preview={slackPreview} text={slackText} group={group} alone={quiet ? "Send alone" : "“Send this review only”"} disabled={locked} onChange={setSlackText} />
                  ) : null}
                </div>
              ) : (
                <span className="au-dest-row au-dest-muted" title="Only a PR someone asked for in a watched Slack channel has a thread to reply to">
                  <SlackMark size={11} />
                  No Slack reply: this PR was not asked for in Slack
                </span>
              )}
            </section>
            <span className="au-draft-actions">
              {confirmDiscard ? (
                <span className="au-discard" role="group" aria-label="Discard this draft">
                  <span className="au-note">Why discard? Optional.</span>
                  {DISCARD_REASONS.map((reason) => (
                    <button key={reason} type="button" className="au-chip" onClick={() => void discard(reason)}>
                      {reason}
                    </button>
                  ))}
                  <button type="button" className="rs-button rs-button--ghost" onClick={() => setConfirmDiscard(false)}>
                    Keep
                  </button>
                  <button type="button" className="rs-button rs-button--danger" onClick={() => void discard()}>
                    Discard without reason
                  </button>
                </span>
              ) : (
                <>
                  <button type="button" className="rs-button rs-button--ghost" disabled={locked} onClick={() => setConfirmDiscard(true)}>
                    Discard
                  </button>
                  {group > 1 ? (
                    <>
                      <button
                        type="button"
                        className="rs-button"
                        disabled={locked || nowhere}
                        title="Posts this review on GitHub; the Slack reply waits until the other reviews of this request are sent."
                        onClick={() => void submit(false)}
                      >
                        {send.kind === "sending" ? (approve ? "Approving…" : "Sending…") : approve ? "Approve this review only" : "Send this review only"}
                      </button>
                      <button
                        type="button"
                        className="rs-button rs-button--primary"
                        disabled={locked}
                        title="Send every review asked for in this Slack thread as a comment, then post one reply. Approve stays per PR."
                        onClick={() => void sendAll()}
                      >
                        {sendAllLabel}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="rs-button rs-button--primary" disabled={locked || nowhere} onClick={() => void submit(false)}>
                      {send.kind === "sending" ? (approve ? "Approving…" : "Sending…") : sendLabel(github, approve, replyInThread)}
                    </button>
                  )}
                </>
              )}
            </span>
          </>
        )}
      </footer>
    </article>
    </SlackUserNames.Provider>
  );
}

/**
 * How many Slack threads Send replied in: "replied" is one, "replied in 2 threads" (others asked
 * for the same review) is more; `null` when it did not reply.
 */
export function repliedThreads(reply: string | null | undefined): number | null {
  if (reply === "replied") return 1;
  const many = /^replied in (\d+) threads$/.exec(reply ?? "");
  return many ? Number(many[1]) : null;
}

/**
 * The Slack thread's one message before it is posted: Lotus's rendering, which the reviewer may
 * rewrite. Reviews not sent yet link their PR; Lotus swaps in each review's link when it posts.
 * While other reviews of the thread are pending, Send alone holds the message, so only Send all
 * (or the last Send) posts this text.
 */
function SlackMessage({
  preview,
  text,
  group,
  alone,
  disabled,
  onChange,
}: {
  preview: SlackPreview | null;
  text: string | null;
  group: number;
  /** What the button that sends only this review is called, for the hint. */
  alone: string;
  disabled: boolean;
  onChange: (next: string | null) => void;
}) {
  if (!preview) return null;
  if (preview.text === null) {
    return (
      <span className="au-hint au-dest-row">
        <SlackMark size={11} />
        The thread gets one message after {plural(preview.waiting, "more review")} {preview.waiting === 1 ? "is" : "are"} sent or dismissed.
      </span>
    );
  }
  return <SlackPreviewBox preview={preview.text} text={text} group={group} alone={alone} disabled={disabled} onChange={onChange} />;
}

/** Lotus's message as Slack will show it; "Edit message" opens it for the reviewer's own text. */
function SlackPreviewBox({ preview, text, group, alone, disabled, onChange }: {
  preview: string;
  text: string | null;
  group: number;
  alone: string;
  disabled: boolean;
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const value = text ?? preview;
  return (
    <div className="au-slack-reply">
      <span className="au-hint">{group > 1 ? `One Slack message for all ${group} reviews` : "Slack message"}</span>
      {open ? (
        <textarea
          className="au-input"
          aria-label="Slack message"
          rows={rowsFor(value, 3)}
          maxLength={MAX_SLACK_CHARS}
          value={value}
          disabled={disabled}
          autoFocus
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div className="au-slack-preview" aria-label="Slack message preview">
          <SlackText>{value}</SlackText>
        </div>
      )}
      <span className="au-hint">
        {open ? (
          <button type="button" className="au-link" onClick={() => setOpen(false)}>Done</button>
        ) : (
          <button type="button" className="au-link" disabled={disabled} onClick={() => setOpen(true)}>Edit message</button>
        )}{" "}
        {text !== null ? "Your text is sent as written. " : null}
        {group > 1 ? `${alone} holds it until the last review is sent. ` : null}
        {text !== null ? (
          <button type="button" className="au-link" disabled={disabled} onClick={() => { onChange(null); setOpen(false); }}>
            Use Lotus&apos;s text
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * A reply held until the thread's other reviews are sent: "waiting: 1 of 2 sent" → `{ sent, total }`;
 * `null` for anything else.
 */
export function slackWaiting(reply: string | null | undefined): { sent: number; total: number } | null {
  const waiting = /^waiting: (\d+) of (\d+) sent$/.exec(reply ?? "");
  return waiting ? { sent: Number(waiting[1]), total: Number(waiting[2]) } : null;
}

/**
 * What happened in Slack after Send, from the reply the host reported. A held reply offers Reply
 * now when a client is given: it posts what was sent so far, without waiting for the rest.
 */
export function SlackOutcome({ reply: reported, draftId, client }: { reply: string; draftId?: string; client?: AutomationClient }) {
  const [reply, setReply] = useState(reported);
  const [posting, setPosting] = useState(false);
  const waiting = slackWaiting(reply);
  if (waiting) {
    const replyNow = async () => {
      if (!client || !draftId) return;
      setPosting(true);
      try {
        setReply(await client.replyNow(draftId));
      } catch (error) {
        setReply(`not replied: ${String(error)}`);
      } finally {
        setPosting(false);
      }
    };
    return (
      <span className="au-dest-row au-note">
        <SlackMark size={11} />
        {waiting.sent} of {waiting.total} sent · Slack waiting
        {client && draftId ? (
          <button type="button" className="au-link" disabled={posting} onClick={() => void replyNow()}>
            {posting ? "Replying…" : "Reply now"}
          </button>
        ) : null}
      </span>
    );
  }
  const threads = repliedThreads(reply);
  return threads ? (
    <span className="au-dest-row au-note">
      <SlackMark size={11} />
      {threads === 1 ? "Replied in the Slack thread." : `Replied in ${threads} Slack threads.`}
    </span>
  ) : (
    <span className="au-dest-row au-error">
      <SlackMark size={11} />
      Slack: {reply}
    </span>
  );
}

export function EditButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="rs-icon-button au-edit" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <Pencil size={12} aria-hidden />
    </button>
  );
}

export function EditDone({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="au-link au-edit-done"
      // Fires before the textarea's blur, so one click both saves and closes.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      Done
    </button>
  );
}
