"use client";

import { useEffect, useRef, useState } from "react";
import type { AutomationClient, AutomationDraft, ReviewRoomData } from "../services/automation-api";
import { formatWhen } from "../services/format";
import { ReviewText } from "./ReviewText";

/** One durable conversation per automation and PR, independent of provider transcript lifetime. */
export function ReviewRoom({ draft, client, running = false, defaultOpen = false }: {
  draft: AutomationDraft; client: AutomationClient; running?: boolean;
  /** Open on arrival: the right pane reads one PR, so its conversation is the point. */
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [room, setRoom] = useState<ReviewRoomData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [focus, setFocus] = useState("");
  const [sending, setSending] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  const [startMessage, setStartMessage] = useState("");
  const request = useRef(0);
  const url = draft.content?.url;

  useEffect(() => {
    if (!expanded || !url || !client.reviewRoom) return;
    let disposed = false;
    const refresh = async () => {
      const version = ++request.current;
      try {
        const result = await client.reviewRoom!(draft.automationId, url);
        if (!disposed && version === request.current) { setRoom(result); setLoadError(null); }
      } catch (e) {
        if (!disposed && version === request.current) setLoadError(`Could not load review history: ${String(e)}`);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => { disposed = true; clearInterval(timer); };
  }, [expanded, url, draft.automationId, draft.id, client, refreshCount]);

  useEffect(() => {
    if (!started || !client.runs) return;
    let disposed = false;
    const check = async () => {
      try {
        const run = (await client.runs(50)).find((r) => r.id === started);
        if (disposed || !run) return;
        if (["failed", "interrupted", "skipped"].includes(run.status)) {
          setStarted(null); setError(`Re-review ${run.status}: ${run.detail ?? "No draft was produced"}. You can try again.`);
        } else if (run.status === "succeeded" || run.status === "asked") {
          setStarted(null); setRefreshCount((n) => n + 1);
        }
      } catch { /* The engine's normal Inbox updates remain available; keep the accepted run identity. */ }
    };
    void check();
    const timer = setInterval(() => void check(), 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [started, client]);

  const again = async () => {
    if (!url || !client.reviewAgain || sending || started || running) return;
    setSending(true); setError(null);
    try {
      const result = await client.reviewAgain(draft.automationId, url, focus.trim());
      setStarted(result.runId);
      setStartMessage(result.status === "started" ? "Re-review started. Its draft will appear in the Inbox." : "This review already exists. Check its result in the Inbox.");
    } catch (e) { setError(`Could not start re-review. Your focus is retained. ${String(e)}`); }
    finally { setSending(false); }
  };
  const history = room?.history ?? [];
  const latest = history.at(-1) ?? draft;
  const feedback = room?.feedback ?? [];
  const newFeedback = feedback.some((f) => f.atMs > latest.createdAtMs);

  return <details className="au-review-room" open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
    <summary>Review history and feedback</summary>
    {expanded ? <div className="au-room-body" aria-label={`Review room for ${draft.subject}`}>
      {history.length ? <RoundStepper rounds={history} feedbackAt={feedback.map((f) => f.atMs)} /> : null}
      <div className="au-room-round"><p className="au-note">One conversation for this PR. Earlier rounds remain in the timeline.</p>
        <button type="button" className="rs-button rs-button--ghost" onClick={() => setRefreshCount((n) => n + 1)}>Refresh history</button></div>
      {newFeedback ? <p className="au-room-status">New feedback</p> : null}
      {!room && client.reviewRoom && !loadError ? <p className="au-note" role="status">Loading review history…</p> : null}
      {!client.reviewRoom ? <p className="au-note">Update Lotus to load this PR’s review history.</p> : null}
      <ol className="au-room-timeline" aria-label="Review timeline">
        {[...history.map((round, index) => {
          const content = round.content;
          const previous = content?.previous ?? [];
          const resolved = previous.filter((p) => p.status !== "not-fixed").length;
          return { atMs: round.createdAtMs, element: <li key={`round-${round.id}`}>
            <div className="au-room-round"><strong>Review {index + 1}</strong><span className="au-hint">{round.status === "sent" ? "Published" : "Draft"} · {content?.headSha.slice(0, 7)} · {formatWhen(round.createdAtMs)}</span></div>
            {previous.length ? <p className="au-note">{resolved} resolved · {previous.length - resolved} still open · {content?.comments.length ?? 0} new inline findings</p> : null}
            {previous.length ? <ul>{previous.map((p, i) => <li key={p.findingId ?? `${p.path}:${p.line}:${i}`}><strong>{p.status === "fixed" ? "Fixed" : p.status === "answered" ? "Answered" : "Still open"}</strong>: {p.path}:{p.line} · {p.body}{p.note ? ` (${p.note})` : ""}{p.replies?.length ? <details><summary>GitHub replies</summary>{p.replies.map((reply, index) => <div key={index}><strong>{reply.author}</strong><ReviewText>{reply.body}</ReviewText></div>)}</details> : null}</li>)}</ul> : null}
            <details><summary>Review text</summary><ReviewText>{content?.summary ?? ""}</ReviewText></details>
            {round.sentUrl ? <a href={round.sentUrl} target="_blank" rel="noreferrer">View published review</a> : null}
          </li> };
        }), ...feedback.map((f) => ({ atMs: f.atMs, element: <li key={`feedback-${f.id}`}><div className="au-room-round"><strong>{f.author}</strong><span className="au-hint">Feedback · {formatWhen(f.atMs)}</span></div><ReviewText>{f.text}</ReviewText></li> }))].sort((a, b) => a.atMs - b.atMs).map((entry) => entry.element)}
      </ol>
      {client.reviewAgain ? <form className="au-room-next" onSubmit={(e) => { e.preventDefault(); void again(); }}>
        <label className="au-label" htmlFor={`au-review-focus-${draft.id}`}>Focus for the next review</label>
        <textarea id={`au-review-focus-${draft.id}`} className="au-input" maxLength={4000} rows={2} value={focus}
          placeholder="Optional: recheck the fix, or ask a follow-up question" disabled={sending || Boolean(started) || running} onChange={(e) => setFocus(e.target.value)} />
        <div><button className="rs-button rs-button--primary" disabled={sending || Boolean(started) || running}>{sending ? "Starting…" : "Review again"}</button></div>
        <p className="au-hint">Continues the PR conversation and checks the latest code. The result is a draft; publication still needs your click.</p>
      </form> : null}
      {running ? <p className="au-note" role="status">A review of this PR is already running.</p> : null}
      {started ? <p className="au-note" role="status">{startMessage}</p> : null}
      {error || loadError ? <p className="au-error" role="alert">{error ?? loadError}</p> : null}
    </div> : null}
  </details>;
}

/**
 * Where this PR's conversation stands, in one line: each review round (sent or still a draft), and
 * the feedback that came in after it. "Review 1 Sent › Feedback 2 › Review 2 Draft".
 */
export function RoundStepper({ rounds, feedbackAt }: { rounds: AutomationDraft[]; feedbackAt: number[] }) {
  const steps: { key: string; label: string; state: string; current?: boolean }[] = [];
  rounds.forEach((round, i) => {
    const next = rounds[i + 1]?.createdAtMs ?? Infinity;
    const sent = round.status === "sent";
    steps.push({ key: `r-${round.id}`, label: `Review ${i + 1}`, state: sent ? "Sent" : "Draft", current: !sent && i === rounds.length - 1 });
    const replies = feedbackAt.filter((at) => at > round.createdAtMs && at <= next).length;
    if (replies) steps.push({ key: `f-${round.id}`, label: "Feedback", state: String(replies), current: i === rounds.length - 1 });
  });
  return <ol className="au-rounds" aria-label="Rounds">
    {steps.map((step) => <li key={step.key} className="au-round" aria-current={step.current ? "step" : undefined}>
      {`${step.label} · ${step.state}`}
    </li>)}
  </ol>;
}
