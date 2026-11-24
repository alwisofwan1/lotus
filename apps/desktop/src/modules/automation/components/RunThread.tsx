"use client";

import { ArrowUp, Bot, Wrench } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { AutomationClient, ChatEntry, RunConversation } from "../services/automation-api";
import { formatShortWhen } from "../services/format";
import { ReviewText } from "./ReviewText";

/** How often an open thread reads the conversation again while its agent works. */
const POLL_MS = 1500;
const MESSAGE_CHARS = 4000;

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * A run's conversation with its agent, as a chat thread under the item it made: what Lotus told
 * the agent and what it did fold away, the words read as messages, and the user writes back here.
 * A message is a Follow-up Run that resumes the same conversation, under the automation's rules:
 * a review's agent stays read-only and only answers; a prompt's new result waits for Send.
 */
export function RunThread({ client, runId, kind }: { client: AutomationClient; runId: string; kind?: string }) {
  const [conv, setConv] = useState<RunConversation | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** Sent, and not yet in the transcript: shown at once so the thread never looks deaf. */
  const [pending, setPending] = useState<{ text: string; after: number } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);

  const load = useCallback(
    () =>
      client
        .runConversation(runId)
        .then((next) => {
          if (!alive.current) return;
          setConv(next);
          setLoadError(null);
          setPending((p) => (p && next.entries.slice(p.after).some((e) => e.kind === "you") ? null : p));
        })
        .catch((e: unknown) => alive.current && setLoadError(String(e))),
    [client, runId],
  );

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const working = Boolean(conv?.running || pending);
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [working, load]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  if (loadError && !conv) {
    return (
      <section className="au-thread" aria-label="Conversation with the agent">
        <p className="au-hint">{loadError}</p>
      </section>
    );
  }
  if (!conv) return null;

  const canSend = conv.canReply && !working && !sending && draft.trim().length > 0 && draft.length <= MESSAGE_CHARS;
  const send = () => {
    if (!canSend) return;
    const text = draft.trim();
    setSending(true);
    setSendError(null);
    client
      .sendMessage(conv.runId, text, newKey())
      .then(() => {
        setPending({ text, after: conv.entries.length });
        setDraft("");
        void load();
      })
      .catch((e: unknown) => setSendError(String(e)))
      .finally(() => setSending(false));
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const replies = conv.entries.filter((e) => e.kind === "you" || e.kind === "agent").length;
  const placeholder = conv.canReply ? "Reply to the agent…" : (conv.whyNot ?? "The agent is working…");
  return (
    <section className="au-thread" aria-label="Conversation with the agent">
      <div className="au-thread-divider" role="separator">
        <span>{replies === 1 ? "1 message" : `${replies} messages`}</span>
      </div>
      <div className="au-thread-log" role="log" aria-label="Messages" aria-live="polite">
        {groupSteps(conv.entries).map((item, i) => (Array.isArray(item) ? <Steps key={`s${i}`} steps={item} /> : <Entry key={`e${i}`} entry={item} />))}
        {pending ? <Message who="you" text={pending.text} atMs={null} note="Sent" /> : null}
        {working ? (
          <p className="au-thread-typing" aria-label="The agent is working">
            <span className="au-thread-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            The agent is working…
          </p>
        ) : null}
      </div>
      <form
        className="au-chatbox"
        data-disabled={!conv.canReply || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          ref={box}
          className="au-chatbox-input"
          aria-label="Message the agent"
          rows={1}
          value={draft}
          placeholder={placeholder}
          disabled={!conv.canReply || sending}
          maxLength={MESSAGE_CHARS}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={keys}
        />
        <button type="submit" className="au-chatbox-send" aria-label="Send message" title="Send (Enter)" disabled={!canSend}>
          <ArrowUp size={14} aria-hidden />
        </button>
      </form>
      {sendError ? (
        <p className="au-error" role="alert">
          {sendError}
        </p>
      ) : (
        <p className="au-hint au-chatbox-hint">
          {kind === "pr_review"
            ? "The agent answers here, read-only. Nothing is posted to GitHub or Slack."
            : "The agent answers here. A new result it makes waits in Inbox for Send."}
        </p>
      )}
    </section>
  );
}

/** Consecutive steps fold into one line: what the agent did is there, never in the way. */
function groupSteps(entries: ChatEntry[]): (ChatEntry | ChatEntry[])[] {
  const out: (ChatEntry | ChatEntry[])[] = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    if (entry.kind === "step" && Array.isArray(last)) last.push(entry);
    else out.push(entry.kind === "step" ? [entry] : entry);
  }
  return out;
}

function Entry({ entry }: { entry: ChatEntry }) {
  switch (entry.kind) {
    case "you":
    case "agent":
      return <Message who={entry.kind} text={entry.text ?? ""} atMs={entry.atMs} />;
    case "instructions":
      return (
        <Fold label="What Lotus told the agent" atMs={entry.atMs}>
          <pre className="au-thread-instructions">{entry.text}</pre>
        </Fold>
      );
    case "result":
      return <Result result={entry.result ?? {}} atMs={entry.atMs} />;
    default:
      return null;
  }
}

function Message({ who, text, atMs, note }: { who: "you" | "agent"; text: string; atMs: number | null; note?: string }) {
  return (
    <article className="au-msg" data-who={who} aria-label={who === "you" ? "You" : "Agent"}>
      <span className="au-msg-avatar" aria-hidden>
        {who === "you" ? "Y" : <Bot size={14} />}
      </span>
      <div className="au-msg-body">
        <header className="au-msg-head">
          <span className="au-msg-name">{who === "you" ? "You" : "Agent"}</span>
          {atMs ? <time dateTime={new Date(atMs).toISOString()}>{formatShortWhen(atMs)}</time> : null}
          {note ? <span className="au-msg-note">{note}</span> : null}
        </header>
        {who === "you" ? <p className="au-msg-text">{text}</p> : <ReviewText literalLinks>{text}</ReviewText>}
      </div>
    </article>
  );
}

function Steps({ steps }: { steps: ChatEntry[] }) {
  const label = steps.length === 1 ? `Used ${steps[0].tool}` : `Used ${steps.length} tools`;
  return (
    <details className="au-thread-fold au-thread-steps">
      <summary>
        <Wrench size={12} aria-hidden />
        {label}
      </summary>
      <ol>
        {steps.map((s, i) => (
          <li key={i}>
            <span className="au-step-tool">{s.tool}</span> {s.text}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** What the agent handed back: the card above shows it in full, so here it folds. */
function Result({ result, atMs }: { result: Record<string, unknown>; atMs: number }) {
  const str = (key: string) => (typeof result[key] === "string" ? (result[key] as string) : null);
  const ask = result.ask as { question?: string } | undefined;
  const comments = Array.isArray(result.comments) ? result.comments.length : null;
  let label = "Handed back a result";
  let body = str("text");
  if (str("summary") !== null) {
    label = `Handed back a review draft${comments ? ` · ${comments} comment${comments === 1 ? "" : "s"}` : ""}`;
    body = str("summary");
  } else if (ask?.question) {
    label = "Asked you a question";
    body = ask.question;
  } else if (str("nothing_to_report") !== null) {
    label = "Found nothing to report";
    body = str("nothing_to_report");
  }
  return (
    <Fold label={label} atMs={atMs} tone="result">
      {body ? <ReviewText literalLinks>{body}</ReviewText> : null}
    </Fold>
  );
}

function Fold({ label, atMs, tone, children }: { label: string; atMs: number; tone?: "result"; children: ReactNode }) {
  return (
    <details className="au-thread-fold" data-tone={tone}>
      <summary>
        {label}
        {atMs ? <time dateTime={new Date(atMs).toISOString()}>{formatShortWhen(atMs)}</time> : null}
      </summary>
      <div className="au-thread-fold-body">{children}</div>
    </details>
  );
}
