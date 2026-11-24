"use client";

import { CalendarClock, Hash } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { Pill } from "@/components/resource/resource-kit";

import type { AutomationClient, AutomationDraft } from "../services/automation-api";
import { formatWhen } from "../services/format";
import { EditButton, EditDone } from "./DraftCard";
import { GoogleDelivery } from "./GoogleDelivery";
import { ReviewText } from "./ReviewText";
import { SlackText } from "./SlackText";

/**
 * One scheduled-prompt result. A result for a channel waits here until Send or Discard: it reads
 * as it will look, and Edit opens it in a box that grows with the text, so nothing scrolls inside
 * the card. One for the user alone was already delivered and is shown read-only, as markdown like
 * everything else here (PLAN §8 Q5).
 */
export function ResultCard({
  result,
  client,
  channelName,
  newerAtMs,
  text: keptText,
  onTextChange,
}: {
  result: AutomationDraft;
  client: AutomationClient;
  /** The name of the channel it posts to, when known; the id is shown otherwise. */
  channelName?: string;
  /** When a newer run of the same automation also waits: this one may be out of date. */
  newerAtMs?: number;
  /** An edit kept by the Inbox while another item was open. */
  text?: string;
  onTextChange?: (text: string) => void;
}) {
  const [text, setText] = useState(keptText ?? result.result?.text ?? "");
  const [editing, setEditing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "discarded" | { error: string }>("idle");
  const box = useRef<HTMLTextAreaElement>(null);
  const channel = result.result?.channel ?? null;
  const waiting = result.status === "pending" && Boolean(channel) && state !== "sent" && state !== "discarded";
  const busy = state === "sending";
  const dm = result.result?.dm;
  const where = `#${channelName ?? channel}`;
  const wire = useSlackPreview(client, result.id, text);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text, editing]);

  const change = (value: string) => {
    setText(value);
    onTextChange?.(value);
  };
  const editKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
    }
  };

  const send = async () => {
    setEditing(false);
    setState("sending");
    try {
      await client.sendResult(result.id, text);
      setState("sent");
    } catch (e) {
      setState({ error: String(e) });
    }
  };

  const discard = async () => {
    setConfirmDiscard(false);
    try {
      await client.discardDraft(result.id);
      setState("discarded");
    } catch (e) {
      setState({ error: String(e) });
    }
  };

  return (
    <article className="au-draft" aria-label={`${result.subject} result`}>
      <header className="au-draft-head">
        <CalendarClock size={15} className="au-draft-icon" aria-hidden />
        <div className="au-draft-heading">
          <span className="au-draft-title">{result.subject}</span>
          <span className="au-draft-meta">{formatWhen(result.createdAtMs)}</span>
        </div>
        {waiting ? (
          <Pill tone="warn" title={`Waits for Send to ${where}`}>
            <Hash size={10} aria-hidden />
            {channelName ?? channel}
          </Pill>
        ) : dm === "sent" ? (
          <Pill>Sent to your DM</Pill>
        ) : state === "sent" ? (
          <Pill tone="ok">Posted</Pill>
        ) : state === "discarded" ? (
          <Pill>Discarded</Pill>
        ) : null}
      </header>

      {waiting && newerAtMs ? (
        <div className="au-callout au-callout--warn">
          <p>A newer run of this automation from {formatWhen(newerAtMs)} also waits. This one may be out of date.</p>
        </div>
      ) : null}

      {waiting ? (
        <>
          <section className="au-review-part">
            <div className="au-review-part-head">
              <span className="au-label">Message</span>
              {editing ? (
                <EditDone onClick={() => setEditing(false)} />
              ) : (
                <EditButton label="Edit message" disabled={busy} onClick={() => setEditing(true)} />
              )}
            </div>
            {editing ? (
              <textarea
                ref={box}
                className="au-textarea au-review-input au-textarea--grow"
                aria-label={`Result for ${result.subject}`}
                value={text}
                disabled={busy}
                autoFocus
                onChange={(e) => change(e.target.value)}
                onKeyDown={editKeys}
              />
            ) : wire !== null ? (
              <SlackText empty="Empty. Edit it before you send.">{wire}</SlackText>
            ) : (
              <ReviewText empty="Empty. Edit it before you send.">{text}</ReviewText>
            )}
            {wire !== null && !editing ? <MentionNote text={text} wire={wire} /> : null}
          </section>
          {typeof state === "object" ? (
            <p className="au-error" role="alert">
              {state.error}
            </p>
          ) : null}
          <footer className="au-review-foot">
            <span className="au-dest-row au-note">
              <Hash size={12} aria-hidden />
              Posts to {where} as you
            </span>
            <span className="au-draft-actions">
              {confirmDiscard ? (
                <>
                  <span className="au-note">Discard this result?</span>
                  <button type="button" className="rs-button rs-button--ghost" onClick={() => setConfirmDiscard(false)}>
                    Keep
                  </button>
                  <button type="button" className="rs-button rs-button--danger" onClick={() => void discard()}>
                    Discard
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="rs-button rs-button--ghost" disabled={busy} onClick={() => setConfirmDiscard(true)}>
                    Discard
                  </button>
                  <button
                    type="button"
                    className="rs-button rs-button--primary"
                    disabled={busy || !text.trim()}
                    onClick={() => void send()}
                  >
                    {busy ? "Sending…" : "Send to channel"}
                  </button>
                </>
              )}
            </span>
          </footer>
        </>
      ) : (
        <>
          {wire !== null ? <SlackText>{wire}</SlackText> : <ReviewText>{text}</ReviewText>}
          {dm && dm !== "off" && dm !== "sent" ? <p className="au-error">DM {dm}</p> : null}
        </>
      )}
      {result.result?.google ? <GoogleDelivery draftId={result.id} google={result.result.google} client={client} /> : null}
    </article>
  );
}

/**
 * The text as Slack will get it, from the same code that sends it; `null` until known (or when
 * this client cannot preview), so the card falls back to the raw text for a moment, never lies.
 */
function useSlackPreview(client: AutomationClient, draftId: string, text: string): string | null {
  const [wire, setWire] = useState<string | null>(null);
  useEffect(() => {
    const preview = client.previewResult;
    if (!preview) return;
    let live = true;
    const timer = setTimeout(() => {
      preview(draftId, text).then(
        (value) => live && setWire(value),
        () => live && setWire(null),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, draftId, text]);
  return wire;
}

const MENTION = /<[@!#][^<>]*>/g;

/** Says so when a mention in the text reaches Slack as plain words, so no ping is a surprise. */
function MentionNote({ text, wire }: { text: string; wire: string }) {
  const written = text.match(MENTION)?.length ?? 0;
  const live = wire.match(MENTION)?.length ?? 0;
  if (written <= live) return null;
  const quiet = written - live;
  return (
    <p className="au-note au-slack-note">
      {quiet === 1 ? "1 mention is" : `${quiet} mentions are`} shown as text and will not ping. Only mentions
      written in this automation&apos;s instructions ping.
    </p>
  );
}
