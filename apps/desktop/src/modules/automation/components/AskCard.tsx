"use client";

import { MessageCircleQuestion } from "lucide-react";
import { useState } from "react";

import type { AutomationAnswer, AutomationClient, AutomationDraft } from "../services/automation-api";
import { formatWhen } from "../services/format";
import { ReviewText } from "./ReviewText";

/** An Automation Ask (a draft of kind `ask`). */
export { isAsk } from "../services/inbox-model";

/** "Answered: Approve · add an abuse test" — the choice and the note, whichever were given. */
export function answeredLine(answer: Pick<AutomationAnswer, "choice" | "note">): string {
  return `Answered: ${[answer.choice, answer.note.trim()].filter(Boolean).join(" · ")}`;
}

type State = "idle" | "sending" | "dismissed" | { answered: Pick<AutomationAnswer, "choice" | "note"> } | { error: string };

/**
 * An agent stopped to ask the user one question. It reads as the agent wrote it (markdown), and
 * each choice it offered is a button labelled as plain text — never markup, since an agent wrote
 * it. Any choice, Reject included, resumes the agent at once with the choice and the note; an Ask
 * without choices takes the answer as text. Dismiss closes it without starting anything.
 *
 * Deep in a chain, the earlier questions and answers come first. An Ask whose Follow-up Run
 * failed is back with the Answer kept: Send again resends it as it was.
 */
export function AskCard({ ask, client }: { ask: AutomationDraft; client: AutomationClient }) {
  const [note, setNote] = useState("");
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [state, setState] = useState<State>("idle");
  const question = ask.ask?.question ?? "";
  const choices = ask.ask?.choices ?? [];
  const chain = ask.ask?.chain ?? [];
  // A review's agent read someone else's PR, which may have put words in its mouth (ADR-0040 §6).
  const review = ask.ask?.review ?? null;
  const failedAnswer = ask.ask?.answer?.failedRunId ? ask.ask.answer : null;
  const busy = state === "sending";
  const open = state === "idle" || state === "sending" || (typeof state === "object" && "error" in state);

  const answer = async (choice: string | null, text = note) => {
    setState("sending");
    try {
      await client.answerAsk(ask.id, choice, text);
      setState({ answered: { choice, note: text } });
    } catch (e) {
      setState({ error: String(e) });
    }
  };

  const dismiss = async () => {
    setConfirmDismiss(false);
    try {
      await client.discardDraft(ask.id);
      setState("dismissed");
    } catch (e) {
      setState({ error: String(e) });
    }
  };

  return (
    <article className="au-draft au-ask" aria-label={`${ask.subject} question`}>
      <header className="au-draft-head">
        <MessageCircleQuestion size={15} className="au-draft-icon" aria-hidden />
        <div className="au-draft-heading">
          <span className="au-draft-title">{ask.subject}</span>
          <span className="au-draft-meta">Asked {formatWhen(ask.createdAtMs)}</span>
        </div>
      </header>
      {review ? (
        <p className="au-note">
          Asked by the agent reviewing {review.repo}#{review.number}
        </p>
      ) : null}
      {chain.length > 0 ? (
        <ol className="au-ask-chain" aria-label="Earlier questions">
          {chain.map((step, i) => (
            <li key={i} className="au-ask-chain-step">
              <ReviewText literalLinks={Boolean(review)}>{step.question}</ReviewText>
              <p className="au-note">{answeredLine(step)}</p>
            </li>
          ))}
        </ol>
      ) : null}
      <section className="au-review-part">
        <ReviewText literalLinks={Boolean(review)}>{question}</ReviewText>
      </section>

      {open && failedAnswer ? (
        <>
          <p className="au-error" role="alert">
            The follow-up run failed. Your answer is kept; send it again, or dismiss the question.
          </p>
          <p className="au-note">{answeredLine(failedAnswer)}</p>
          {typeof state === "object" && "error" in state ? (
            <p className="au-error" role="alert">
              {state.error}
            </p>
          ) : null}
          <footer className="au-review-foot">
            <span className="au-draft-actions">
              <button type="button" className="rs-button rs-button--primary" disabled={busy} onClick={() => void answer(failedAnswer.choice, failedAnswer.note)}>
                {busy ? "Sending…" : "Send again"}
              </button>
            </span>
            <DismissButton confirm={confirmDismiss} busy={busy} onConfirmingChange={setConfirmDismiss} onDismiss={() => void dismiss()} />
          </footer>
        </>
      ) : open ? (
        <>
          <textarea
            className="au-textarea au-ask-note"
            aria-label={choices.length > 0 ? "Note for the agent" : "Your answer"}
            placeholder={choices.length > 0 ? "Add a note (optional)" : "Your answer"}
            value={note}
            disabled={busy}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
          />
          {typeof state === "object" && "error" in state ? (
            <p className="au-error" role="alert">
              {state.error}
            </p>
          ) : null}
          <footer className="au-review-foot">
            <span className="au-draft-actions au-ask-answers">
              {choices.length > 0 ? (
                choices.map((choice, i) => (
                  <button
                    key={`${i}-${choice}`}
                    type="button"
                    className={i === 0 ? "rs-button rs-button--primary" : "rs-button"}
                    disabled={busy}
                    onClick={() => void answer(choice)}
                  >
                    {choice}
                  </button>
                ))
              ) : (
                <button type="button" className="rs-button rs-button--primary" disabled={busy || !note.trim()} onClick={() => void answer(null)}>
                  {busy ? "Sending…" : "Send answer"}
                </button>
              )}
            </span>
            <DismissButton confirm={confirmDismiss} busy={busy} onConfirmingChange={setConfirmDismiss} onDismiss={() => void dismiss()} />
          </footer>
        </>
      ) : (
        <p className="au-note" role="status">
          {typeof state === "object" && "answered" in state ? (
            <>
              <span>{answeredLine(state.answered)}</span> <span>The agent continues now; see Running now.</span>
            </>
          ) : (
            "Dismissed."
          )}
        </p>
      )}
    </article>
  );
}

/** Dismiss, asked twice: a question closed by mistake cannot be brought back. */
function DismissButton({
  confirm,
  busy,
  onConfirmingChange,
  onDismiss,
}: {
  confirm: boolean;
  busy: boolean;
  onConfirmingChange: (confirming: boolean) => void;
  onDismiss: () => void;
}) {
  return (
    <span className="au-draft-actions">
      {confirm ? (
        <>
          <span className="au-note">Dismiss this question?</span>
          <button type="button" className="rs-button rs-button--ghost" onClick={() => onConfirmingChange(false)}>
            Keep
          </button>
          <button type="button" className="rs-button rs-button--danger" onClick={onDismiss}>
            Dismiss
          </button>
        </>
      ) : (
        <button type="button" className="rs-button rs-button--ghost" disabled={busy} onClick={() => onConfirmingChange(true)}>
          Dismiss
        </button>
      )}
    </span>
  );
}

/** Answered Asks: the question, and what the user answered. */
export function AnsweredAsks({ answered }: { answered: AutomationDraft[] }) {
  return (
    <ul className="au-sent-list">
      {answered.map((d) => (
        <li key={d.id} className="au-sent-row">
          <MessageCircleQuestion size={14} className="au-triage-icon" aria-hidden />
          <span className="au-sent-subject">{d.subject}</span>
          <span className="au-note">{d.ask?.question.split("\n")[0]}</span>
          {d.ask?.answer ? <span className="au-sent-meta">{answeredLine(d.ask.answer)}</span> : null}
          {d.ask?.answer ? (
            <time className="au-sent-meta" dateTime={new Date(d.ask.answer.answeredAtMs).toISOString()}>
              {formatWhen(d.ask.answer.answeredAtMs)}
            </time>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
