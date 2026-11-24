"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { getUsageSnapshot, listAccounts } from "@/lib/tauri-api";
import { resetLabel, windowLabel, type UsageAccount } from "@/modules/workspace-shell/services/usage";
import { useDismiss } from "./ChatModel";
import { DitherTile } from "./Dither";
// Canvas and Code mount the chip too, and chat.css is otherwise loaded only by the chat surfaces.
import "@/styles/chat.css";

/**
 * Every Claude (ccs) and Codex account with its limits, plus a refresh. The Rust side caches them
 * (errors for only 60 s), so asking often is cheap — and a one-shot read kept a startup 429 as "Signed out".
 */
export function useUsageAccounts(): [UsageAccount[], () => void] {
  const [accounts, setAccounts] = useState<UsageAccount[]>([]);
  const live = useRef(true);
  const refresh = useCallback(() => {
    getUsageSnapshot()
      .then((all) => live.current && setAccounts(all))
      .catch(() => {});
  }, []);
  useEffect(() => {
    live.current = true;
    refresh();
    return () => {
      live.current = false;
    };
  }, [refresh]);
  return [accounts, refresh];
}

/**
 * The Claude accounts an agent running on `current` can move to, and a refresh for the chip's open.
 * Once it has a conversation, an Isolated account is left out either way: it keeps its own
 * transcripts, so `--resume` across it would start over (Canvas nodes, Code panes).
 */
export function useClaudeAccountChoices(current: string | null, hasConversation: boolean): [UsageAccount[], () => void] {
  const [accounts, refreshUsage] = useUsageAccounts();
  const [isolated, setIsolated] = useState<string[]>([]);
  const readIsolated = useCallback(() => {
    listAccounts()
      .then((all) => setIsolated(all.filter((a) => a.context === "isolated").map((a) => a.id)))
      .catch(() => {});
  }, []);
  useEffect(readIsolated, [readIsolated]);
  const refresh = useCallback(() => {
    refreshUsage();
    readIsolated();
  }, [refreshUsage, readIsolated]);
  const choices = useMemo(() => {
    const claude = accounts.filter((a) => a.provider === "claude");
    if (!hasConversation) return claude;
    // No account of its own = the default for new work.
    const mine = current ?? claude.find((a) => a.inUse)?.account ?? null;
    const apart = (id: string | null) => id !== null && isolated.includes(id);
    return claude.filter((a) => a.account === mine || (!apart(a.account) && !apart(mine)));
  }, [accounts, isolated, hasConversation, current]);
  return [choices, refresh];
}

/** The account has no usable login. Other errors (429, network) say nothing about the sign-in. Messages: src-tauri/src/usage.rs. */
export function signedOut(account: UsageAccount): boolean {
  return !!account.error && /^(not signed in|sign-in |keychain item is not JSON|credentials file is not JSON)/.test(account.error);
}

/** The highest share used across an account's windows; 100 = can't take a message now. */
export function usedPercent(account: UsageAccount): number {
  return Math.max(0, ...account.windows.map((w) => w.usedPercent));
}

/** Where to continue after a limit: the least-used other account that has room and a working sign-in. */
export function nextAccount(accounts: readonly UsageAccount[], current: string | null): UsageAccount | null {
  const open = accounts.filter((a) => a.account !== current && !a.error && usedPercent(a) < 100);
  return open.sort((a, b) => usedPercent(a) - usedPercent(b))[0] ?? null;
}

/** Room left in the tightest window, 0–100; null when there are no numbers (signed out, or not fetched). */
function room(account: UsageAccount): number | null {
  if (account.error || account.windows.length === 0) return null;
  return Math.max(0, 100 - Math.round(usedPercent(account)));
}

const tone = (left: number | null) => (left == null || left === 0 ? "out" : left < 20 ? "warn" : "ok");

/** " · resets 7 PM": when the last full window frees up. */
function fullReset(account: UsageAccount): string {
  const at = Math.max(0, ...account.windows.filter((w) => w.usedPercent >= 100).map((w) => w.resetsAtMs ?? 0));
  const label = resetLabel(at || null, Date.now());
  return label ? ` · ${label}` : "";
}

/** The permission chip's dither tile, lit by room left: a full account is dark. */
function CapacityGlyph({ room: left }: { room: number | null }) {
  const lit = left ? Math.max(1, Math.round((left / 100) * 16)) : 0;
  return <DitherTile lit={lit} data-tone={tone(left)} />;
}

/**
 * ⌘K's Claude row (mockup decisions 6/10): the account a launch will use — the default shown by its
 * real name — and ⇥ to switch. A click switches too; the sheet's list scrolls, so a popover would clip.
 */
export function LaunchAccountTag({ account, onCycle }: { account: string | null; onCycle: () => void }) {
  const [accounts] = useUsageAccounts();
  const claude = accounts.filter((a) => a.provider === "claude");
  const name = account ?? claude.find((a) => a.inUse)?.account ?? "default";
  const mine = claude.find((a) => a.account === name);
  return (
    <span
      className="chat-launch-account"
      role="button"
      aria-label={`Launches on ${name}. Tab switches account`}
      title="⇥ switch account"
      // Pointer down, not click: the row runs on its own pointer/click, and the input keeps focus.
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onCycle();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {mine && <CapacityGlyph room={room(mine)} />}
      <span className="chat-launch-account-name">{name}</span>
      <kbd>⇥</kbd>
    </span>
  );
}

/** Composer chip: which Claude account this chat runs on; picking another resumes it there. Also a Canvas agent node's. */
export function ChatAccountPicker({
  accounts,
  current,
  disabled,
  onPick,
  onOpen,
  footer = "Applies from your next message.",
  below = false,
  subject = "This chat",
  confirm,
}: {
  accounts: readonly UsageAccount[];
  current: string | null;
  disabled: boolean;
  onPick: (account: string) => Promise<void>;
  /** Re-reads the accounts, so a re-login or a passed 429 shows without a restart. */
  onOpen?: () => void;
  /** What a pick does, under the list. */
  footer?: string;
  /** Opens downward, for a chip at the top of its surface (a node header). */
  below?: boolean;
  /** Who runs on the account, for the chip's label: "This chat", "Kai". */
  subject?: string;
  /** A question to answer before a pick takes effect (a restart); null = none needed. */
  confirm?: (account: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState<{ account: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => {
    setOpen(false);
    setAsking(null);
  });
  if (accounts.length < 2) return null;
  const mine = accounts.find((a) => a.account === current);

  const pick = async (account: string, confirmed = false) => {
    if (account === current) return setOpen(false);
    const text = confirmed ? null : confirm?.(account);
    if (text) return setAsking({ account, text });
    setOpen(false);
    setAsking(null);
    setBusy(true);
    try {
      await onPick(account);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className="chat-model-anchor" data-placement={below ? "below" : undefined}>
      <button
        type="button"
        className="chat-model"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${subject} runs on ${current ?? "the default account"}`}
        title={disabled ? "Wait for the reply to finish" : `${subject} runs on ${current ?? "the default account"}`}
        disabled={busy || disabled}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
          setAsking(null);
        }}
      >
        {mine && <CapacityGlyph room={room(mine)} />}
        <span className="chat-model-label">{current ?? "Account"}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div className="chat-model-pop chat-perm-pop" role="dialog" aria-label="Claude account">
          {accounts.map((a) => {
            const left = room(a);
            const out = signedOut(a);
            const hint = out ? "Signed out" : a.error ? "Limits unavailable" : left === 0 ? `Full${fullReset(a)}` : a.inUse ? "default" : "";
            return (
              <button
                key={a.account}
                type="button"
                className="chat-perm-option chat-acct-option"
                aria-pressed={a.account === current}
                disabled={a.account !== current && (out || left === 0)}
                title={a.error ?? a.windows.map((w) => `${windowLabel(w)} ${Math.round(w.usedPercent)}%`).join(" · ") + " used"}
                onClick={() => void pick(a.account)}
              >
                <CapacityGlyph room={left} />
                <span className="chat-perm-label">{a.account}</span>
                <span className="chat-acct-left" data-tone={tone(left)}>{left ? `${left}% left` : ""}</span>
                <Check className="chat-perm-check" size={14} aria-hidden />
                {hint && <span className="chat-perm-hint">{hint}</span>}
              </button>
            );
          })}
          {asking ? (
            <div className="chat-perm-foot chat-acct-confirm" role="alertdialog" aria-label={asking.text}>
              <span>{asking.text}</span>
              <span className="chat-acct-confirm-actions">
                <button type="button" className="chat-model-manage" onClick={() => setAsking(null)}>
                  Cancel
                </button>
                <button type="button" className="chat-model-manage" onClick={() => void pick(asking.account, true)}>
                  Restart
                </button>
              </span>
            </div>
          ) : (
            <p className="chat-perm-foot">{footer}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Shown when Claude refused a message for a limit: one click moves the chat to a free account. */
export function ChatLimitBar({
  current,
  resetsAtMs,
  note,
  next,
  onContinue,
}: {
  current: string | null;
  resetsAtMs: number | null;
  /** The CLI's own words for the limit (a terminal pane); replaces the reset time. */
  note?: string;
  next: UsageAccount | null;
  onContinue: (account: string) => void;
}) {
  const [now] = useState(Date.now);
  const [dismissed, setDismissed] = useState(false);
  const reset = resetLabel(resetsAtMs, now);
  if (dismissed) return null;
  return (
    <div className="chat-handoff-bar chat-limit-bar" role="status">
      <span className="chat-handoff-bar-text">
        Limit reached{current ? <> on <strong>{current}</strong></> : null}
        <span className="chat-handoff-bar-hint">
          {note ? `${note}. ` : reset ? `It ${reset}. ` : ""}
          {next ? "Continue on another account, then send again." : "No other account has room right now."}
        </span>
      </span>
      {next && (
        <button type="button" className="chat-model-manage" onClick={() => onContinue(next.account)}>
          Continue on {next.account}
        </button>
      )}
      <button type="button" className="chat-model-icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed(true)}>
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
