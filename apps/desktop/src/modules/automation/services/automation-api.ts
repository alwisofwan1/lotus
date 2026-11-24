import { listen } from "@tauri-apps/api/event";

import { tauriInvoke } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { currentWindowLabel } from "@/lib/tauri-api";

/**
 * The automation commands, as the frontend calls them (`src-tauri/src/automation_host.rs`).
 *
 * Every shape here mirrors a view in `crates/lotus-automation/src/views.rs`, which lists its
 * fields on purpose: the UI never receives a token, a prompt, or anything a model struct grew.
 * Injectable, like `vault-api.ts`, so the surface renders in a test without Tauri.
 */

export type PrReviewConfig = {
  account: string;
  presetId: string;
  repos: string[];
  instructions: string;
  /** Folder the review agent works in; null = the automation's own. */
  workdir?: string | null;
  /** The Lotus workspace (project) reviews run in: its checkout of the repo. Null = the automation's own folder. */
  workspaceId?: string | null;
  /** Each review opens a pane to watch it; off (or absent) = headless. */
  openPane?: boolean;
  /** MCP tools (`mcp__server__tool`) or servers (`mcp__server`) the read-only review may use. */
  mcpTools?: string[];
  /** The user's skill the review follows (`review` or `plugin:review`); null = Lotus's method. */
  skill?: string | null;
  /** Most files a reviewed PR may change; null = 300. */
  maxFiles?: number | null;
  /** Minutes a headless review may take; null = 30. */
  timeoutMinutes?: number | null;
  /** A headless review may install dependencies and run the PR's tests (registries only). */
  runTests?: boolean;
  /** Auto mode: a finished review is posted with no Send; Lotus picks Approve, Request changes or Comment. */
  autoSend?: boolean;
};

export type Automation = {
  id: string;
  name: string;
  enabled: boolean;
  triggerKind: string;
  actionKind: string;
  /** `null` for action kinds this UI does not know yet. */
  config: PrReviewConfig | null;
  /** Where it listens in Slack; `null` when it runs only on "Review" (manual). */
  slack: SlackTrigger | null;
  /** Whether a PR review also watches GitHub's review requests (ADR-0041); `null` when not. */
  github: GitHubSource | null;
  /** When it runs, for `schedule` triggers. */
  schedule: { cron: string; timezone: string } | null;
  /** What it asks, for `agent_prompt` actions. */
  prompt: AgentPromptSummary | null;
  createdAtMs: number;
  /** Next scheduled run; null when off or not on a schedule. */
  nextRunMs: number | null;
};

export type AgentPromptSummary = {
  prompt: string;
  presetId: string;
  account: string | null;
  repos: string[];
  reviewerTeam: string | null;
  tools: string[];
  /** Folder the agent works in; null = the automation's own. */
  workdir?: string | null;
  /** The Lotus workspace (project) runs happen in (its folder); null = the automation's own. */
  workspaceId?: string | null;
  /** Each run opens a pane to watch it; off (or absent) = headless. */
  openPane?: boolean;
  includeReviewRequests: boolean;
  dmSelf: boolean;
  slackChannel: string | null;
  /** Rows go to this Google Sheet after each run; absent in older builds. */
  googleSheet?: GoogleSheetOutput | null;
  /** One report file per run in this Drive folder (`root` is My Drive). */
  googleDrive?: GoogleDriveOutput | null;
};

export type GoogleDriveFormat = "google_doc" | "markdown" | "csv";
export type GoogleSheetOutput = { spreadsheetId: string; tab: string; columns: string[]; url?: string };
export type GoogleDriveOutput = { folderId: string; format: GoogleDriveFormat };
/** A sheet or folder the user chose in Google's Picker. */
export type GooglePicked = { id: string; name: string; url: string; tabs?: string[]; columns?: string[] };
/** The connected Google account, for the form (`state`: unavailable | not_connected | connecting | connected). */
export type GoogleAccountState = { state: string; email: string | null };

/** Where one Google output of a result went (plans/google-connector G12). */
export type GoogleOutput = { status: "sent" | "not_sent"; url: string | null; detail: string | null; reconnect: boolean };
export type GoogleDelivery = { sheet: GoogleOutput | null; drive: GoogleOutput | null };
/** An `agent_prompt` result. `dm`: "sent", "off", or why the DM did not go. */
export type AgentResult = { text: string; dm: string; channel: string | null; google?: GoogleDelivery | null };

/** An Automation Ask: the agent stopped to ask the user one question (CONTEXT.md). */
export type AutomationAsk = {
  question: string;
  choices: string[];
  actionKind: string;
  answer?: AutomationAnswer | null;
  /** The chain's earlier questions and answers, oldest first; absent from older builds. */
  chain?: AutomationChainStep[];
  /** Set when a review asked: the PR its agent was reading. */
  review?: AskReview | null;
};

/** The pull request a review's Ask came from; its author may have steered the question. */
export type AskReview = { repo: string; number: number; url: string };

/** The user's Answer to an Ask, and the Follow-up Run it started. */
export type AutomationAnswer = {
  choice: string | null;
  note: string;
  answeredAtMs: number;
  followUpRunId: string;
  /** Set when that Follow-up Run failed: the Ask waits again, to be sent again. */
  failedRunId?: string | null;
};

/** An earlier question of an Ask's chain, and how the user answered it. */
export type AutomationChainStep = { question: string; choice: string | null; note: string };

export type SlackTrigger = { channels: string[]; team: string | null };

/**
 * Where a draft's request came from in Slack, so Send can reply in that thread. `requester` is
 * null when the user asked themselves: the trigger never records them as their own requester.
 */
export type DraftSlack = { channel: string; threadTs: string; requester: string | null };

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "skipped" | "interrupted" | "asked";

export type AutomationRun = {
  id: string;
  automationId: string;
  automationName: string;
  /** The unit of work, e.g. `owner/repo#42@<sha>`. */
  key: string;
  status: RunStatus;
  detail: string | null;
  createdAtMs: number;
  finishedAtMs: number | null;
  /** Folder of the agent session this run kept; absent/null when the row cannot open a pane. */
  sessionCwd?: string | null;
  /** Why a failed run failed (backend `failure.rs`); null unless it failed. */
  failure?: RunFailure | null;
  /** What to do about the failure, in one sentence; null when only `detail` says anything. */
  advice?: string | null;
};

export type RunFailure = "agent_missing" | "account_missing" | "preset_missing" | "login_expired" | "rate_limited" | "other";

/**
 * One message of a run's conversation (crate `lotus-automation` › `chat.rs`): what Lotus told the
 * agent, the user's own words, the agent's words, a tool it used, or the result it handed back.
 */
export type ChatEntry = {
  kind: "instructions" | "you" | "agent" | "step" | "result";
  text?: string;
  /** A step's tool. */
  tool?: string;
  /** A result, as the agent handed it back (`text`, a review's `summary` and `comments`, `ask`…). */
  result?: Record<string, unknown>;
  atMs: number;
};

/** A run's conversation, as the thread shows it. */
export type RunConversation = {
  /** The newest run in the conversation: the one a message follows up. */
  runId: string;
  /** A run in it is still working. */
  running: boolean;
  canReply: boolean;
  /** Why the user cannot write to it. */
  whyNot: string | null;
  entries: ChatEntry[];
};

/** Rust asks for a run's pane: open `command` in workspace `workspaceId`, then say so with `token`. */
export type PaneRequest = {
  token: string;
  workspaceId: string;
  command: string;
  /** The repo the run is about (`owner/name`): its pane opens in a checkout of it when one is open. */
  repo?: string | null;
};

/** Where a repo's checkout is: the workspace to open the pane in, and the folder. */
/** `namesake`: the folder's own repo, when it is only a same-named repo under another owner. */
export type FoundCheckout = { workspaceId: string; cwd: string; namesake?: string };

/** One thing a headless run's agent did, in Lotus's words ("Read src/app.ts"). */
export type RunStep = { atMs: number; text: string };
export type RunStepEvent = RunStep & { runId: string };

/** A Lotus workspace, as the automation forms offer it. */
export type AutomationProject = { id: string; name: string };

/**
 * How much a finding matters. Written at the start of the comment on Send (`**[blocker]**`). A
 * suggestion is optional for the author: it never raises the verdict, and a review whose findings
 * are all suggestions can still be approved (ADR-0042).
 */
export type Severity = "blocker" | "should-fix" | "question" | "suggestion";

export type ReviewComment = { path: string; line: number; severity?: Severity; body: string };

export type PrReviewDraft = {
  repo: string;
  number: number;
  url: string;
  headSha: string;
  /** Missing on legacy drafts. Analysis coverage does not imply tests passed. */
  coverage?: "complete" | "partial" | "blocked";
  summary: string;
  comments: ReviewComment[];
  droppedComments: number;
  /** The severities of the findings moved off the diff; absent from older builds. */
  offDiffSeverities?: Severity[];
  /** What the Slack thread is told after Send; the verdict is already no kinder than the findings. */
  reply: SlackBrief;
  /** A re-review's earlier findings and how each stands; empty (or absent) for a first review. */
  previous?: EarlierFinding[];
  /** The head the earlier review was of, for a re-review. */
  sinceSha?: string | null;
};

export type EarlierFinding = {
  findingId?: string;
  replies?: { author: string; body: string }[];
  path: string;
  line: number;
  severity?: Severity | null;
  body: string;
  status: "fixed" | "answered" | "not-fixed" | string;
  note: string | null;
  /** It has a GitHub thread a ✅ can be replied on. */
  hasThread: boolean;
};

export type Verdict = "looks-good" | "questions" | "changes-needed";

/** A review's Slack reply: Lotus adds the mention, the link and the counts. At most 2 points of 120 characters. */
/** `lead`: the agent's opening line for this round; the host keeps it when the reviewer edits the points. */
export type SlackBrief = { verdict: Verdict; points: string[]; lead?: string };

export type DraftStatus = "pending" | "sending" | "sent" | "discarded";

export type ReviewRoomData = {
  history: AutomationDraft[];
  feedback: { id: string; author: string; text: string; atMs: number; channel?: string; threadTs?: string }[];
};

export type AutomationDraft = {
  id: string;
  runId: string;
  automationId: string;
  kind: string;
  subject: string;
  status: DraftStatus;
  content: PrReviewDraft | null;
  slack: DraftSlack | null;
  result: AgentResult | null;
  /** Set for an Automation Ask (kind `ask`); absent from older builds. */
  ask?: AutomationAsk | null;
  sentUrl: string | null;
  /** When it was sent; null before, and for drafts sent before this was kept. */
  sentAtMs?: number | null;
  /**
   * After Send: "replied", "waiting: 1 of 2 sent" (held until the thread's other reviews are
   * sent), or why not ("not replied: …"); null when no reply was asked for.
   */
  slackReply?: string | null;
  /** Pending PR reviews in this draft's Slack thread, itself included: >1 offers Send all. */
  slackGroup?: number;
  createdAtMs: number;
};

/** `reply`: the Slack points as edited; left out, the draft keeps its own. */
export type EditedReview = { summary: string; comments: ReviewComment[]; reply?: SlackBrief };

export type RunNowResult = { status: "started" | "duplicate"; runId: string };

/** `stale`: nothing was sent — the PR moved past the reviewed commit. */
export type SendResult =
  /** `slackReply`: "replied", or why not; absent when no reply was asked for. */
  | { status: "sent"; url: string; slackReply?: string | null }
  | { status: "stale"; reviewed: string; current: string };

/** What a draft's Slack thread will be told if it is sent now; `text` null while `waiting` reviews hold it back. */
export type SlackPreview = { text: string | null; waiting: number };

export type AgentPreset = {
  id: string;
  name: string;
  agent: string;
  supported: boolean;
  /** Why it cannot run, in plain words. */
  problem?: string | null;
  /** What the preset itself sets; the Agent row's defaults. */
  model?: string | null;
  effort?: string | null;
  account?: string | null;
};

/** The Slack connection. `state`: not_set_up | standby | connecting | connected | retrying | stopped. */
export type SlackStatus = {
  state: string;
  detail: string | null;
  userId: string | null;
  team: string | null;
  checkedAtMs?: number | null;
  checkEveryMs?: number | null;
};

export type SlackChannel = { id: string; name: string; isPrivate: boolean };

export type SlackUserGroup = { id: string; handle: string; name: string };

/** A request source's settings (`trigger.config.sources.github`). `team`: `org/slug` whose requests count too. */
export type GitHubSource = { team: string | null };

/** A github.com account `gh` is logged into. `active` is the one gh uses by default. */
export type GhAccount = { login: string; active: boolean };

export type PrReviewForm = {
  name: string;
  account: string;
  presetId: string;
  repos: string[];
  instructions: string;
  /** Folder the review agent works in (e.g. a clone); `~` is home. Null: its own. */
  workdir: string | null;
  /** The Lotus workspace (project) reviews run in: its checkout of the repo. */
  workspaceId: string | null;
  /** Open a pane to watch each review. False: headless. */
  openPane: boolean;
  /** MCP tools the read-only review may use; everything else stays off (ADR-0039). */
  mcpTools: string[];
  /** The user's skill the review follows; null = Lotus's method. Unknown at run time: the run fails. */
  skill?: string | null;
  /** Most files a reviewed PR may change (1–3000); null = 300. */
  maxFiles?: number | null;
  /** Minutes a headless review may take (1–120); null = 30. */
  timeoutMinutes?: number | null;
  /** Let a headless review install dependencies and run the PR's tests. The PR's code runs on this Mac. */
  runTests?: boolean;
  /** Post each finished review and its Slack reply with no Send, as `account` (ADR-0042). */
  autoSend?: boolean;
};

export type AgentPromptForm = {
  name: string;
  prompt: string;
  presetId: string;
  days: string[];
  time: string;
  timezone: string;
  cron: string | null;
  tools: string[];
  /** Folder the agent works in; `~` is home. Null: the automation's own. */
  workdir: string | null;
  /** The Lotus workspace (project) runs happen in (its folder). */
  workspaceId: string | null;
  /** Open a pane to watch each run. False: headless. */
  openPane: boolean;
  account: string | null;
  repos: string[];
  reviewerTeam: string | null;
  includeReviewRequests: boolean;
  dmSelf: boolean;
  slackChannel: string | null;
  /** `spreadsheetId: "new"` makes a sheet named after the automation on save. */
  googleSheet: GoogleSheetOutput | null;
  googleDrive: GoogleDriveOutput | null;
};

export interface AutomationClient {
  list(): Promise<Automation[]>;
  presets(): Promise<AgentPreset[]>;
  ghAccounts(): Promise<GhAccount[]>;
  createPrReview(form: PrReviewForm): Promise<Automation>;
  runNow(automationId: string, url: string): Promise<RunNowResult>;
  /** A new human-requested round, even at the same SHA. Always produces a draft. */
  reviewAgain?(automationId: string, url: string, feedback: string): Promise<RunNowResult>;
  reviewRoom?(automationId: string, url: string): Promise<ReviewRoomData>;
  runs(limit?: number): Promise<AutomationRun[]>;
  /** A run's conversation, read from its agent's transcript. Rejects when it kept none. */
  runConversation(runId: string): Promise<RunConversation>;
  /** The user's message to a run's agent; `key` makes a second press start nothing. Resolves to the answering run's id. */
  sendMessage(runId: string, text: string, key: string): Promise<string>;
  /** The run's pane opened in `workspaceId`, at folder `cwd`. */
  paneOpened(token: string, cwd: string, workspaceId: string): Promise<void>;
  /**
   * The checkout of `repo` among `workspaces` (a root, or a folder directly inside one; `preferred` first).
   * `namesake`: also the one checkout of a same-named repo under another owner — delegation only, never
   * for anything that pushes.
   */
  findCheckout(
    repo: string,
    workspaces: { id: string; cwd: string }[],
    preferred: string | null,
    options?: { namesake?: boolean },
  ): Promise<FoundCheckout | null>;
  /** The run's pane could not open; the run fails with `reason`. */
  paneFailed(token: string, reason: string): Promise<void>;
  /** The window's local workspaces, so a run in a project works in its folder without a pane. */
  setWorkspaces(workspaces: { id: string; cwd: string; name?: string }[]): Promise<void>;
  /** What a recent run's agent has done so far. */
  runSteps(runId: string): Promise<RunStep[]>;
  /** Each step any run takes from now on; returns the unsubscribe. */
  onRunStep(listener: (step: RunStepEvent) => void): () => void;
  drafts(): Promise<AutomationDraft[]>;
  /** PR reviews already sent to GitHub, most recently sent first. */
  sentReviews(limit?: number): Promise<AutomationDraft[]>;
  updateDraft(draftId: string, edited: EditedReview): Promise<boolean>;
  sendDraft(
    draftId: string,
    edited: EditedReview | null,
    sendEvenIfStale: boolean,
    replyInThread: boolean,
    /** A re-review: reply ✅ on the GitHub threads of earlier findings it found resolved. */
    closeThreads?: boolean,
    /** The reviewer's own text for the Slack thread's message, used if this Send posts it. */
    slackText?: string,
    /** false: Slack only, nothing is posted on GitHub. Default true. */
    postGithub?: boolean,
  ): Promise<SendResult>;
  /**
   * Like `sendDraft`, but posted as an APPROVE review, and the thread is told LGTM. The engine
   * refuses it unless every finding is a suggestion (ADR-0042). Always posts on GitHub.
   */
  approveDraft(
    draftId: string,
    edited: EditedReview | null,
    sendEvenIfStale: boolean,
    replyInThread: boolean,
    /** A re-review: reply ✅ on the GitHub threads of earlier findings it found resolved. */
    closeThreads?: boolean,
    slackText?: string,
  ): Promise<SendResult>;
  /**
   * Sends every pending review in `draftId`'s Slack thread, then posts one reply. Stops at the
   * first one not sent; resolves to `[draftId, result]` for each tried. Never approves; `closeThreads`
   * (default true, as on a card) replies ✅ on each re-review's resolved threads.
   */
  sendAll(draftId: string, replyInThread: boolean, closeThreads?: boolean, slackText?: string): Promise<[string, SendResult][]>;
  /** The Slack thread's message if `draftId` is sent now (`all`: with Send all), for the editable preview. */
  slackPreview(draftId: string, all: boolean): Promise<SlackPreview>;
  /** Posts the Slack reply a sent review holds now, without waiting for the rest of its thread. */
  replyNow(draftId: string): Promise<string>;
  /** `reason`: the reviewer's optional why, kept on the draft for the retro; never sent anywhere. */
  discardDraft(draftId: string, reason?: string): Promise<void>;
  /** Answers an Ask (`choice` null when it offered none) and starts its Follow-up Run; resolves to that run's id. */
  answerAsk(askId: string, choice: string | null, note: string): Promise<string>;
  /** Answered Asks, most recently answered first. */
  answeredAsks(limit?: number): Promise<AutomationDraft[]>;
  slackStatus(): Promise<SlackStatus>;
  slackConnect(appToken: string, userToken: string): Promise<SlackStatus>;
  slackDisconnect(): Promise<void>;
  slackChannels(): Promise<SlackChannel[]>;
  /** Slack user id → display name, for the ids Slack knows; an unknown id is left out. */
  slackUserNames(ids: string[]): Promise<Record<string, string>>;
  slackUsergroups(): Promise<SlackUserGroup[]>;
  slackManifest(): Promise<string>;
  /** Empty `channels` turns the Slack trigger off (Review-only). */
  setSlackTrigger(automationId: string, channels: string[], team: string | null): Promise<Automation>;
  /** Turns request source `source` (`github`) on with `settings`, or off with `null`. */
  setRequestSource(automationId: string, source: "github", settings: { team?: string } | null): Promise<Automation>;
  createAgentPrompt(form: AgentPromptForm): Promise<Automation>;
  /** Scheduled-prompt results, newest first. */
  results(limit?: number): Promise<AutomationDraft[]>;
  /** The exact Slack text `text` would post as (live mentions, escapes, mrkdwn). Absent: no preview. */
  previewResult?(draftId: string, text: string): Promise<string>;
  /** Posts a waiting result to its Slack channel, as the user. */
  sendResult(draftId: string, text: string | null): Promise<void>;
  /** Sends a result's failed Google writes again (never the agent). */
  resendGoogle(draftId: string): Promise<void>;
  googleStatus(): Promise<GoogleAccountState>;
  /** Google's Picker in the browser; resolves with what the user chose. */
  googlePick(kind: "sheet" | "folder"): Promise<GooglePicked>;
  /** Stops a Picker (or sign-in) waiting in the browser. */
  googleCancelPick(): Promise<void>;
  /** The user's switch. An agent's automation starts off and runs only after this turns it on. */
  setEnabled(automationId: string, enabled: boolean): Promise<Automation>;
  /** `false` when it was already gone. */
  deleteAutomation(automationId: string): Promise<boolean>;
  /** One run of a scheduled prompt, now. */
  runScheduledNow(automationId: string): Promise<RunNowResult>;
  /** The prompt (or a review's instructions), edited in place. */
  updatePrompt(automationId: string, text: string): Promise<Automation>;
  /** An agent ref (`agent-ref.ts`): the preset plus model, effort and account on top. */
  updateAgent(automationId: string, agent: string): Promise<Automation>;
  /** The whole definition from its form; whether it is on is kept. */
  edit(automationId: string, kind: "agent_prompt", form: AgentPromptForm): Promise<Automation>;
  edit(automationId: string, kind: "pr_review", form: PrReviewForm): Promise<Automation>;
}

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function createTauriAutomationClient(invokeFn: InvokeFn = tauriInvoke as InvokeFn): AutomationClient {
  return {
    list: () => invokeFn<Automation[]>("automation_list"),
    presets: () => invokeFn<AgentPreset[]>("automation_list_presets"),
    ghAccounts: () => invokeFn<GhAccount[]>("automation_list_gh_accounts"),
    createPrReview: (form) => invokeFn<Automation>("automation_create_pr_review", { form }),
    runNow: (automationId, url) => invokeFn<RunNowResult>("automation_run_now", { automationId, url }),
    reviewAgain: (automationId, url, feedback) => invokeFn<RunNowResult>("automation_run_now", { automationId, url, rereview: true, feedback }),
    reviewRoom: (automationId, url) => invokeFn<ReviewRoomData>("automation_review_room", { automationId, url }),
    runs: (limit = 200) => invokeFn<AutomationRun[]>("automation_list_runs", { limit }),
    runConversation: (runId) => invokeFn<RunConversation>("automation_run_conversation", { runId }),
    sendMessage: (runId, text, key) => invokeFn<string>("automation_send_message", { runId, text, key }),
    paneOpened: (token, cwd, workspaceId) => invokeFn<void>("automation_pane_opened", { token, cwd, workspaceId }),
    findCheckout: (repo, workspaces, preferred, options) =>
      invokeFn<FoundCheckout | null>("automation_find_checkout", {
        repo,
        workspaces,
        preferred,
        ...(options?.namesake ? { namesake: true } : {}),
      }),
    paneFailed: (token, reason) => invokeFn<void>("automation_pane_failed", { token, reason }),
    setWorkspaces: (workspaces) => invokeFn<void>("automation_set_workspaces", { workspaces }),
    runSteps: (runId) => invokeFn<RunStep[]>("automation_run_steps", { runId }),
    onRunStep: (listener) => {
      // Outside Tauri there is no event bus: stay quiet, never reject.
      const pending = listen<RunStepEvent>(AUTOMATION_STEP_EVENT, (event) => listener(event.payload)).catch(() => null);
      return () => {
        void pending.then((off) => safeTauriUnlisten(off));
      };
    },
    drafts: () => invokeFn<AutomationDraft[]>("automation_list_drafts"),
    sentReviews: (limit = 20) => invokeFn<AutomationDraft[]>("automation_list_sent_reviews", { limit }),
    updateDraft: (draftId, edited) => invokeFn<boolean>("automation_update_draft", { draftId, edited }),
    sendDraft: (draftId, edited, sendEvenIfStale, replyInThread, closeThreads = false, slackText, postGithub = true) =>
      invokeFn<SendResult>("automation_send_draft", { draftId, edited, sendEvenIfStale, replyInThread, closeThreads, slackText: slackText ?? null, postGithub }),
    approveDraft: (draftId, edited, sendEvenIfStale, replyInThread, closeThreads = false, slackText) =>
      invokeFn<SendResult>("automation_send_draft", { draftId, edited, sendEvenIfStale, replyInThread, approve: true, closeThreads, slackText: slackText ?? null }),
    sendAll: (draftId, replyInThread, closeThreads = true, slackText) =>
      invokeFn<[string, SendResult][]>("automation_send_all", { draftId, replyInThread, closeThreads, slackText: slackText ?? null }),
    slackPreview: (draftId, all) => invokeFn<SlackPreview>("automation_slack_preview", { draftId, all }),
    replyNow: (draftId) => invokeFn<string>("automation_reply_now", { draftId }),
    discardDraft: (draftId, reason) => invokeFn<void>("automation_discard_draft", { draftId, reason: reason ?? null }),
    answerAsk: (askId, choice, note) => invokeFn<string>("automation_answer_ask", { askId, choice, note }),
    answeredAsks: (limit = 20) => invokeFn<AutomationDraft[]>("automation_list_answered_asks", { limit }),
    slackStatus: () => invokeFn<SlackStatus>("automation_slack_status"),
    slackConnect: (appToken, userToken) => invokeFn<SlackStatus>("automation_slack_connect", { appToken, userToken }),
    slackDisconnect: () => invokeFn<void>("automation_slack_disconnect"),
    slackChannels: () => invokeFn<SlackChannel[]>("automation_slack_channels"),
    slackUserNames: (ids) => invokeFn<Record<string, string>>("automation_slack_user_names", { ids }),
    slackUsergroups: () => invokeFn<SlackUserGroup[]>("automation_slack_usergroups"),
    slackManifest: () => invokeFn<string>("automation_slack_manifest"),
    setSlackTrigger: (automationId, channels, team) =>
      invokeFn<Automation>("automation_set_slack_trigger", { automationId, channels, team }),
    setRequestSource: (automationId, source, settings) =>
      invokeFn<Automation>("automation_set_request_source", { automationId, source, settings }),
    createAgentPrompt: (form) => invokeFn<Automation>("automation_create_agent_prompt", { form }),
    results: (limit = 30) => invokeFn<AutomationDraft[]>("automation_list_results", { limit }),
    previewResult: (draftId, text) => invokeFn<string>("automation_preview_result", { draftId, text }),
    sendResult: (draftId, text) => invokeFn<void>("automation_send_result", { draftId, text }),
    googleStatus: () => invokeFn<GoogleAccountState>("automation_google_status"),
    googlePick: (kind) => invokeFn<GooglePicked>("automation_google_pick", { kind }),
    googleCancelPick: () => invokeFn<void>("automation_google_cancel_connect"),
    resendGoogle: async (draftId) => {
      await invokeFn<unknown>("automation_google_resend", { draftId });
    },
    setEnabled: (automationId, enabled) => invokeFn<Automation>("automation_set_enabled", { automationId, enabled }),
    deleteAutomation: (automationId) => invokeFn<boolean>("automation_delete", { automationId }),
    runScheduledNow: (automationId) => invokeFn<RunNowResult>("automation_run_scheduled_now", { automationId }),
    updatePrompt: (automationId, text) => invokeFn<Automation>("automation_update_prompt", { automationId, text }),
    updateAgent: (automationId, agent) => invokeFn<Automation>("automation_update_agent", { automationId, agent }),
    edit: (automationId: string, kind: string, form: AgentPromptForm | PrReviewForm) =>
      invokeFn<Automation>("automation_edit", { automationId, kind, form }),
  };
}

/** Fired by Rust for each step a headless run takes. */
export const AUTOMATION_STEP_EVENT = "automation://step";

/** Fired by Rust whenever automations, runs or drafts change. Carries nothing: re-read. */
export const AUTOMATION_CHANGED_EVENT = "automation://changed";

export type Subscribe = (onChange: () => void) => () => void;

export const subscribeToAutomationChanges: Subscribe = (onChange) => {
  // Outside Tauri (a browser tab, a test) there is no event bus: stay quiet, never reject.
  const pending = listen(AUTOMATION_CHANGED_EVENT, () => onChange()).catch(() => null);
  return () => {
    void pending.then((off) => safeTauriUnlisten(off));
  };
};

/**
 * Fired by Rust when a window gained focus soon after an Ask's notification (PLAN §8 Q10):
 * `{ askId, window }`. Only the named window opens it.
 */
export const AUTOMATION_OPEN_ASK_EVENT = "automation://open-ask";

export function subscribeToOpenAsk(onOpen: (askId: string) => void): () => void {
  // Outside Tauri there is no event bus: stay quiet, never reject. The label is read only when an
  // event arrives, so nothing here touches the window before one does.
  const pending = listen<{ askId: string; window: string }>(AUTOMATION_OPEN_ASK_EVENT, (event) => {
    void Promise.resolve()
      .then(() => currentWindowLabel())
      .then((mine) => {
        if (event.payload.window === mine) onOpen(event.payload.askId);
      })
      .catch(() => undefined);
  }).catch(() => null);
  return () => {
    void pending.then((off) => safeTauriUnlisten(off));
  };
}

/** Fired by Rust when a run of an automation with a project wants its pane. */
export const AUTOMATION_OPEN_PANE_EVENT = "automation://open-pane";

export function subscribeToPaneRequests(onRequest: (request: PaneRequest) => void): () => void {
  // Outside Tauri there is no event bus: stay quiet, never reject.
  const pending = listen<PaneRequest>(AUTOMATION_OPEN_PANE_EVENT, (event) => onRequest(event.payload)).catch(() => null);
  return () => {
    void pending.then((off) => safeTauriUnlisten(off));
  };
}
