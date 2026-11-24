"use client";

import {
  Activity,
  BellRing,
  Check,
  Copy,
  GitPullRequest,
  KeyRound,
  MessageSquare,
  Monitor,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Unplug,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { DetailHeader, DetailSection, MenuItem, OverflowMenu, Pill } from "@/components/resource/resource-kit";
import { SlackMark } from "@/components/icons/ServiceMarks";

import {
  describeSlack,
  describeSlackCheck,
  type AutomationUse,
  type ConnectorsClient,
  type SlackEmojiView,
  type SlackReactionsView,
  type SlackStatus,
  type StatusReactions,
} from "../services/connectors-api";
import { loadEmojiCatalog, type EmojiCatalog } from "../services/emoji-catalog";
import {
  cleanNames,
  emojiName,
  lookupEmoji,
  MAX_SENT,
  namesText,
  parseNames,
  REACTION_STATES,
  sameReactions,
  SENT_VERDICTS,
  type StateKey,
} from "../services/status-reactions";
import { EmojiMark, EmojiPanel } from "./ReactionPicker";
import { ConnectorTabs, HealthPill, HowItWorks, Stat, StatStrip, UsedBy, type HowItem } from "./connector-parts";

type SlackTab = "overview" | "reactions" | "alerts";

const HOW: HowItem[] = [
  { icon: GitPullRequest, title: "Starts a review", text: "A PR link that mentions you or your team, or your own :eyes:, in a watched channel." },
  { icon: Activity, title: "Shows progress", text: "Your own reactions on the request: taken, waiting, running, done." },
  { icon: Send, title: "Replies as you", text: "Only after you press Send on a draft. Nothing goes out on its own." },
  { icon: BellRing, title: "Alerts you", text: "Factory alerts arrive as a DM from the Lotus bot, once you add it." },
];

/** The full fine print, folded under the cards. */
const FINE_PRINT = (
  <ul className="cn-list">
    <li>A message in a watched channel with a PR link that mentions you or your team starts a review.</li>
    <li>Your own :eyes: on a message with a PR link starts one too.</li>
    <li>
      Every few minutes Lotus also reads the watched channels and recent review threads, so a request Slack did not
      deliver live still starts its review.
    </li>
    <li>
      The request shows where its review is, as your own reactions: taken in hand (also when someone else already
      asked about the same commit), waiting for a free slot, running, done, failed, asks you, skipped. You choose the
      emoji, or none, under Status reactions.
    </li>
    <li>Scheduled results can arrive as a DM to yourself. Channel posts always wait for your Send.</li>
    <li>Replies go out as you, only after you press Send on a draft.</li>
    <li>With the bot added, Factory alerts arrive as a DM from the Lotus bot. The bot posts nowhere else.</li>
  </ul>
);

/**
 * Slack, set up once with two tokens from the user's own Slack app (Socket Mode, no public URL).
 * A third, the bot's, is optional and only DMs the user Factory alerts (CoS 11). The tokens go
 * straight to the macOS Keychain through Rust and never come back.
 *
 * Once connected the page splits by the question the user came with: is it working (Overview),
 * what does a request show (Status reactions), how do alerts reach me (Alerts).
 */
export function SlackConnector({
  client,
  status,
  usedBy,
}: {
  client: ConnectorsClient;
  status: SlackStatus | null;
  usedBy: AutomationUse[];
}) {
  const state = status?.state ?? "not_set_up";
  const { health, status: line } = describeSlack(status);
  const [tab, setTab] = useState<SlackTab>("overview");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disconnect = () => {
    setError(null);
    client
      .slackDisconnect()
      .then(() => setConfirm(false))
      .catch((e: unknown) => setError(String(e)));
  };

  return (
    <>
      <DetailHeader
        icon={<SlackMark size={20} />}
        title="Slack"
        meta={
          <span className="cn-headmeta">
            <HealthPill health={health}>{line}</HealthPill>
            {status?.userId ? <span>as {status.userId}</span> : null}
          </span>
        }
        actions={
          state === "not_set_up" ? null : (
            <OverflowMenu label="Slack actions">
              <MenuItem icon={<Unplug size={14} />} tone="danger" onSelect={() => setConfirm(true)}>
                Disconnect
              </MenuItem>
            </OverflowMenu>
          )
        }
      />

      {confirm ? (
        <div className="au-callout au-callout--danger cn-confirm" role="alertdialog" aria-label="Disconnect Slack">
          <p>Disconnect Slack? Lotus stops listening and deletes both tokens from the Keychain. Automations stay.</p>
          <span className="au-draft-actions">
            <button type="button" className="rs-button rs-button--ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button type="button" className="rs-button rs-button--danger" onClick={disconnect}>
              Disconnect
            </button>
          </span>
        </div>
      ) : null}
      {error ? (
        <p className="au-error" role="alert">
          {error}
        </p>
      ) : null}

      {state === "not_set_up" ? (
        <>
          <SlackSetup client={client} />
          <HowItWorks id="cn-slack-does" items={HOW} details={FINE_PRINT} />
          <UsedBy automations={usedBy} empty="No automation uses Slack yet." />
        </>
      ) : (
        <ConnectorTabs<SlackTab>
          label="Slack"
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "reactions", label: "Status reactions" },
            { id: "alerts", label: "Alerts" },
          ]}
          value={tab}
          onChange={setTab}
          panels={{
            overview: <SlackOverview client={client} status={status} usedBy={usedBy} />,
            reactions: <ReactionSettings client={client} status={status} />,
            alerts: <FactoryAlerts client={client} status={status} />,
          }}
        />
      )}
    </>
  );
}

/** Is it working, did it miss anything, and what leans on it — then what it does, and the facts. */
function SlackOverview({ client, status, usedBy }: { client: ConnectorsClient; status: SlackStatus | null; usedBy: AutomationUse[] }) {
  const on = usedBy.filter((a) => a.enabled).length;
  const connection = describeConnection(status);
  return (
    <>
      {status?.state === "connected" && status.detail ? (
        <p className="au-callout au-callout--warn cn-panel-callout" role="status">
          {status.detail}
        </p>
      ) : null}
      {status?.state === "standby" ? <p className="au-callout cn-panel-callout">{status.detail}</p> : null}
      {status?.state === "stopped" ? (
        <p className="au-callout au-callout--danger cn-panel-callout">
          Lotus stopped trying{status.detail ? `: ${status.detail}` : ""}. Disconnect, then connect again with fresh tokens.
        </p>
      ) : null}

      <StatStrip label="Slack at a glance">
        <Stat label="Connection" value={connection.value} tone={connection.tone}>
          Socket Mode, outbound only
          {status?.connections ? ` · ${status.connections} connection${status.connections === 1 ? "" : "s"}` : null}
        </Stat>
        <MissedMessageCheck client={client} status={status} />
        <Stat label="Used by" value={`${usedBy.length} automation${usedBy.length === 1 ? "" : "s"}`}>
          {usedBy.length ? `${on} on, ${usedBy.length - on} off` : "None yet"}
        </Stat>
      </StatStrip>

      <HowItWorks id="cn-slack-does" items={HOW} details={FINE_PRINT} />
      <UsedBy automations={usedBy} empty="No automation uses Slack yet." />

      <DetailSection title="Details" id="cn-slack-details">
        <div className="au-facts cn-facts">
          <div className="au-fact">
            <span className="au-fact-label">Workspace</span>
            <span className="au-fact-value">{status?.team ?? "Unknown"}</span>
          </div>
          <div className="au-fact">
            <span className="au-fact-label">Acts as</span>
            <span className="au-fact-value">{status?.userId ?? "Unknown"}</span>
          </div>
          <div className="au-fact">
            <span className="au-fact-label">Tokens</span>
            <span className="au-fact-value">
              <KeyRound size={13} aria-hidden /> macOS Keychain
            </span>
          </div>
        </div>
      </DetailSection>
    </>
  );
}

function describeConnection(status: SlackStatus | null): { value: string; tone: "ok" | "warn" | "danger" | "off" } {
  switch (status?.state) {
    case "connected":
      return status.detail ? { value: "Catch-up only", tone: "warn" } : { value: "Live", tone: "ok" };
    case "standby":
      return { value: "Not listening", tone: "off" };
    case "connecting":
    case "retrying":
      return { value: "Connecting…", tone: "warn" };
    case "stopped":
      return { value: "Stopped", tone: "danger" };
    default:
      return { value: "Off", tone: "off" };
  }
}

function SlackSetup({ client }: { client: ConnectorsClient }) {
  const [appToken, setAppToken] = useState("");
  const [userToken, setUserToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.slackConnect(appToken, userToken);
      setAppToken("");
      setUserToken("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyManifest = async () => {
    try {
      await navigator.clipboard.writeText(await client.slackManifest());
      setCopied(true);
    } catch (e) {
      setError(`Could not copy the manifest: ${String(e)}`);
    }
  };

  return (
    <DetailSection title="Set up" id="cn-slack-setup">
      <form className="cn-setup" aria-label="Connect Slack" onSubmit={(e) => void connect(e)}>
        <ol className="cn-steps">
          <li data-done={copied ? "" : undefined}>
            <span className="cn-step-title">Copy the app manifest</span>
            <span className="cn-step-text">Lotus wrote it for you: the scopes and events it needs.</span>
            <button type="button" className="rs-button" onClick={() => void copyManifest()}>
              {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
              {copied ? "Manifest copied" : "Copy the app manifest"}
            </button>
          </li>
          <li>
            <span className="cn-step-title">Create the app in Slack</span>
            <span className="cn-step-text">
              At <code>api.slack.com/apps</code>: Create New App, From a manifest, paste, Create. Then Install to your
              workspace.
            </span>
          </li>
          <li data-done={appToken ? "" : undefined}>
            <span className="cn-step-title">Paste the app-level token</span>
            <span className="cn-step-text">
              Basic Information, App-Level Tokens: generate one with the <code>connections:write</code> scope.
            </span>
            <label className="au-field">
              <span className="au-label">App-level token</span>
              <input
                className="au-input"
                type="password"
                autoComplete="off"
                placeholder="xapp-…"
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
              />
            </label>
          </li>
          <li data-done={userToken ? "" : undefined}>
            <span className="cn-step-title">Paste your user token</span>
            <span className="cn-step-text">OAuth &amp; Permissions: copy the User OAuth Token.</span>
            <label className="au-field">
              <span className="au-label">User OAuth token</span>
              <input
                className="au-input"
                type="password"
                autoComplete="off"
                placeholder="xoxp-…"
                value={userToken}
                onChange={(e) => setUserToken(e.target.value)}
              />
            </label>
          </li>
        </ol>
        {error ? (
          <p className="au-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="au-form-foot cn-setup-foot">
          <span className="au-note">
            <Pill>As you</Pill> Lotus reads and replies as you. Tokens go to the macOS Keychain.
          </span>
          <span className="au-draft-actions">
            <button type="submit" className="rs-button rs-button--primary" disabled={busy || !appToken || !userToken}>
              {busy ? "Checking…" : "Connect"}
            </button>
          </span>
        </div>
      </form>
    </DetailSection>
  );
}

/**
 * The Factory Chief of Staff's alerts (CoS 11): a macOS notification always, and a DM from the
 * Lotus bot once its token is saved. A DM you send yourself does not ping your phone; a bot's does.
 */
function FactoryAlerts({ client, status }: { client: ConnectorsClient; status: SlackStatus | null }) {
  const [botToken, setBotToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const hasBot = Boolean(status?.bot);

  const run = (work: () => Promise<unknown>, done: string | null) => {
    setBusy(true);
    setOutcome(null);
    work()
      .then(() => setOutcome(done ? { ok: true, text: done } : null))
      .catch((e: unknown) => setOutcome({ ok: false, text: String(e) }))
      .finally(() => setBusy(false));
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    run(() => client.slackSetBotToken(botToken).then(() => setBotToken("")), null);
  };
  const copyManifest = () => {
    client
      .slackManifest()
      .then((text) => navigator.clipboard.writeText(text))
      .then(() => setCopied(true))
      .catch((e: unknown) => setOutcome({ ok: false, text: `Could not copy the manifest: ${String(e)}` }));
  };

  return (
    <DetailSection title="Factory alerts" id="cn-slack-alerts">
      <ul className="cn-route" aria-label="Where alerts go">
        <li className="cn-route-item">
          <span className="cn-how-icon" aria-hidden>
            <Monitor size={15} strokeWidth={1.75} />
          </span>
          <span className="cn-how-text">
            <span className="cn-how-title">macOS notification</span>
            <span className="cn-how-line">Always</span>
          </span>
          <Check size={14} className="cn-route-check" aria-label="On" />
        </li>
        <li className="cn-route-item" data-off={hasBot ? undefined : ""}>
          <span className="cn-how-icon" aria-hidden>
            <MessageSquare size={15} strokeWidth={1.75} />
          </span>
          <span className="cn-how-text">
            <span className="cn-how-title">Slack DM from the Lotus bot</span>
            <span className="cn-how-line">{hasBot ? "Your phone pings too" : "Add the bot below"}</span>
          </span>
          {hasBot ? <Check size={14} className="cn-route-check" aria-label="On" /> : null}
        </li>
      </ul>
      <p className="cn-step-text cn-alerts-line">
        Alerts go to <strong>{hasBot ? "macOS + Slack DM" : "macOS only"}</strong>. When a Factory run or PR needs you,
        the Chief of Staff tells you once, at most every 15 minutes.
        {hasBot ? null : " Add the Lotus bot so your phone pings when you are away."}
      </p>
      {hasBot ? (
        <div className="au-form-foot">
          <span className={outcome?.ok === false ? "au-error" : "cn-check-outcome"} role="status" aria-live="polite">
            {outcome?.text ?? ""}
          </span>
          <span className="au-draft-actions">
            <button
              type="button"
              className="rs-button"
              disabled={busy}
              onClick={() => run(() => client.slackTestBot(), "Sent. Check that your phone pinged.")}
            >
              <Send size={13} aria-hidden />
              {busy ? "Sending…" : "Send a test DM"}
            </button>
          </span>
        </div>
      ) : (
        <form className="cn-setup" aria-label="Add the Lotus bot" onSubmit={save}>
          <ol className="cn-steps">
            <li data-done={copied ? "" : undefined}>
              <span className="cn-step-title">Copy the app manifest again</span>
              <span className="cn-step-text">It now adds a bot user.</span>
              <button type="button" className="rs-button" onClick={copyManifest}>
                {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                {copied ? "Manifest copied" : "Copy the app manifest"}
              </button>
            </li>
            <li>
              <span className="cn-step-title">Update the app in Slack</span>
              <span className="cn-step-text">
                At <code>api.slack.com/apps</code>, open your Lotus app: App Manifest, paste, Save. Then Install App,
                Reinstall to Workspace, and allow.
              </span>
            </li>
            <li data-done={botToken ? "" : undefined}>
              <span className="cn-step-title">Paste the bot token</span>
              <span className="cn-step-text">OAuth &amp; Permissions: copy the Bot User OAuth Token.</span>
              <label className="au-field">
                <span className="au-label">Bot User OAuth token</span>
                <input
                  className="au-input"
                  type="password"
                  autoComplete="off"
                  placeholder="xoxb-…"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                />
              </label>
            </li>
          </ol>
          {outcome && !outcome.ok ? (
            <p className="au-error" role="alert">
              {outcome.text}
            </p>
          ) : null}
          <div className="au-form-foot cn-setup-foot">
            <span className="au-note">The bot only DMs you. It never posts anywhere else.</span>
            <span className="au-draft-actions">
              <button type="submit" className="rs-button rs-button--primary" disabled={busy || !botToken}>
                {busy ? "Checking…" : "Save bot token"}
              </button>
            </span>
          </div>
        </form>
      )}
    </DetailSection>
  );
}

/**
 * When Lotus last read Slack for messages the live connection missed, and a way to do it now —
 * the answer to "did Lotus see that request?" without waiting for the next check.
 */
function MissedMessageCheck({ client, status }: { client: ConnectorsClient; status: SlackStatus | null }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const line = describeSlackCheck(status, nowMs);
  if (!line) return null;

  const checkNow = () => {
    setChecking(true);
    setOutcome(null);
    client
      .slackCheckNow()
      .then((after) =>
        setOutcome(after.detail ? null : { ok: true, text: "Nothing missed. Every request so far arrived live." }),
      )
      .catch((e: unknown) => setOutcome({ ok: false, text: String(e) }))
      .finally(() => {
        setChecking(false);
        setNowMs(Date.now());
      });
  };

  // `detail` on a connected Slack says some requests came only through the catch-up.
  const value = !status?.checkedAtMs ? "Not checked yet" : status.detail ? "Some came late" : "None missed";
  return (
    <Stat label="Missed messages" value={value}>
      <span>{line}</span>
      <button
        type="button"
        className="cn-stat-action"
        onClick={checkNow}
        disabled={checking || status?.state !== "connected"}
        aria-busy={checking}
      >
        <RefreshCw size={12} aria-hidden className={checking ? "cn-spin" : undefined} />
        {checking ? "Checking…" : "Check now"}
      </button>
      <span className={outcome?.ok === false ? "au-error cn-stat-outcome" : "cn-check-outcome cn-stat-outcome"} role="status" aria-live="polite">
        {outcome?.text ?? ""}
      </span>
    </Stat>
  );
}

/** The states the preview can show, and what the request message carries in each. */
const PREVIEW_STATES: { id: string; label: string }[] = [
  { id: "taken", label: "Taken" },
  { id: "queued", label: "Waiting" },
  { id: "running", label: "Running" },
  { id: "done", label: "Done" },
  { id: "sent", label: "Sent" },
];

/** The emoji on the request message at `state`: the taken one stays, the state's own sits beside it. */
function previewNames(draft: StatusReactions, state: string): string[] {
  const own = state === "sent" ? cleanNames(draft.sent.looksGood) : state === "taken" ? [] : [emojiName(draft[state as StateKey])];
  return [...new Set([emojiName(draft.taken), ...own].filter(Boolean))];
}

/** How many states and verdicts differ between two sets of reactions. */
function countChanges(a: StatusReactions, b: StatusReactions): number {
  return (
    REACTION_STATES.filter(({ key }) => emojiName(a[key]) !== emojiName(b[key])).length +
    SENT_VERDICTS.filter(({ key }) => cleanNames(a.sent[key]).join(" ") !== cleanNames(b.sent[key]).join(" ")).length
  );
}

/**
 * The emoji a review request shows for each state, as the user's own reactions. Saved in Rust and
 * used from the next request on, no reconnect. Slack only refuses an unknown name when Lotus uses
 * it, so the last refusal shows here.
 *
 * The emoji is the control (it opens the picker); the name stays editable beside it, for a custom
 * emoji the picker has not loaded yet.
 */
function ReactionSettings({ client, status }: { client: ConnectorsClient; status: SlackStatus | null }) {
  const [view, setView] = useState<SlackReactionsView | null>(null);
  const [draft, setDraft] = useState<StatusReactions | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  // The standard emoji (loaded on first use) and the workspace's own, for the pickers and the preview.
  const [catalog, setCatalog] = useState<EmojiCatalog | null>(null);
  const [custom, setCustom] = useState<SlackEmojiView | null>(null);
  const [loadingCustom, setLoadingCustom] = useState(false);
  // The state (or `sent-<verdict>`) whose picker is open; one at a time.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState("running");

  // The saved reactions, to tell an unsaved edit when the effect below reads them again.
  const saved = useRef<StatusReactions | null>(null);

  // Read again whenever Slack's status changes, to show a refusal from a review that just ran.
  // An unsaved edit is kept.
  useEffect(() => {
    let live = true;
    client
      .slackReactions()
      .then((next) => {
        if (!live) return;
        const before = saved.current;
        saved.current = next.reactions;
        setView(next);
        setDraft((d) => (d && before && !sameReactions(d, before) ? d : next.reactions));
      })
      .catch(() => null);
    return () => {
      live = false;
    };
  }, [client, status]);

  useEffect(() => {
    let live = true;
    loadEmojiCatalog()
      .then((c) => live && setCatalog(c))
      .catch(() => null);
    return () => {
      live = false;
    };
  }, []);

  const connected = status?.state === "connected";
  const loadCustom = (refresh: boolean) => {
    setLoadingCustom(true);
    client
      .slackEmoji(refresh)
      .then(setCustom)
      .catch(() => null)
      .finally(() => setLoadingCustom(false));
  };
  // The workspace's emoji, once Slack is connected; Rust keeps them 10 minutes.
  useEffect(() => {
    if (connected) loadCustom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadCustom only reads `client`
  }, [client, connected]);

  if (!view || !draft) return null;
  const changes = countChanges(draft, view.reactions);
  const dirty = !sameReactions(draft, view.reactions);
  const isDefault = sameReactions(draft, view.defaults);

  const edit = (next: StatusReactions) => {
    setOutcome(null);
    setDraft(next);
  };
  const focusField = (id: string) => document.getElementById(id)?.focus();

  const save = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setOutcome(null);
    client
      .slackSetReactions(draft)
      .then((next) => {
        saved.current = next.reactions;
        setView(next);
        setDraft(next.reactions);
        setOutcome({ ok: true, text: "Saved. The next review request uses them." });
      })
      .catch((e: unknown) => setOutcome({ ok: false, text: String(e) }))
      .finally(() => setBusy(false));
  };

  const panel = (key: string, fieldId: string, onPick: (name: string) => void) =>
    openKey === key ? (
      <EmojiPanel
        catalog={catalog}
        custom={custom}
        loadingCustom={loadingCustom}
        onRefresh={() => loadCustom(true)}
        onPick={(name) => {
          onPick(name);
          setOpenKey(null);
          focusField(fieldId);
        }}
        onClose={() => {
          setOpenKey(null);
          focusField(fieldId);
        }}
      />
    ) : null;

  const shown = previewNames(draft, previewState);

  return (
    <form className="cn-reactions" aria-label="Status reactions" onSubmit={save}>
      {view.lastError ? (
        <p className="au-callout au-callout--warn" role="status">
          {view.lastError}
        </p>
      ) : null}

      <div className="cn-preview" aria-label="Preview in Slack" role="group">
        <div className="cn-preview-head">
          <span className="cn-stat-label">Preview in Slack</span>
          <div className="cn-seg" role="radiogroup" aria-label="Review state to preview">
            {PREVIEW_STATES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={previewState === s.id}
                className="cn-seg-item"
                onClick={() => setPreviewState(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="cn-preview-msg">
          <span className="cn-preview-avatar" aria-hidden>
            T
          </span>
          <span className="cn-preview-body">
            <span className="cn-preview-who">
              Teammate <span className="cn-preview-time">10:42 AM</span>
            </span>
            <span className="cn-preview-text">@you could you take a look? github.com/acme/app/pull/412</span>
            <span className="cn-preview-chips">
              {shown.length === 0 ? (
                <span className="cn-preview-none">No reaction</span>
              ) : (
                shown.map((n) => (
                  <span key={n} className="cn-preview-chip">
                    <EmojiMark text={n} catalog={catalog} custom={custom} />
                    <span>1</span>
                  </span>
                ))
              )}
            </span>
          </span>
        </div>
      </div>

      <div className="cn-reaction-group">
        <div className="cn-reaction-group-head">
          <h3 className="cn-reaction-subhead">While the review runs</h3>
          <p className="cn-reactions-intro">
            Lotus adds these to the request message, as you. Pick an emoji, or type the name Slack shows. Your
            workspace&apos;s own emoji work too. Leave one empty to show nothing.
          </p>
        </div>
        <ul className="cn-reaction-rows">
          {REACTION_STATES.map(({ key, label, hint }) => {
            const id = `cn-reaction-${key}`;
            const unknown = lookupEmoji(draft[key], catalog, custom).known === false;
            const changed = emojiName(draft[key]) !== emojiName(view.reactions[key]);
            return (
              <li key={key} className="cn-reaction-row" data-open={openKey === key ? "" : undefined}>
                <EmojiTile
                  label={label}
                  open={openKey === key}
                  onClick={() => setOpenKey(openKey === key ? null : key)}
                >
                  {emojiName(draft[key]) ? (
                    <span className="cn-reaction-preview">
                      <EmojiMark text={draft[key]} catalog={catalog} custom={custom} />
                    </span>
                  ) : (
                    <Plus size={15} aria-hidden />
                  )}
                </EmojiTile>
                <label className="cn-reaction-label" htmlFor={id}>
                  <span className="cn-reaction-name">
                    {label}
                    {changed ? <span className="cn-edited" title="Not saved yet" aria-hidden /> : null}
                  </span>
                  <span className="cn-reaction-hint">{hint}</span>
                </label>
                <span className="cn-reaction-field">
                  <input
                    id={id}
                    className="au-input au-input--mono cn-name-input"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={key === "taken" ? "eyes" : "None"}
                    value={draft[key]}
                    aria-describedby={unknown ? `${id}-warn` : undefined}
                    onChange={(e) => edit({ ...draft, [key]: e.target.value })}
                  />
                  {draft[key] && key !== "taken" ? (
                    <button
                      type="button"
                      className="cn-clear"
                      aria-label={`Clear ${label}`}
                      title="Show nothing"
                      onClick={() => edit({ ...draft, [key]: "" })}
                    >
                      <X size={13} aria-hidden />
                    </button>
                  ) : null}
                </span>
                {unknown ? (
                  <span id={`${id}-warn`} className="cn-reaction-warn" role="status">
                    Not a standard emoji or one from your workspace. Slack will probably refuse it.
                  </span>
                ) : null}
                {panel(key, id, (name) => edit({ ...draft, [key]: name }))}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="cn-reaction-group">
        <div className="cn-reaction-group-head">
          <h3 className="cn-reaction-subhead" id="cn-reactions-sent">
            When you send the review
          </h3>
          <p className="cn-reactions-intro">
            Added when you press Send, by the verdict you sent. Up to {MAX_SENT} each. Nothing is added when you
            discard. {draft.taken ? <code>{draft.taken}</code> : "Taken in hand"} stays on the message, so it is not
            added twice.
          </p>
        </div>
        <ul className="cn-reaction-rows" aria-labelledby="cn-reactions-sent">
          {SENT_VERDICTS.map(({ key, label, hint, placeholder }) => {
            const id = `cn-reaction-sent-${key}`;
            const names = draft.sent[key];
            const clean = cleanNames(names);
            const unknown = clean.filter((n) => lookupEmoji(n, catalog, custom).known === false);
            const changed = clean.join(" ") !== cleanNames(view.reactions.sent[key]).join(" ");
            const setNames = (next: string[]) => edit({ ...draft, sent: { ...draft.sent, [key]: next } });
            return (
              <li key={key} className="cn-reaction-row cn-reaction-row--many" data-open={openKey === `sent-${key}` ? "" : undefined}>
                <label className="cn-reaction-label" htmlFor={id}>
                  <span className="cn-reaction-name">
                    {label}
                    {changed ? <span className="cn-edited" title="Not saved yet" aria-hidden /> : null}
                  </span>
                  <span className="cn-reaction-hint">{hint}</span>
                </label>
                <span className="cn-chips">
                  {clean.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className="cn-chip"
                      aria-label={`Remove ${n} from ${label}`}
                      title={`:${n}: · remove`}
                      onClick={() => setNames(clean.filter((m) => m !== n))}
                    >
                      <span className="cn-reaction-preview">
                        <EmojiMark text={n} catalog={catalog} custom={custom} />
                      </span>
                    </button>
                  ))}
                  {clean.length < MAX_SENT ? (
                    <EmojiTile
                      label={label}
                      open={openKey === `sent-${key}`}
                      onClick={() => setOpenKey(openKey === `sent-${key}` ? null : `sent-${key}`)}
                      small
                    >
                      <Plus size={14} aria-hidden />
                    </EmojiTile>
                  ) : null}
                </span>
                <span className="cn-reaction-field cn-reaction-field--wide">
                  <input
                    id={id}
                    className="au-input au-input--mono cn-name-input"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={`None, or ${placeholder}`}
                    value={namesText(names)}
                    aria-describedby={unknown.length ? `${id}-warn` : undefined}
                    onChange={(e) => setNames(parseNames(e.target.value))}
                  />
                </span>
                {unknown.length ? (
                  <span id={`${id}-warn`} className="cn-reaction-warn" role="status">
                    {unknown.map((n) => `:${n}:`).join(" ")} {unknown.length === 1 ? "is" : "are"} not a standard emoji or
                    one from your workspace. Slack will probably refuse {unknown.length === 1 ? "it" : "them"}.
                  </span>
                ) : null}
                {panel(`sent-${key}`, id, (name) => {
                  if (!clean.includes(name)) setNames([...clean, name]);
                })}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="cn-reactions-foot">
        <span className={outcome?.ok === false ? "au-error" : "cn-check-outcome"} role="status" aria-live="polite">
          {outcome?.text ?? ""}
        </span>
        <button
          type="button"
          className="rs-button rs-button--ghost"
          disabled={busy || isDefault}
          onClick={() => edit(view.defaults)}
        >
          <RotateCcw size={13} aria-hidden />
          Use the defaults
        </button>
      </div>

      {dirty ? (
        <div className="cn-savebar" role="region" aria-label="Unsaved reactions">
          <span className="cn-edited" aria-hidden />
          <span className="cn-savebar-text">
            {changes} unsaved change{changes === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="rs-button rs-button--ghost"
            disabled={busy}
            onClick={() => {
              setOpenKey(null);
              edit(view.reactions);
            }}
          >
            Discard
          </button>
          <button type="submit" className="rs-button rs-button--primary" disabled={busy}>
            {busy ? "Saving…" : "Save reactions"}
          </button>
        </div>
      ) : null}
    </form>
  );
}

/** The emoji itself, as the button that opens its picker. */
function EmojiTile({
  label,
  open,
  onClick,
  small,
  children,
}: {
  label: string;
  open: boolean;
  onClick: () => void;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="cn-tile"
      data-small={small ? "" : undefined}
      aria-label={`Choose emoji for ${label}`}
      aria-expanded={open}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
