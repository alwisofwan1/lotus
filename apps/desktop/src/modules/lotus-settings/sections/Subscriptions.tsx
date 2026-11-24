"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Check, Copy, MoreHorizontal, Plus } from "lucide-react";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  accountRemovalCheck,
  chooseUsageAccount,
  createAccount,
  createRemoteAccount,
  getAntigravityLogin,
  listAccounts,
  listRemoteAccounts,
  removeAccount,
  removeRemoteAccount,
  setRemoteDefaultAccount,
  unhideAccount,
  type AccountProvider,
  type AccountRemovalCheck,
  type AccountView,
  type SingleLogin,
} from "@/lib/tauri-api";
import { CliLogo } from "../components/CliLogo";
import { requestSignInPane } from "@/modules/workspace-shell/services/sign-in-pane";
import { machineLabel } from "@/modules/workspace-shell/services/usage";
import { useLotusSettings } from "../lotus-settings-context";
import { Input } from "@/components/ui/field";
import { Tag } from "@/components/ui/status";
import { SettingRow, SettingsGroup } from "../components/SettingsGroup";

/**
 * Settings › Accounts › Claude (mockups/accounts-multi-provider.html, step 2): every Claude account
 * Lotus found, the default for new chats, and Add / Sign in / Delete. Each row shows who it is; the
 * folder and where Lotus found it are in the row's drawer (⋯). With `target`, the
 * same for another machine over its open SSH connection (issues/05).
 *
 * Delete (mockups/accounts-unified.html, decisions 4–6): a Lotus-made account is deleted; a ccs or
 * env account is removed from Lotus (hidden everywhere, files untouched), and a ccs one can also
 * have its folder deleted when the checkbox says so. Rules live in `accounts::remove_in`.
 *
 * `provider="codex"`: the same for Codex, one `CODEX_HOME` per account (multi-provider step 3).
 * Codex has no shared context to link, and other machines list Claude only.
 */
export function Subscriptions({ target = null, provider = "claude" }: { target?: string | null; provider?: AccountProvider }) {
  const p = PROVIDER[provider];
  const { closeSettings } = useLotusSettings();
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [separate, setSeparate] = useState(false);
  // The row whose drawer (details + remove) is open, and whether it is at the remove step.
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  // The command to copy when no Code shell is there to open a pane.
  const [manual, setManual] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const where = target ? machineLabel(target) : null;

  const load = useCallback(() => {
    (target ? listRemoteAccounts(target).then((r) => r.accounts) : listAccounts(provider))
      .then((rows) => {
        setAccounts(rows);
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [target, provider]);
  useEffect(load, [load]);

  const signIn = (account: AccountView) => {
    if (requestSignInPane(account.loginCommand, target)) {
      setManual(null);
      closeSettings();
    } else setManual(account.loginCommand);
  };

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(String(e));
    }
  };

  const add = () =>
    run(async () => {
      const created = await (target ? createRemoteAccount(target, name.trim(), separate) : createAccount(name.trim(), separate, provider));
      setName("");
      setAdding(false);
      setAccounts((rows) => [...rows, created]);
      signIn(created);
    });

  const remove = (id: string, purge: boolean) =>
    run(async () => {
      await (target ? removeRemoteAccount(target, id) : removeAccount(id, purge, provider));
      setOpen(null);
      load();
    });

  const choose = (id: string) =>
    void run(async () => {
      await (target ? setRemoteDefaultAccount(target, id) : chooseUsageAccount(id, provider));
      load();
    });

  const toggle = (id: string) => {
    setConfirming(false);
    setOpen(open === id ? null : id);
  };

  // Another machine's host only deletes its own Lotus-made accounts (remote_accounts.rs).
  const removable = (a: AccountView) => (target ? a.source === "lotus" : a.source !== "default" && !a.inUse);
  const shown = accounts.filter((a) => !a.hidden);
  const hidden = accounts.filter((a) => a.hidden);
  const loginCount = shown.filter((a) => a.identity).length;

  return (
    <SettingsGroup
      title={p.name}
      meta={`${loginCount} signed in${shown.length > loginCount ? ` · ${shown.length - loginCount} not` : ""}`}
      action={
        <Button variant="ghost" size="sm" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          <Plus size={13} aria-hidden /> Add
        </Button>
      }
      description={
        target
          ? `The logins ${p.name} runs on, on ${where}. New chats there start on the default one.`
          : `The logins ${p.name} runs on. New chats and terminals start on the default one; open chats keep theirs.`
      }
      footer={
        manual || error ? (
          <>
            {manual && (
              <span className="block">
                Run this in a terminal{where ? ` on ${where}` : ""} to sign in: <code className="font-mono text-(--ui-ink) select-all">{manual}</code>
              </span>
            )}
            {error && (
              <span className="mt-1.5 block text-(--ui-err)" role="alert">
                {error}
              </span>
            )}
          </>
        ) : undefined
      }
      as="ul"
    >
      {shown.map((a, i) => {
        const twin = a.identity && shown.slice(0, i).find((b) => b.identity?.email === a.identity?.email && b.identity?.org === a.identity?.org);
        return (
          <SettingRow
            key={a.id}
            as="li"
            leading={<Initials account={a} />}
            label={
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{a.identity?.email ?? a.id}</span>
                {a.identity && <span className="shrink-0 text-(length:--ds-t-meta) font-normal text-(--ui-ink-4)">{a.id}</span>}
              </span>
            }
            description={
              <span className="block truncate">
                {twin && <span className="text-(--ui-warn)">Same login as {twin.id} · </span>}
                {a.identity ? (a.identity.org ?? "Personal") : "Not signed in"}
                {!a.identity && a.context === "isolated" ? " · own chats and memory" : ""}
              </span>
            }
            body={
              open === a.id ? (
                confirming ? (
                  <RemoveConfirm account={a} provider={provider} remote={!!target} onCancel={() => setConfirming(false)} onRemove={(purge) => void remove(a.id, purge)} />
                ) : (
                  <Details account={a} provider={provider} onRemove={removable(a) ? () => setConfirming(true) : undefined} />
                )
              ) : undefined
            }
          >
            {!a.identity ? (
              <Button variant="secondary" size="sm" aria-label={`Sign in ${a.id}`} onClick={() => signIn(a)}>
                Sign in
              </Button>
            ) : a.inUse ? (
              <Tag>
                <span className="inline-flex items-center gap-1">
                  <Check size={11} aria-hidden />
                  Default
                </span>
              </Tag>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="opacity-0 focus-visible:opacity-100 [.ui-row-item:hover_&]:opacity-100"
                aria-label={`Make ${a.id} the default${where ? ` on ${where}` : ""}`}
                onClick={() => choose(a.id)}
              >
                Make default
              </Button>
            )}
            <Button variant="ghost" size="sm" aria-label={`More for ${a.id}`} aria-expanded={open === a.id} onClick={() => toggle(a.id)}>
              <MoreHorizontal size={14} aria-hidden />
            </Button>
          </SettingRow>
        );
      })}
      {adding && (
        <li className="ui-row-item">
          <form
            className="ui-row flex-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void add();
            }}
          >
            <Input mono autoFocus aria-label="New account name" placeholder="work, client-a…" value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
            {provider === "claude" && (
              <label className="flex items-center gap-2 text-(length:--ds-t-meta) text-(--ui-ink-2)" title="For client work. Off: it sees the same chats, memory, skills and CLAUDE.md as your other accounts.">
                <Switch checked={separate} onChange={setSeparate} label="Keep chats and memory separate" />
                Keep chats separate
              </label>
            )}
            <Button type="submit" size="sm" disabled={!name.trim()}>
              Sign in with browser
            </Button>
          </form>
        </li>
      )}
      {hidden.length > 0 && (
        <SettingRow
          as="li"
          muted
          label={`${hidden.length} removed from Lotus`}
          description="Not offered in Chat, Code, Canvas or Usage. Their files are untouched."
          body={
            showHidden ? (
              <ul className="flex flex-col gap-1.5">
                {hidden.map((a) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <span className="flex-1 truncate">
                      {a.id} <span className="text-(--ui-ink-4)">{a.identity?.email}</span>
                    </span>
                    <Button size="sm" variant="ghost" aria-label={`Show ${a.id} again`} onClick={() => void run(async () => { await unhideAccount(a.id, provider); load(); })}>
                      Show again
                    </Button>
                  </li>
                ))}
              </ul>
            ) : undefined
          }
        >
          <Button size="sm" variant="ghost" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? "Hide list" : "Show"}
          </Button>
        </SettingRow>
      )}
    </SettingsGroup>
  );
}

/**
 * Antigravity keeps one login per Mac user (Keychain `gemini`/`antigravity`, `accounts.rs`), so it
 * gets one row and no Add (mockups/accounts-multi-provider.html, "One login only"). Hidden when
 * `agy` is not installed.
 */
export function AntigravityLogin() {
  const { closeSettings } = useLotusSettings();
  const [login, setLogin] = useState<SingleLogin | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  useEffect(() => {
    getAntigravityLogin()
      .then(setLogin)
      .catch(() => {});
  }, []);
  if (!login) return null;
  const signIn = () => {
    if (requestSignInPane(login.loginCommand, null)) closeSettings();
    else setManual(login.loginCommand);
  };
  return (
    <SettingsGroup
      title="Antigravity"
      meta="One login per Mac"
      description="Antigravity keeps one login for this Mac user, so there is no Add. To switch, sign out and in again inside agy."
      footer={
        manual ? (
          <span className="block">
            Run this in a terminal to sign in: <code className="font-mono text-(--ui-ink) select-all">{manual}</code>
          </span>
        ) : undefined
      }
      as="ul"
    >
      <SettingRow
        as="li"
        leading={
          <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-(--ui-fill)">
            <CliLogo id="antigravity" brand size={14} />
          </span>
        }
        label={login.email ?? (login.signedIn ? "Signed in" : "Not signed in")}
        description={login.signedIn ? "Google account" : "Opens agy to sign in with Google"}
      >
        {!login.signedIn && (
          <Button variant="secondary" size="sm" aria-label="Sign in Antigravity" onClick={signIn}>
            Sign in
          </Button>
        )}
      </SettingRow>
    </SettingsGroup>
  );
}

/** Two letters for the row: the folder name, so two logins with one email still look different. */
function Initials({ account }: { account: AccountView }) {
  const letters = account.id.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";
  return (
    <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-(--ui-fill) text-[11px] font-semibold text-(--ui-ink-3)">
      {letters}
    </span>
  );
}

const PROVIDER: Record<AccountProvider, { name: string; envKey: string }> = {
  claude: { name: "Claude", envKey: "CLAUDE_CONFIG_DIR" },
  codex: { name: "Codex", envKey: "CODEX_HOME" },
};

const foundIn = (source: AccountView["source"], provider: AccountProvider) =>
  ({ default: `${PROVIDER[provider].name}'s own folder`, env: `From ${PROVIDER[provider].envKey}`, ccs: "From ccs", lotus: "Made in Lotus" })[source];

/** Home as `~`, for display only (the title and the copy keep the full path). */
const tildePath = (dir: string) => dir.replace(/^(\/Users|\/home)\/[^/]+/, "~");

/** The row's drawer: the folder, then where it came from and whether it shares chats and memory. */
function Details({ account, provider, onRemove }: { account: AccountView; provider: AccountProvider; onRemove?: () => void }) {
  const [copied, setCopied] = useState(false);
  const shared = account.source === "default" || account.context === "shared";
  return (
    <div className="flex items-center gap-3 text-(length:--ds-t-meta) text-(--ui-ink-3)">
      <div className="group flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-(length:--ds-t-micro) text-(--ui-ink-2)" title={account.dir}>
            {tildePath(account.dir)}
          </span>
          <button
            type="button"
            className="shrink-0 text-(--ui-ink-4) opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-(--ui-ink)"
            aria-label={`Copy the folder of ${account.id}`}
            onClick={() => void copyTextToClipboard(account.dir).then(() => setCopied(true))}
          >
            {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
          </button>
        </span>
        <span>
          {foundIn(account.source, provider)}
          {provider === "claude" && (shared ? " · shared chats and memory" : " · own chats and memory")}
        </span>
      </div>
      {onRemove && (
        <Button size="sm" variant="ghost" className="text-(--ui-err)" aria-label={`${account.source === "lotus" ? "Delete" : "Remove"} ${account.id}`} onClick={onRemove}>
          {account.source === "lotus" ? "Delete…" : "Remove…"}
        </Button>
      )}
    </div>
  );
}

/**
 * The confirm under a row. What it says follows what the click will do: hide (ccs/env), or delete a
 * folder (a Lotus account, or ccs with the box ticked). A delete is blocked while anything runs on
 * the account, and needs the name typed when chats exist only in that folder.
 */
function RemoveConfirm({
  account,
  provider,
  remote,
  onCancel,
  onRemove,
}: {
  account: AccountView;
  provider: AccountProvider;
  remote: boolean;
  onCancel: () => void;
  onRemove: (purge: boolean) => void;
}) {
  const [purge, setPurge] = useState(false);
  const [typed, setTyped] = useState("");
  const [check, setCheck] = useState<AccountRemovalCheck | null>(null);
  const lotus = account.source === "lotus";
  const deletes = lotus || purge;

  useEffect(() => {
    // Another machine's processes and folders are not visible from here; its host checks for itself.
    if (remote) return;
    let live = true;
    accountRemovalCheck(account.id, provider)
      .then((c) => live && setCheck(c))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [account.id, provider, remote]);

  const running = deletes ? (check?.running ?? []) : [];
  const onlyHere = deletes && (account.context === "isolated" || !!check?.ownHistory);
  const blocked = running.length > 0 || (onlyHere && typed !== account.id);

  const typeToConfirm = onlyHere && running.length === 0;
  const actions = (
    <>
      <span className="flex-1" />
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" variant={deletes ? "danger" : "secondary"} disabled={blocked} onClick={() => onRemove(purge)}>
        {deletes ? "Delete" : "Remove"}
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-2.5 rounded-(--ui-r-md) bg-(--ui-fill) px-3.5 py-3 text-(length:--ds-t-meta) text-(--ui-ink-2)">
      <p>
        <span className="block text-(--ui-ink)">{lotus ? `Delete ${account.id}?` : `Remove ${account.id} from Lotus?`}</span>
        <span className="text-(--ui-ink-3)">
          {lotus
            ? "Deletes its folder and signs it out."
            : account.source === "env"
              ? `It comes from ${PROVIDER[provider].envKey} in your shell, so Lotus only hides it.`
              : "Its files and login stay. You can show it again below."}
        </span>
      </p>
      {account.source === "ccs" && (
        <label className="flex items-center gap-2.5">
          <Switch checked={purge} onChange={setPurge} label="Also delete its folder and sign out" />
          Also delete its folder and sign out
        </label>
      )}
      {running.length > 0 && (
        <p className="text-(--ui-warn)" role="alert">
          {running.map((r) => r.replace(/^\d+\s+/, "")).join(", ")} still {running.length > 1 ? "run" : "runs"} on {account.id}. Close {running.length > 1 ? "them" : "it"} first.
        </p>
      )}
      {typeToConfirm && <p className="text-(--ui-err)">Its chats and memory exist only here and will be gone.</p>}
      <div className="flex items-center gap-2">
        {typeToConfirm && (
          <>
            <span>
              Type <b className="font-medium text-(--ui-ink)">{account.id}</b>
            </span>
            <Input mono aria-label={`Type ${account.id} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} className="w-36" />
          </>
        )}
        {actions}
      </div>
    </div>
  );
}
