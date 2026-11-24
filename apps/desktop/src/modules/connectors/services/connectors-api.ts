import { listen } from "@tauri-apps/api/event";

import { tauriInvoke } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";

/**
 * Connectors: the accounts automations act through. The commands are the automation engine's
 * (`automation_slack_*`, `automation_list_gh_accounts`) because the engine owns the sessions;
 * this module owns how they are set up and shown. Tokens go to the OS keychain through Rust and
 * never come back here.
 */

/**
 * `state`: not_set_up | standby | connecting | connected | retrying | stopped. `standby` is a dev build that
 * posts but leaves events to the installed Lotus. `connected` with a `detail` is a warning: messages are
 * reaching Lotus only through the periodic catch-up.
 */
export type SlackStatus = {
  state: string;
  detail: string | null;
  userId: string | null;
  team: string | null;
  /** When Lotus last read Slack for messages the live connection missed. */
  checkedAtMs?: number | null;
  /** How often it does; null when this build does not listen. */
  checkEveryMs?: number | null;
  /** Slack's count of open sockets for this Slack app at the last connect, Lotus included. */
  connections?: number | null;
  /** A bot token is saved: Factory alerts also arrive as a DM from the Lotus bot (CoS 11). */
  bot?: boolean;
};
/**
 * The Slack emoji (names, no colons) a review request shows for each state of its review. Empty
 * = no reaction for that state. `taken` is never empty: it is also the reaction that asks.
 */
export type StatusReactions = {
  taken: string;
  queued: string;
  running: string;
  done: string;
  failed: string;
  asked: string;
  skipped: string;
  /** Added to the request message when the review is sent, by the verdict sent. */
  sent: SentReactions;
};
/**
 * The emoji (names, no colons) Lotus adds to the request message when you send a review, by its
 * verdict. Empty = nothing. Never on Discard. The `taken` emoji is skipped: it is there already.
 */
export type SentReactions = {
  looksGood: string[];
  questions: string[];
  changesNeeded: string[];
};
/** The reactions in use, the defaults, and the last reaction Slack refused. */
export type SlackReactionsView = {
  reactions: StatusReactions;
  defaults: StatusReactions;
  lastError: string | null;
};
/**
 * One custom emoji of the Slack workspace. An alias of another custom emoji carries its `url`; an alias
 * of a standard emoji has no `url` and names that emoji in `aliasOf`.
 */
export type SlackEmoji = { name: string; url: string | null; aliasOf: string | null };
/**
 * The workspace's custom emoji. `state` is `ok` or `missing_scope`: the Slack app was installed before
 * Lotus asked for `emoji:read`, and reinstalling it fixes that.
 */
export type SlackEmojiView = { state: "ok" | "missing_scope"; emoji: SlackEmoji[] };
export type GhAccount = { login: string; active: boolean };
/** `state`: unavailable | not_connected | connecting | connected. `detail` says why it is unavailable. */
export type GoogleStatus = {
  state: string;
  email: string | null;
  scopes: string[];
  connectedAtMs: number | null;
  detail: string | null;
};
/**
 * `state`: not_connected | connected. `kind`: personal (a personal access token — a person, with
 * an email) or integration (a bot, which names its workspace). Never carries the token.
 */
export type NotionStatus = {
  state: string;
  kind: "personal" | "integration" | null;
  name: string | null;
  email: string | null;
  workspace: string | null;
  connectedAtMs: number | null;
};
/** Just enough of an automation to say which ones lean on a connector. */
export type AutomationUse = {
  id: string;
  name: string;
  enabled: boolean;
  triggerKind: string;
  actionKind: string;
  config: { account: string } | null;
  prompt: { dmSelf: boolean; slackChannel: string | null; account: string | null } | null;
};

export interface ConnectorsClient {
  slackStatus(): Promise<SlackStatus>;
  slackConnect(appToken: string, userToken: string): Promise<SlackStatus>;
  slackDisconnect(): Promise<void>;
  /** Reads Slack for missed messages now; resolves with the status that check left. */
  slackCheckNow(): Promise<SlackStatus>;
  slackManifest(): Promise<string>;
  /** Checks the `xoxb-` token with Slack and saves it beside the other two. */
  slackSetBotToken(botToken: string): Promise<SlackStatus>;
  /** One DM from the bot now, to see that it pings the phone. */
  slackTestBot(): Promise<void>;
  slackReactions(): Promise<SlackReactionsView>;
  /** Saves the reactions; rejects with why a name cannot be used. The next request uses them. */
  slackSetReactions(reactions: StatusReactions): Promise<SlackReactionsView>;
  /** The workspace's custom emoji for the reaction picker; Rust keeps them 10 minutes unless `refresh`. */
  slackEmoji(refresh?: boolean): Promise<SlackEmojiView>;
  ghAccounts(): Promise<GhAccount[]>;
  googleStatus(): Promise<GoogleStatus>;
  /** Opens Google's sign-in in the browser; resolves when it finishes, is cancelled, or times out. */
  googleConnect(): Promise<GoogleStatus>;
  googleCancelConnect(): Promise<void>;
  googleDisconnect(): Promise<void>;
  notionStatus(): Promise<NotionStatus>;
  /** Checks the pasted token with Notion; rejects with Notion's reason when it is refused. */
  notionConnect(token: string): Promise<NotionStatus>;
  notionDisconnect(): Promise<void>;
  automations(): Promise<AutomationUse[]>;
}

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function createTauriConnectorsClient(invokeFn: InvokeFn = tauriInvoke as InvokeFn): ConnectorsClient {
  return {
    slackStatus: () => invokeFn<SlackStatus>("automation_slack_status"),
    slackConnect: (appToken, userToken) => invokeFn<SlackStatus>("automation_slack_connect", { appToken, userToken }),
    slackDisconnect: () => invokeFn<void>("automation_slack_disconnect"),
    slackCheckNow: () => invokeFn<SlackStatus>("automation_slack_check_now"),
    slackManifest: () => invokeFn<string>("automation_slack_manifest"),
    slackSetBotToken: (botToken) => invokeFn<SlackStatus>("automation_slack_set_bot_token", { botToken }),
    slackTestBot: () => invokeFn<void>("automation_slack_test_bot"),
    slackReactions: () => invokeFn<SlackReactionsView>("automation_slack_reactions"),
    slackSetReactions: (reactions) => invokeFn<SlackReactionsView>("automation_slack_set_reactions", { reactions }),
    slackEmoji: (refresh = false) => invokeFn<SlackEmojiView>("automation_slack_emoji", { refresh }),
    ghAccounts: () => invokeFn<GhAccount[]>("automation_list_gh_accounts"),
    googleStatus: () => invokeFn<GoogleStatus>("automation_google_status"),
    googleConnect: () => invokeFn<GoogleStatus>("automation_google_connect"),
    googleCancelConnect: () => invokeFn<void>("automation_google_cancel_connect"),
    googleDisconnect: () => invokeFn<void>("automation_google_disconnect"),
    notionStatus: () => invokeFn<NotionStatus>("notion_status"),
    notionConnect: (token) => invokeFn<NotionStatus>("notion_connect", { token }),
    notionDisconnect: () => invokeFn<void>("notion_disconnect"),
    automations: () => invokeFn<AutomationUse[]>("automation_list"),
  };
}

/** Rust fires this whenever a connection or an automation changes. Carries nothing: re-read. */
const CHANGED_EVENT = "automation://changed";

export type Subscribe = (onChange: () => void) => () => void;

export const subscribeToConnectorChanges: Subscribe = (onChange) => {
  const pending = listen(CHANGED_EVENT, () => onChange()).catch(() => null);
  return () => {
    void pending.then((off) => safeTauriUnlisten(off));
  };
};

// ── What each connector is and how it reads ─────────────────────────────────

export type ConnectorId = "slack" | "github" | "google" | "notion";
export type ConnectorHealth = "connected" | "attention" | "busy" | "off";

export type ConnectorSummary = { id: ConnectorId; name: string; health: ConnectorHealth; status: string; usedBy: AutomationUse[] };

export function slackUsers(all: AutomationUse[]): AutomationUse[] {
  return all.filter((a) => a.triggerKind === "slack" || Boolean(a.prompt?.dmSelf) || Boolean(a.prompt?.slackChannel));
}

export function githubUsers(all: AutomationUse[]): AutomationUse[] {
  return all.filter((a) => a.actionKind === "pr_review" || Boolean(a.prompt?.account));
}

export function describeSlack(status: SlackStatus | null): { health: ConnectorHealth; status: string } {
  const where = status?.team ?? "Slack";
  switch (status?.state) {
    case "connected":
      return status.detail
        ? { health: "attention", status: `Connected to ${where} · missing live events` }
        : { health: "connected", status: `Connected to ${where}` };
    case "standby":
      return { health: "off", status: `${where} · not listening in dev` };
    case "connecting":
      return { health: "busy", status: `Connecting to ${where}…` };
    case "retrying":
      return { health: "busy", status: `Reconnecting to ${where}${status.detail ? `: ${status.detail}` : "…"}` };
    case "stopped":
      return { health: "attention", status: `Stopped${status.detail ? `: ${status.detail}` : ""}` };
    default:
      return { health: "off", status: "Not connected" };
  }
}

/** The missed-message check, in one line: how often, and when it last ran. */
export function describeSlackCheck(status: SlackStatus | null, nowMs: number): string | null {
  if (!status?.checkEveryMs) return null;
  const every = `Every ${Math.round(status.checkEveryMs / 60_000)} min`;
  if (!status.checkedAtMs) return `${every} · runs once connected`;
  const minutes = Math.floor(Math.max(0, nowMs - status.checkedAtMs) / 60_000);
  const when = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
  return `${every} · last checked ${when}`;
}

export function describeGitHub(accounts: GhAccount[] | null): { health: ConnectorHealth; status: string } {
  if (accounts === null) return { health: "busy", status: "Checking gh…" };
  if (accounts.length === 0) return { health: "off", status: "No gh login found" };
  const active = accounts.find((a) => a.active) ?? accounts[0];
  const more = accounts.length - 1;
  return { health: "connected", status: `${active.login}${more > 0 ? ` and ${more} more` : ""} via gh` };
}

/** Google's cancel is the user's own choice, not an error to show. */
export const GOOGLE_CANCELLED = "Google sign-in was cancelled";

export function describeGoogle(status: GoogleStatus | null): { health: ConnectorHealth; status: string } {
  switch (status?.state) {
    case "connected":
      return { health: "connected", status: status.email ? `Connected as ${status.email}` : "Connected" };
    case "connecting":
      return { health: "busy", status: "Waiting for your browser…" };
    case "unavailable":
      return { health: "off", status: "Not available in this build" };
    default:
      return { health: "off", status: "Not connected" };
  }
}

export function describeNotion(status: NotionStatus | null): { health: ConnectorHealth; status: string } {
  if (status?.state !== "connected") return { health: "off", status: "Not connected" };
  const who = status.kind === "integration" ? status.workspace ?? status.name : status.email ?? status.name;
  return { health: "connected", status: who ? `Connected as ${who}` : "Connected" };
}

export function summarize(
  status: SlackStatus | null,
  accounts: GhAccount[] | null,
  automations: AutomationUse[],
  google: GoogleStatus | null = null,
  notion: NotionStatus | null = null,
): ConnectorSummary[] {
  return [
    { id: "slack", name: "Slack", ...describeSlack(status), usedBy: slackUsers(automations) },
    { id: "github", name: "GitHub", ...describeGitHub(accounts), usedBy: githubUsers(automations) },
    // No automation writes to Google until the Sheet and Drive outputs exist (plans/google-connector slice 04).
    { id: "google", name: "Google", ...describeGoogle(google), usedBy: [] },
    // Notion is used by ticket sources in Tasks, not by automations (plans/ticket-sources).
    { id: "notion", name: "Notion", ...describeNotion(notion), usedBy: [] },
  ];
}
