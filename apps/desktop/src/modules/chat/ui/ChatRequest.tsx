"use client";

import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DENIED_WITHOUT_NOTE, SKIPPED_QUESTION, optionLabel, planOf, requestDetail, requestTitle, splitQuestion } from "../domain/requests";
import type { Interaction } from "../domain/thread-event";
import type { ApprovalDecision } from "../runtime/chat-runtime-client";
import { ChatMarkdown } from "./timeline/ChatMarkdown";

// Mockup: mockups/lotus-chat.fig, page "04b Approvals" (#276), restyled on "05 Refresh warm" (#280). Buttons only, no keyboard
// shortcuts: approving by accident is worse than one extra click. Focus lands on the request.

interface ChatRequestProps {
  interaction: Interaction;
  /** Requests waiting, this one included. */
  count: number;
  cwd: string | null;
  /** What the user typed in the composer: the note sent with Deny. */
  text: string;
  busy: boolean;
  onDecide: (decision: ApprovalDecision) => void;
}

export function ChatRequest({ interaction, count, cwd, text, busy, onDecide }: ChatRequestProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), [interaction.id]);

  return (
    <div ref={ref} className="chat-request" role="group" aria-label={requestTitle(interaction)} tabIndex={-1}>
      {interaction.kind === "question" ? (
        <QuestionPanel key={interaction.id} interaction={interaction} busy={busy} onDecide={onDecide} />
      ) : (
        <PermissionPanel interaction={interaction} count={count} cwd={cwd} text={text} busy={busy} onDecide={onDecide} />
      )}
    </div>
  );
}

function PermissionPanel({
  interaction,
  count,
  cwd,
  text,
  busy,
  onDecide,
}: Omit<ChatRequestProps, "interaction"> & { interaction: Extract<Interaction, { kind: "toolPermission" }> }) {
  const detail = requestDetail(interaction, cwd);
  // ExitPlanMode: the plan, readable, and words for what Allow and Deny mean here.
  const plan = planOf(interaction);
  return (
    <>
      <div className="chat-request-head">
        <span className="chat-request-title">{requestTitle(interaction)}</span>
        {count > 1 && <span className="chat-request-count">1 of {count}</span>}
      </div>
      {interaction.blockedPath && (
        <div className="chat-request-warning">
          Outside {cwd ?? "the folder"} · {interaction.blockedPath}
        </div>
      )}
      {plan ? (
        <div className="chat-request-plan">
          <ChatMarkdown text={plan} streaming={false} />
        </div>
      ) : (
      <div className="chat-request-body">
        <div className="chat-request-target">
          <span className="chat-request-tool">{interaction.toolName}</span>
          {detail.target && <code className="chat-request-code">{detail.target}</code>}
        </div>
        {detail.lines.length > 0 && (
          <pre className="chat-request-lines">
            {detail.lines.map((line, i) => (
              <div key={i} data-sign={line.sign}>
                {line.sign === " " ? line.text : `${line.sign} ${line.text}`}
              </div>
            ))}
          </pre>
        )}
        {detail.note && <p className="chat-request-note">{detail.note}</p>}
      </div>
      )}
      <div className="chat-request-actions">
        <span className="chat-request-scope">{plan ? "Claude stops planning and asks before each edit" : "Only this time"}</span>
        <button
          type="button"
          className="chat-btn"
          disabled={busy}
          onClick={() => onDecide({ behavior: "deny", message: text || DENIED_WITHOUT_NOTE })}
        >
          {plan ? "Keep planning" : "Deny"}
        </button>
        {interaction.remember && !plan && (
          <button type="button" className="chat-btn" disabled={busy} onClick={() => onDecide({ behavior: "allow", remember: true })}>
            Allow for this session
          </button>
        )}
        <button type="button" className="chat-btn chat-btn--primary" disabled={busy} onClick={() => onDecide({ behavior: "allow" })}>
          {plan ? "Start building" : "Allow"}
        </button>
      </div>
    </>
  );
}

/** Picks "Other…": the answer is what the user types in the box it opens. */
const OTHER = "\u0000other";

function QuestionPanel({
  interaction,
  busy,
  onDecide,
}: Pick<ChatRequestProps, "busy" | "onDecide"> & { interaction: Extract<Interaction, { kind: "question" }> }) {
  const { questions } = interaction;
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const q = questions[index];
  const picked = picks[q.question] ?? [];
  const answerFor = (question: string) =>
    (picks[question] ?? [])
      .map((label) => (label === OTHER ? (typed[question] ?? "").trim() : label))
      .filter(Boolean)
      .join(", ");
  const last = index === questions.length - 1;
  const labels = [...q.options.map((o) => o.label), OTHER];
  const parts = splitQuestion(q.question);

  const toggle = (label: string) =>
    setPicks((all) => {
      const current = all[q.question] ?? [];
      const next = q.multiSelect
        ? current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
        : [label];
      return { ...all, [q.question]: next };
    });

  // The numbers on the right are keys: 1–9 picks that option, unless the user is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof Element && event.target.closest("textarea, [contenteditable=true]");
      if (event.metaKey || event.ctrlKey || event.altKey || typing) return;
      const label = labels[Number(event.key) - 1];
      if (/^[1-9]$/.test(event.key) && label) {
        event.preventDefault();
        toggle(label);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const next = () => {
    if (!last) {
      setIndex(index + 1);
      return;
    }
    onDecide({
      behavior: "allow",
      answers: Object.fromEntries(questions.map((item) => [item.question, answerFor(item.question)])),
    });
  };

  return (
    <>
      <div className="chat-request-head">
        <p className="chat-request-question">{parts.ask}</p>
        {questions.length > 1 && <span className="chat-request-count">{`${index + 1} of ${questions.length}`}</span>}
      </div>
      {parts.changes.length > 0 && (
        <ul className="chat-request-changes">
          {parts.changes.map((change, i) => (
            <li key={i} data-same={change.from === null || undefined}>
              <span className="chat-request-change-key">{change.key}</span>
              {change.from === null ? (
                <span className="chat-request-change-value">{change.to}</span>
              ) : (
                <span className="chat-request-change-value">
                  <span className="chat-request-change-from">{change.from}</span>
                  <span className="chat-request-change-arrow">→</span>
                  <span className="chat-request-change-to">{change.to}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {parts.rest && <p className="chat-request-why">{parts.rest}</p>}
      <div className="chat-request-options" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
        {labels.map((label, n) => {
          const option = q.options[n];
          const on = picked.includes(label);
          const shown = option ? optionLabel(option.label) : null;
          return (
            <label key={label} className="chat-request-option" data-picked={on || undefined}>
              {/* Visually hidden, still the control: keyboard and screen readers use it. */}
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                name={`${interaction.id}:${index}`}
                checked={on}
                onChange={() => toggle(label)}
              />
              <span className="chat-request-option-mark" aria-hidden>
                {on && <Check size={12} strokeWidth={3} />}
              </span>
              <span className="chat-request-option-text">
                <span className="chat-request-option-label">
                  {shown ? shown.label : "Other…"}
                  {shown?.recommended && <span className="chat-request-option-tag">Recommended</span>}
                </span>
                {option?.description && <span className="chat-request-option-desc">{option.description}</span>}
              </span>
              <span className="chat-request-option-n" aria-hidden>
                {n + 1}
              </span>
            </label>
          );
        })}
      </div>
      {picked.includes(OTHER) && (
        <textarea
          key={q.question}
          className="chat-request-other"
          aria-label="Your own answer"
          placeholder="Type your own answer…"
          autoFocus
          rows={3}
          value={typed[q.question] ?? ""}
          onChange={(event) => setTyped((all) => ({ ...all, [q.question]: event.target.value }))}
        />
      )}
      <div className="chat-request-actions">
        <button type="button" className="chat-btn chat-btn--ghost" disabled={busy} onClick={() => onDecide({ behavior: "deny", message: SKIPPED_QUESTION })}>
          Cancel
        </button>
        <span className="chat-request-scope">{`1–${labels.length} to pick`}</span>
        {index > 0 && (
          <button type="button" className="chat-btn" disabled={busy} onClick={() => setIndex(index - 1)}>
            Back
          </button>
        )}
        <button type="button" className="chat-btn chat-btn--primary" disabled={busy || !answerFor(q.question)} onClick={next}>
          {last ? "Submit answer" : "Next"}
        </button>
      </div>
    </>
  );
}
