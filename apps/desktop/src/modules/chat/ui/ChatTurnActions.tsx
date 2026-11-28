"use client";

import { Check, Copy, GitBranch, GitFork, LoaderCircle, Pencil, TextQuote } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { TurnEnd } from "../domain/timeline";
import { useAriaKeyShortcuts, useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

// Mockup: mockups/chat-turn-actions.html, option A. Under a finished turn's reply: Copy, Quote in
// reply and Fork as plain icons, then one quiet line with the time, duration and cost. No menu,
// so nothing can open off-screen.

export interface TurnActions {
  /** Adds the text to the composer as a quote card; it goes with the next message. */
  quote: (text: string) => void;
  /** Makes a new chat holding the conversation through this turn, and opens it. */
  fork: (turnId: string) => Promise<void>;
  /** Opens another chat, e.g. the one a fork came from. */
  open: (threadId: string) => void;
  /** Moves this fork into its own worktree, its files as at the forked turn. */
  toWorktree: () => Promise<void>;
  /**
   * Edits a sent message in this chat: back to before its turn, then `text` is sent
   * (mockups/chat-user-actions.html).
   */
  edit: (turnId: string, text: string) => Promise<void>;
  /** The runner can branch its session at a turn (Claude, Codex, API); without it only the first message can be edited. */
  branches?: boolean;
  /** An API key pays the cost; a login's cost is only the API-rate price. */
  billed: boolean;
}

/** Null where a reply cannot be acted on (a watched sub-agent, tests). */
export const TurnActionsContext = createContext<TurnActions | null>(null);

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "41s", "2m 14s", "1h 3m". */
export function took(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function TurnFoot({ text, turnId, end }: { text: string; turnId: string; end: TurnEnd }) {
  const actions = useContext(TurnActionsContext);
  const [copied, setCopied] = useState(false);
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  if (!actions) return null;
  const copy = () => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {});
  const fork = () => {
    if (!end.forkable || forking) return;
    setForking(true);
    setError(null);
    actions.fork(turnId).then(
      () => setForking(false),
      (reason: unknown) => {
        setForking(false);
        setError(`Fork failed: ${String(reason)}`);
      },
    );
  };
  const today = new Date(end.endedAt).toDateString() === new Date().toDateString();
  const forkTip = end.forkable ? "Fork from here" : "Can't fork: older turn";

  return (
    <>
      <div className="chat-turn-foot" data-busy={forking || copied ? "" : undefined}>
        <button type="button" className="chat-turn-ic" onClick={copy} aria-label="Copy" data-tip={copied ? "Copied" : "Copy"} data-done={copied ? "" : undefined}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </button>
        <button type="button" className="chat-turn-ic" onClick={() => actions.quote(text)} aria-label="Quote in reply" data-tip="Quote in reply">
          <TextQuote size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="chat-turn-ic"
          onClick={fork}
          aria-label={forkTip}
          aria-disabled={!end.forkable || forking}
          data-tip={forking ? "Forking…" : forkTip}
        >
          {forking ? <LoaderCircle size={14} className="chat-turn-spin" aria-hidden /> : <GitFork size={14} aria-hidden />}
        </button>
        <span className="chat-turn-meta">
          <time dateTime={new Date(end.endedAt).toISOString()} title={`Turn ${end.index} · ${FULL.format(end.endedAt)}`}>
            {(today ? CLOCK : DAY).format(end.endedAt)}
          </time>
          {end.durationMs !== null && <span>{took(end.durationMs)}</span>}
          {end.costUsd !== null && (
            <span title={actions.billed ? "Cost of this turn" : "Not charged: your login covers it. This is the price at API rates."}>
              ${end.costUsd.toFixed(2)}
            </span>
          )}
        </span>
      </div>
      {error && (
        <p className="chat-turn-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** Under your own message, on hover: the time it was sent, Copy and Edit (mockups/chat-user-actions.html). */
export function UserFoot({ text, at, edit, first, onEdit }: { text: string; at: number; edit: true | string | undefined; first?: boolean; onEdit: () => void }) {
  const actions = useContext(TurnActionsContext);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  if (!actions) return null;
  const today = new Date(at).toDateString() === new Date().toDateString();
  const copy = () => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {});
  const why = edit === true && !first && !actions.branches ? "This agent can only edit its first message" : edit;
  const canEdit = why === true;
  const editTip = why === undefined ? null : why === true ? "Edit" : why;
  return (
    <div className="chat-turn-foot chat-user-foot" data-busy={copied ? "" : undefined}>
      <time dateTime={new Date(at).toISOString()} title={FULL.format(at)}>
        {(today ? CLOCK : DAY).format(at)}
      </time>
      <button type="button" className="chat-turn-ic" onClick={copy} aria-label="Copy" data-tip={copied ? "Copied" : "Copy"} data-done={copied ? "" : undefined}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
      {editTip && (
        <button type="button" className="chat-turn-ic" onClick={canEdit ? onEdit : undefined} aria-label={editTip} aria-disabled={!canEdit} data-tip={editTip}>
          <Pencil size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

/**
 * Your message, turned into an input in its own place. Send (⌘↵) goes back to before its turn and
 * sends the new words; Esc or Cancel puts the message back as it was.
 */
export function MessageEditor({ initial, onCancel, onSend }: { initial: string; onCancel: () => void; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState(initial);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const shortcut = useFormatShortcut();
  const ariaShortcut = useAriaKeyShortcuts();
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  useEffect(() => {
    const el = box.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const changed = text.trim() !== "" && text !== initial;
  const send = () => {
    if (!changed || sending) return;
    setSending(true);
    setError(null);
    onSend(text).catch((reason: unknown) => {
      setSending(false);
      setError(String(reason));
    });
  };
  return (
    <div className="chat-edit">
      <textarea
        ref={box}
        className="chat-edit-input"
        aria-label="Edit your message"
        rows={1}
        value={text}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
      />
      {error && (
        <p className="chat-turn-error" role="alert">
          {error}
        </p>
      )}
      <div className="chat-edit-bar">
        <button type="button" className="chat-edit-btn" onClick={onCancel} disabled={sending}>
          Cancel
        </button>
        <button type="button" className="chat-edit-btn" data-primary="" onClick={send} disabled={!changed || sending} aria-keyshortcuts={ariaShortcut("⌘↵")}>
          {sending ? <LoaderCircle size={13} className="chat-turn-spin" aria-hidden /> : "Send"}
          {!sending && <kbd aria-hidden>{shortcut("⌘↵")}</kbd>}
        </button>
      </div>
    </div>
  );
}

/** Where a fork leaves its original: after the copied turns, before its own. */
export function ForkMarker({
  fromThreadId,
  fromTitle,
  turn,
  worktree,
  canMove,
}: {
  fromThreadId: string;
  fromTitle: string;
  turn: number;
  worktree: string | null;
  canMove: boolean;
}) {
  const actions = useContext(TurnActionsContext);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = () => {
    if (!actions || moving) return;
    setMoving(true);
    setError(null);
    actions.toWorktree().then(
      () => setMoving(false),
      (reason: unknown) => {
        setMoving(false);
        setError(String(reason));
      },
    );
  };
  return (
    <div className="chat-row chat-fork">
      <span className="chat-fork-pill">
        <GitFork size={12} aria-hidden />
        Forked from{" "}
        {actions ? (
          <button type="button" onClick={() => actions.open(fromThreadId)}>
            {fromTitle}
          </button>
        ) : (
          fromTitle
        )}{" "}
        at turn {turn}
      </span>
      {worktree ? (
        <span className="chat-fork-note" data-worktree="">
          <GitBranch size={12} aria-hidden />
          Own worktree on <code>{worktree}</code>, files as at turn {turn}
        </span>
      ) : (
        <span className="chat-fork-note">
          Same folder: files are as they are now, not as at turn {turn}.
          {canMove && actions && (
            <button type="button" className="chat-fork-move" onClick={move} aria-busy={moving}>
              {moving ? <LoaderCircle size={12} className="chat-turn-spin" aria-hidden /> : <GitBranch size={12} aria-hidden />}
              {moving ? "Making worktree…" : error ? "Try again" : `Use a worktree at turn ${turn}`}
            </button>
          )}
        </span>
      )}
      {error && (
        <span className="chat-turn-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
