"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FactoryDecision, FactoryIntakeTurn } from "@/lib/tauri/graph-run";
import { DetailSection } from "@/components/resource/resource-kit";
import { INTAKE_NOTE_CHARS, answerDecision, answersProblem, approveDecision, initialAnswers, type AnswerDraft } from "../services/factory-intake";

type Asked = Extract<FactoryIntakeTurn, { kind: "asked" }>;
type Spec = Extract<FactoryIntakeTurn, { kind: "spec" }>;

const REMARK_PLUGINS = [remarkGfm];

/**
 * What a waiting Factory Run asks of the user (FI2): its open questions, or its spec to approve.
 * Keyed by the turn's time in the pane, so a new turn starts with a fresh form.
 */
export function FactoryIntakePanel({
  turn,
  busy,
  decide,
}: {
  turn: FactoryIntakeTurn;
  busy: boolean;
  decide: (decision: FactoryDecision) => void;
}) {
  return turn.kind === "asked" ? <QuestionsForm turn={turn} busy={busy} decide={decide} /> : <SpecReview turn={turn} busy={busy} decide={decide} />;
}

function QuestionsForm({ turn, busy, decide }: { turn: Asked; busy: boolean; decide: (d: FactoryDecision) => void }) {
  const [drafts, setDrafts] = useState<AnswerDraft[]>(() => initialAnswers(turn.questions));
  const problem = answersProblem(turn.questions, drafts);
  const set = (i: number, change: Partial<AnswerDraft>) => setDrafts((all) => all.map((d, j) => (j === i ? { ...d, ...change } : d)));

  return (
    <DetailSection title="Questions">
      <form
        className="fa-intake"
        onSubmit={(event) => {
          event.preventDefault();
          if (!problem) decide(answerDecision(drafts));
        }}
      >
        {turn.questions.map((q, i) => (
          <fieldset key={i} className="fa-question">
            <legend>
              {i + 1}. {q.question}
            </legend>
            {q.choices.map((choice) => (
              <label key={choice} className="fa-choice">
                <input
                  type="radio"
                  name={`q${i}`}
                  checked={drafts[i]?.choice === choice}
                  onChange={() => set(i, { choice })}
                  disabled={busy}
                />
                <span>{choice}</span>
                {choice === q.recommended ? <span className="fa-recommended">Recommended</span> : null}
              </label>
            ))}
            {q.why ? <p className="fa-note">{q.why}</p> : null}
            <textarea
              className="fa-textarea"
              rows={2}
              maxLength={INTAKE_NOTE_CHARS}
              placeholder={drafts[i]?.choice === null ? "Your own answer" : "Add a note (optional)"}
              aria-label={`Note for question ${i + 1}`}
              value={drafts[i]?.note ?? ""}
              onChange={(event) => set(i, { note: event.target.value })}
              disabled={busy}
            />
            {drafts[i]?.choice !== null ? (
              <button type="button" className="fa-link fa-own" onClick={() => set(i, { choice: null })} disabled={busy}>
                None of these, write my own
              </button>
            ) : null}
          </fieldset>
        ))}
        <div className="fa-intake-actions">
          <button type="submit" className="rs-button rs-button--primary" disabled={busy || problem !== null}>
            Send answers
          </button>
          {problem ? <span className="fa-note">{problem}</span> : null}
        </div>
      </form>
    </DetailSection>
  );
}

function SpecReview({ turn, busy, decide }: { turn: Spec; busy: boolean; decide: (d: FactoryDecision) => void }) {
  const [edited, setEdited] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const noteReady = note !== null && note.trim() !== "" && note.length <= INTAKE_NOTE_CHARS;

  return (
    <DetailSection title={turn.live ? "Spec from Brainstorm live" : "Spec"}>
      {edited === null ? (
        <div className="fa-spec">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{turn.markdown}</ReactMarkdown>
        </div>
      ) : (
        <textarea
          className="fa-textarea fa-spec-edit"
          rows={18}
          aria-label="Edit the spec"
          value={edited}
          onChange={(event) => setEdited(event.target.value)}
          disabled={busy}
        />
      )}
      {note === null ? (
        <div className="fa-intake-actions">
          <button
            type="button"
            className="rs-button rs-button--primary"
            disabled={busy || (edited !== null && edited.trim() === "")}
            onClick={() => decide(approveDecision(turn.markdown, edited))}
          >
            {edited !== null && edited.trim() !== turn.markdown.trim() ? "Approve my edit" : "Approve"}
          </button>
          <button type="button" className="rs-button" disabled={busy} onClick={() => setEdited(edited === null ? turn.markdown : null)}>
            {edited === null ? "Edit" : "Cancel edit"}
          </button>
          <button type="button" className="rs-button" disabled={busy} onClick={() => setNote("")}>
            Send back
          </button>
        </div>
      ) : (
        <div className="fa-intake">
          <textarea
            className="fa-textarea"
            rows={4}
            maxLength={INTAKE_NOTE_CHARS}
            placeholder="What should the spec agent change?"
            aria-label="What to change"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={busy}
            autoFocus
          />
          <div className="fa-intake-actions">
            <button
              type="button"
              className="rs-button rs-button--primary"
              disabled={busy || !noteReady}
              onClick={() => decide({ kind: "send-back", note: note.trim() })}
            >
              Send back
            </button>
            <button type="button" className="rs-button" disabled={busy} onClick={() => setNote(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </DetailSection>
  );
}
