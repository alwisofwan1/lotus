"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EyeOff, MoreHorizontal } from "lucide-react";
import { CliLogo } from "@/modules/lotus-settings/components/CliLogo";
import { useDismiss } from "@/modules/chat/ui/ChatModel";
import { getUsageSnapshot, getRemoteUsage, chooseUsageAccount, listAccounts, listRemoteAccounts, setRemoteDefaultAccount } from "@/lib/tauri-api";
import { useLotusSettings } from "@/modules/lotus-settings/lotus-settings-context";
import { requestSignInPane } from "@/modules/workspace-shell/services/sign-in-pane";
import {
  chipAccount,
  machineGroups,
  needsSignIn,
  resetLabel,
  usageTone,
  weeklyWindow,
  windowLabel,
  windowPace,
  type MachineGroup,
  type MachineUsage,
  type ShownAccount,
  type UsageAccount,
  type UsageWindow,
} from "@/modules/workspace-shell/services/usage";

const POLL_MS = 5 * 60_000;
const PROVIDER_NAME: Record<UsageAccount["provider"], string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };
// Antigravity has one login per Mac, so it has no account to choose between.
const canChoose = (a: ShownAccount) => a.provider === "claude" || (a.provider === "codex" && !a.target);
const HIDDEN_KEY = "lotus.usage.hidden";

function readHidden(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

// This Mac's keys keep their pre-machine form, so accounts hidden before stay hidden.
const keyOf = (a: UsageAccount & { target?: string | null }) => `${a.target ? `${a.target}:` : ""}${a.provider}:${a.account}`;
const at = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

function machineNote(g: MachineGroup): string | null {
  if (g.state === "not-connected") return `not connected${g.asOfMs != null ? ` · numbers from ${at(g.asOfMs)}` : ""}`;
  return g.error;
}

/**
 * The rail's subscription meter: the in-use account's weekly figure, and on click every account's
 * limits (plans/subscription-usage/PLAN.md, step 2). Draws nothing outside Tauri or before the
 * first answer, so a browser preview or a slow network leaves the footer as it was.
 */
export function UsageChip() {
  const [accounts, setAccounts] = useState<UsageAccount[] | null>(null);
  // Other machines (Lotus Host over an SSH connection already open); none outside Tauri.
  const [remotes, setRemotes] = useState<MachineUsage[]>([]);
  // Read once on mount; the chip renders nothing until the first snapshot, so no hydration mismatch.
  const [hidden, setHidden] = useState<string[]>(() => (typeof window === "undefined" ? [] : readHidden()));
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  const { openSettings } = useLotusSettings();
  const manage = () => {
    setOpen(false);
    openSettings({ section: "accounts" });
  };
  // A pane on the account's own machine running its `claude auth login`; Settings › Accounts when none can be opened.
  const signIn = (id: string, target: string | null) => {
    (target ? listRemoteAccounts(target).then((r) => r.accounts) : listAccounts())
      .then((list) => {
        const command = list.find((a) => a.id === id)?.loginCommand;
        if (command && requestSignInPane(command, target)) setOpen(false);
        else manage();
      })
      .catch(manage);
  };

  const load = useCallback(() => {
    getUsageSnapshot()
      .then((next) => {
        setAccounts(next);
        setNow(Date.now());
      })
      .catch(() => {});
    getRemoteUsage()
      .then(setRemotes)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const shown = useMemo(() => (accounts ?? []).filter((a) => !hidden.includes(keyOf(a))), [accounts, hidden]);
  const groups = useMemo(
    // Hide before merging: a hidden login here must not swallow its twin on another machine.
    () =>
      machineGroups(
        shown,
        remotes.map((m) => ({ ...m, accounts: m.accounts.filter((a) => !hidden.includes(keyOf({ ...a, target: m.target }))) })),
      ),
    [shown, remotes, hidden],
  );
  // The chip speaks for this Mac only: its default is what a new chat here runs on.
  const lead = chipAccount(shown);
  // With nothing to lead (none found, all hidden) the chip stays, as "Limits", so its popover can still help.
  if (!accounts) return null;
  const weeklyW = lead ? weeklyWindow(lead) : undefined;
  const weekly = weeklyW?.usedPercent;
  const reset = weeklyW ? resetLabel(weeklyW.resetsAtMs, now) : "";

  const hide = (account: ShownAccount) => {
    const next = [...hidden, keyOf(account)];
    setHidden(next);
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
  };

  const makeDefault = (account: ShownAccount) =>
    (account.target
      ? setRemoteDefaultAccount(account.target, account.account)
      : chooseUsageAccount(account.account, account.provider === "codex" ? "codex" : "claude")
    )
      .then(load)
      .catch(() => {});

  // Another machine is asked over its open SSH connection only, so its actions wait for one.
  const reachable = (a: ShownAccount) => !a.target || remotes.some((m) => m.target === a.target && m.state === "live");

  // The account list of one machine, a small provider label before each provider's first account.
  const renderAccounts = (list: ShownAccount[]) =>
    list.map((account, i) => {
      const first = list[i - 1]?.provider !== account.provider;
      const email = account.identity?.email;
      const twin = email ? list.slice(0, i).find((a) => a.provider === account.provider && a.identity?.email === email && a.identity?.org === account.identity?.org) : undefined;
      const sub = [account.identity?.org, account.plan].filter(Boolean).join(" · ");
      return (
        <section key={keyOf(account)} className="ws-usage-account" data-first={first || undefined}>
          {first && (
            <h4 className="ws-usage-provider">
              <CliLogo id={account.provider} size={12} brand />
              {PROVIDER_NAME[account.provider]}
            </h4>
          )}
          <header className="ws-usage-head">
            <span className="ws-usage-name">{email ?? account.account}</span>
            {email && account.provider !== "antigravity" && <span className="ws-usage-id">{account.account}</span>}
            <span className="ws-usage-head-side">
              {account.inUse && account.provider !== "antigravity" ? (
                <span className="ws-usage-inuse" title="New chats and terminals start on this account">
                  Default
                </span>
              ) : (
                canChoose(account) &&
                reachable(account) && (
                  <button
                    type="button"
                    className="ws-usage-use"
                    aria-label={`Make ${account.account} the default`}
                    title={`New chats and terminals ${account.target ? `on ${account.target} ` : ""}start on this account. Open chats keep theirs.`}
                    onClick={() => void makeDefault(account)}
                  >
                    Make default
                  </button>
                )
              )}
              <button type="button" className="ws-usage-hide" aria-label={`Hide ${account.account}`} title="Hide this account" onClick={() => hide(account)}>
                <EyeOff size={13} strokeWidth={1.75} />
              </button>
            </span>
          </header>
          {(twin || sub) && (
            <p className="ws-usage-who">
              {twin && <span className="ws-usage-twin">Same login as {twin.account}</span>}
              {twin && sub && " · "}
              {sub}
            </p>
          )}
          {account.signedInOn && <p className="ws-usage-who">signed in on {account.signedInOn.join(" · ")}</p>}
          {account.windows.length > 0 && (
            <div className="ws-usage-meters">
              {account.windows.map((w) => (
                <UsageRow key={w.kind} window={w} now={now} />
              ))}
            </div>
          )}
          {account.error && (
            <p className="ws-usage-error">
              {needsSignIn(account) && reachable(account) && (
                <button type="button" className="ws-usage-use" aria-label={`Sign in ${account.account}`} onClick={() => signIn(account.account, account.target)}>
                  Sign in
                </button>
              )}{" "}
              {account.error}
              {account.asOfMs != null && ` · numbers from ${at(account.asOfMs)}`}
            </p>
          )}
        </section>
      );
    });

  return (
    <div className="ws-usage" ref={ref}>
      <button
        type="button"
        className="ws-usage-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${lead ? `${lead.account} · ` : ""}${reset ? `weekly ${reset} · ` : ""}Subscription limits · the name is the default account for new chats`}
        onClick={() => {
          if (!open) load();
          setOpen(!open);
        }}
      >
        <span className="ws-usage-chip-name">{lead?.account ?? "Limits"}</span>
        {weekly != null && (
          <>
            <UsageBar percent={weekly} className="ws-usage-chip-bar" />
            <span className="ws-usage-chip-pct" data-tone={usageTone(weekly)}>{Math.round(weekly)}%</span>
            <span className="ws-usage-chip-used">this week</span>
          </>
        )}
        <MoreHorizontal size={14} strokeWidth={1.75} className="ws-usage-chip-more" aria-hidden />
      </button>

      {open && (
        <div className="ws-usage-pop" role="dialog" aria-label="Subscription limits">
          {groups.map((group) => {
            const many = groups.length > 1;
            if (!many) return renderAccounts(group.accounts);
            const note = machineNote(group);
            return (
              <div key={group.target ?? "local"} className="ws-usage-machine">
                <h3 className="ws-usage-machine-name" title={group.target ? `${group.target} · ${remotes.find((m) => m.target === group.target)?.machine ?? ""}` : undefined}>
                  {group.label}
                  {note && <span className="ws-usage-machine-note">{note}</span>}
                </h3>
                {renderAccounts(group.accounts)}
              </div>
            );
          })}
          {accounts.length === 0 && (
            <p className="ws-usage-empty">
              No subscription account found.{" "}
              <button type="button" className="ws-usage-unhide" onClick={manage}>
                Add account
              </button>
            </p>
          )}
          <footer className="ws-usage-foot">
            <span className="ws-usage-updated">Updated {new Date(now).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
            {hidden.length > 0 && (
              <button
                type="button"
                className="ws-usage-unhide"
                onClick={() => {
                  setHidden([]);
                  localStorage.removeItem(HIDDEN_KEY);
                }}
              >
                {hidden.length} hidden
              </button>
            )}
            <button type="button" className="ws-usage-unhide" onClick={manage}>
              Manage…
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

function UsageRow({ window: w, now }: { window: UsageWindow; now: number }) {
  const pace = windowPace(w, now);
  const reset = resetLabel(w.resetsAtMs, now);
  return (
    <div className="ws-usage-row" data-tone={usageTone(w.usedPercent)}>
      <span className="ws-usage-label" title={windowLabel(w)}>
        {windowLabel(w)}
      </span>
      <UsageBar percent={w.usedPercent} pace={pace} className="ws-usage-bar" />
      <span className="ws-usage-pct">{Math.round(w.usedPercent)}%</span>
      <span className="ws-usage-reset">{reset}</span>
    </div>
  );
}

/** One thin line: the used share filled, and a tick for how far through its window we are. */
function UsageBar({ percent, pace, className }: { percent: number; pace?: number | null; className: string }) {
  return (
    <span className={className}>
      <i style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      {pace != null && <b style={{ left: `${pace * 100}%` }} />}
    </span>
  );
}
