import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { tauriInvoke } from "@/lib/tauri/runtime";
import type { RunGraph } from "@/modules/codecanvas/services/canvas-run-scheduler";
import type { GraphRunStatus } from "@/modules/codecanvas/services/graph-run-record";

/**
 * The Rust Graph Run engine (`src-tauri/crates/lotus-graph-run`, ADR-0049 §6).
 *
 * Contract: the run record (read with `codecanvasGetGraphRun` / `codecanvasListGraphRuns`) is the
 * truth. The engine emits {@link GRAPH_RUN_CHANGED_EVENT} after every write; listen to know WHEN to
 * read the record again, never as the state itself. Runs go on with no window open.
 */
export const GRAPH_RUN_CHANGED_EVENT = "graph-run://changed";

export interface GraphRunChanged {
  id: string;
  projectId: string;
  status: GraphRunStatus;
}

export interface GraphRunStartInput {
  projectId: string;
  graph: RunGraph;
  /** `run-node:<id>` for a Run Node. */
  workflowId?: string;
  run?: { title: string; brief: string };
  /** USD; kept in whole cents. */
  budgetCap?: number;
  /** Set for a Factory Run (ticket → draft PR). Mirrors `FactoryTicket` in the Rust crate. */
  factory?: FactoryTicket;
}

/** One ticket a Factory Run turns into one draft PR (ADR-0049 §1). */
export interface FactoryTicket {
  /** `owner/name` on GitHub. */
  repo: string;
  /** The issue number; the PR says `Closes #<issue>`. 0 for a Notion ticket. */
  issue: number;
  title: string;
  body: string;
  /** The gh account of the Ticket Source. */
  account: string;
  /** The user's checkout of `repo`; only read, the run works in its own worktree. */
  checkout: string;
  /** The branch the PR targets, e.g. `main`. */
  base: string;
  /** The delegation preset id the implementer runs as. */
  implementer: string;
  /** What the issue's previous run reported when it stopped without a PR (Try again). */
  previousFailure?: string;
  /** Set when the ticket is a Notion page (#168); the code is still in `repo`. Read only. */
  notion?: { key: string; pageId: string; url: string };
  /** Set on a Revision Run (CoS 6): the Factory PR it revises and its round. */
  revision?: FactoryRevisionOf;
  /**
   * Set for a meta-repo run (ADR-0063): the Workspace folder. Until triage routes the run,
   * `checkout` is this folder and `repo` its name; triage then points both at the sub-repo.
   */
  workspace?: string;
  /**
   * A meta-repo run: the gh account of each connected GitHub source, by `owner/name`. Triage picks
   * the sub-repo mid-run, and the run then acts as that repo's account (else as `account`).
   */
  repoAccounts?: Record<string, string>;
}

/** What a Revision Run revises. Mirrors `RevisionOf` in the Rust crate. */
export interface FactoryRevisionOf {
  /** The run that opened the PR; its record keeps the PR's state. */
  original: string;
  prUrl: string;
  prNumber: number;
  branch: string;
  round: number;
  spec?: string;
  items: { id: string; author: string; body: string; path?: string; line?: number; label?: FactoryFeedbackLabel }[];
}

/** A Notion ticket as a Factory Run reads it (#168): every property, sorted by name, and its body. */
export interface FactoryNotionTicket {
  title: string;
  url: string;
  properties: [string, string][];
  markdown: string;
  truncated: boolean;
}

/** Reads a Notion ticket for a run. Read only: nothing is written to Notion. */
export function factoryNotionTicket(pageId: string): Promise<FactoryNotionTicket> {
  return tauriInvoke<FactoryNotionTicket>("notion_ticket_text", { pageId });
}

/** The sub-repos of a Factory Workspace: git folders one level down, by name. */
export function factoryGitSubfolders(folder: string): Promise<string[]> {
  return tauriInvoke<string[]>("factory_git_subfolders", { folder });
}

/** The stages of a Factory Run, in order. Mirrors `FactoryStage` in the Rust crate. */
export type FactoryStage = "triage" | "worktree" | "spec" | "building" | "checking" | "review" | "draft-pr" | "push";

/** One stage as it ran; `endedAt` is unset while it runs. */
export interface FactoryProgressStep {
  stage: FactoryStage;
  attempt: number;
  startedAt: number;
  endedAt?: number;
  costUsd?: number;
}

/** Where a Factory Run is inside its step. Mirrors `FactoryProgress` in the Rust crate. */
export interface FactoryProgress {
  stage: FactoryStage;
  attempt: number;
  maxAttempts: number;
  steps: FactoryProgressStep[];
  /** What the agent said it did, on the try that passed. Not checked by anything. */
  summary?: string;
  /** The last step an agent of this run took ("Edited src/a.rs"), and when (Unix ms). */
  lastOutput?: { at: number; text: string };
  /** The repo's `stall_minutes`, once the run read its factory definition. */
  stallMinutes?: number;
  /** The repo's `poll_minutes`: how often the Chief of Staff looks at the run's PR. */
  pollMinutes?: number;
  /** A Revision Run's verdict per item, once it pushed (CoS 6). */
  round?: { round: number; head?: string; items: { id: string; status: FactoryFeedbackItem["status"]; why: string }[] };
  /** How the PR was opened (ADR-0063 §7); absent on runs saved before Open PRs, which were all Drafts. */
  prOpening?: { draft: boolean; reason?: string; branch?: string };
}

/** One question the spec agent asks. Mirrors `Question` in the Rust crate. */
export interface FactoryQuestion {
  question: string;
  /** 2 to 5 choices. */
  choices: string[];
  /** One of `choices`. */
  recommended: string;
  why: string;
}

/** The user's answer: a choice, a note, or both; at least one. */
export interface FactoryAnswer {
  choice?: string;
  note: string;
}

/** One turn of a Factory Run's intake. Mirrors `IntakeTurn` in the Rust crate. */
/** One question settled in Brainstorm live. Mirrors `Clarification` in the Rust crate. */
export interface FactoryClarification {
  question: string;
  answer: string;
}

/** What a spec's markdown was rendered from. Mirrors `SpecDoc` in the Rust crate (snake_case on purpose). */
export interface FactorySpecDoc {
  goal: string;
  acceptance_criteria: string[];
  out_of_scope: string[];
  assumptions: string[];
  test_plan: string[];
  files: string[];
  /** A meta-repo run: the sub-repos the change lands in; approved with the spec, then locked. */
  repos?: string[];
  /** Detail the lists cannot hold (UI flow, design decisions, data shapes), as markdown. */
  design_notes?: string;
  clarifications?: FactoryClarification[];
}

export type FactoryIntakeTurn =
  /** `superseded` = a spec from Brainstorm live came while it waited unanswered; it does not count as a round. */
  | { kind: "asked"; questions: FactoryQuestion[]; answers?: FactoryAnswer[]; superseded?: boolean; at: number }
  /**
   * `live` = written in Brainstorm live; `sentBack` = the user's note when they sent it back;
   * `doc` = what the markdown was rendered from; `edited` = the user changed the markdown when approving.
   */
  | { kind: "spec"; markdown: string; sentBack?: string; live: boolean; doc?: FactorySpecDoc; edited?: boolean; at: number };

export type FactorySize = "XS" | "S" | "M" | "L" | "XL";
export type FactoryReadinessLevel = "clear" | "partial" | "missing";
export type FactoryReadinessKey =
  | "scope"
  | "dataModel"
  | "uxFlow"
  | "nonFunctional"
  | "integrations"
  | "edgeCases"
  | "constraints"
  | "terminology"
  | "completion";

/** The triage agent's report, with Lotus's score. Mirrors `TriageReport` in the Rust crate. */
export interface FactoryTriageReport {
  size: FactorySize;
  readiness: Record<FactoryReadinessKey, FactoryReadinessLevel>;
  score: "green" | "yellow" | "red";
  verdict: "go" | "brainstorm" | "refuse";
  reason: string;
  summary: string;
  files: string[];
  /** A meta-repo run (ADR-0063): the sub-repo folder(s) triage chose, and why. */
  repos?: string[];
  repoReason?: string;
  /** The change type for the branch, commit and PR title templates. */
  type?: "feat" | "fix" | "refactor" | "chore";
}

/** Work on the issue that already exists. Mirrors `Duplicate` in the Rust crate. */
export interface FactoryDuplicate {
  kind: "pr" | "branch";
  branch: string;
  number?: number;
  url?: string;
}

/** What triage found (FI3). Mirrors `Triage` in the Rust crate. */
export interface FactoryTriage {
  /** Absent while duplicates stopped the run before the agent ran. */
  report?: FactoryTriageReport;
  duplicates: FactoryDuplicate[];
  labels: string[];
  /** Checks that could not run; the triage went on without them. */
  notes: string[];
  duplicatesAccepted: boolean;
  refusalOverridden: boolean;
  at: number;
}

/** A Factory Run's intake: triage, then what the spec agent asked and wrote. Mirrors `Intake` in the Rust crate. */
export interface FactoryIntake {
  sessionId?: string;
  turns: FactoryIntakeTurn[];
  approved: boolean;
  triage?: FactoryTriage;
  /** New criteria added after the PR opened, from accepted spec changes (CoS 8). */
  amendments?: FactoryAmendment[];
}

/** Mirrors `Amendment`: new acceptance criteria on an approved spec, from a reviewer's spec change. */
export interface FactoryAmendment {
  n: number;
  at: number;
  /** The Feedback Item it came from. */
  item: string;
  author: string;
  url?: string;
  /** `AC-5: …`, numbered after the spec's last. */
  criteria: string[];
}

/** What the user decides for a run waiting on its intake. Mirrors `Decision` in the app crate. */
export type FactoryDecision =
  | { kind: "answer"; answers: FactoryAnswer[] }
  /** `spec` = the user's edited spec; absent = approved as written. */
  | { kind: "approve"; spec?: string }
  | { kind: "send-back"; note: string }
  /** "Continue anyway" on a run its triage stopped. */
  | { kind: "proceed" };

/** Starts a run; resolves with its id once it is recorded. Rejects on empty / cycle / no runner / busy member, or a Factory Run whose repo declares no gate. */
export function graphRunStart(input: GraphRunStartInput): Promise<string> {
  return tauriInvoke<string>("graph_run_start", { ...input });
}

/** What this Mac has for a Factory definition to name (FI4). Mirrors `Catalog` in `factory/kit.rs`. */
export interface FactoryCatalog {
  skills: { id: string; source: "factory" | "repo" | "meta" | "user" | "plugin"; description: string | null; plugin?: string }[];
  /** `target` is the program's file name or the URL's host: never args, env or headers. */
  mcp: { name: string; scope: "local" | "project" | "user" | "plugin"; transport: string; target: string; plugin?: string }[];
  /** Actionable partial-discovery warnings; the rest still lists. */
  notes: string[];
  /** Intentional disablement and capability boundaries. Optional for older hosts. */
  notices?: string[];
}

/** The skills and MCP servers for `checkout`; the repo's own are read at `origin/<base>`. */
/** `repo` adds the skills of Lotus's private factory for it (#169). */
export function factoryCatalog(checkout: string, base?: string, repo?: string): Promise<FactoryCatalog> {
  return tauriInvoke<FactoryCatalog>("factory_catalog", { checkout, base: base ?? null, repo: repo ?? null });
}

export type FactoryRole = "triage" | "spec" | "implement" | "review" | "handoff";

/** One role's agent. Mirrors `AgentDefinition` in `factory/definition.rs`. */
export interface FactoryAgentDefinition {
  role: FactoryRole;
  /** A delegation preset id; null = the run's own choice. */
  preset: string | null;
  /** `--model` in place of the preset's own; null = the preset's. */
  model: string | null;
  /** Review only (FI7): may run on the same preset and model as implement. */
  sameModel: boolean;
  skills: string[];
  mcp: string[];
  access: "read-only" | "full";
  timeoutMinutes: number | null;
  maxQuestions: number | null;
  prompt: string;
  /** The file it came from; null = built in. */
  source: string | null;
}

/** A repo's factory. Mirrors `FactoryDefinition` in `factory/definition.rs`. */
export interface FactoryDefinition {
  /** `base` in `.lotus/factory.toml`: the branch PRs go into; absent = origin's default branch. */
  base?: string;
  /** A program path in the repo; in a private factory, a shell command line. */
  gate: string;
  /** Lotus's private factory, kept outside the repo (#169). */
  private: boolean;
  capUsd: number | null;
  skills: string[];
  mcp: string[];
  skipBrainstorm: string[];
  /** Whether a feedback batch may start its Revision Run by itself (CoS 7). */
  revise?: "auto" | "confirm";
  /** What Lotus may post on the PR without a click (CoS 9). */
  replies?: "draft" | "auto-addressed";
  /** A line under every reply and summary Lotus posts. Absent = no footer. */
  replyFooter?: string;
  /** Always all five roles, in run order. */
  agents: FactoryAgentDefinition[];
}

export interface FactoryDefinitionSide {
  definition: FactoryDefinition | null;
  error: string | null;
}

/** The Agents tab's read (FI5). Mirrors `DefinitionView` in `factory/edit.rs`. */
export interface FactoryDefinitionView {
  /** The branch runs start from; null when origin's default branch is unknown. */
  base: string | null;
  /** `base` came from `.lotus/factory.toml` on origin's default branch (LOT2-192). */
  baseFromFile: boolean;
  /** What the next run uses: `origin/<base>`. */
  origin: FactoryDefinitionSide;
  /** What the tab edits: the checkout's files. */
  local: FactoryDefinitionSide;
  unpushed: { path: string; state: "changed" | "added" | "removed" }[];
  builtInPrompts: Record<FactoryRole, string>;
  notes: string[];
  /**
   * Set when the repo has no factory of its own: `local` is then Lotus's private factory in
   * `dir`, saves go there, and nothing is ever pushed (#169).
   */
  private: { dir: string } | null;
}

/** What Save writes for one role. Its access is fixed by the role. */
export interface FactoryAgentEdit {
  preset: string | null;
  model: string | null;
  sameModel: boolean;
  skills: string[];
  mcp: string[];
  timeoutMinutes: number | null;
  maxQuestions: number | null;
  prompt: string;
}

/** The definition of the repo in `checkout`, at origin and on disk; fetches first (15 s). */
/** `repo` lets a repo with no factory of its own show Lotus's private one (#169). */
export function factoryDefinitionView(checkout: string, base?: string, repo?: string): Promise<FactoryDefinitionView> {
  return tauriInvoke<FactoryDefinitionView>("factory_definition_view", { checkout, base: base ?? null, repo: repo ?? null });
}

export interface FactoryCheckPreview {
  id: string;
  repo: string;
  checkout: string;
  base: string;
  revision: string;
  command: string;
  shell: boolean;
  worktree: string;
  timeoutSeconds: number;
}
export interface FactoryCheckTrial extends FactoryCheckPreview {
  status: "running" | "passed" | "failed" | "cancelled" | "timed-out";
  exitCode: number | null;
  output: string;
  elapsedMs: number;
  currentRevision: string | null;
  message: string;
}

/** Creates an expiring read-only preview. Starting requires its exact opaque receipt. */
export function factoryCheckPreview(checkout: string, repo: string, base: string, command: string): Promise<FactoryCheckPreview> {
  return tauriInvoke("factory_check_preview", { checkout, repo, base, command });
}
export function factoryCheckStart(previewId: string): Promise<FactoryCheckTrial> {
  return tauriInvoke("factory_check_start", { previewId });
}
export function factoryCheckStatus(checkout: string, repo: string, base: string): Promise<FactoryCheckTrial | null> {
  return tauriInvoke("factory_check_status", { checkout, repo, base });
}
export function factoryCheckCancel(repo: string, id: string): Promise<void> {
  return tauriInvoke("factory_check_cancel", { repo, id });
}

/** Read-only metadata suggestions, not check execution. */
export function factoryCheckSuggestions(checkout: string): Promise<{ label: string; command: string; evidence: string }[]> {
  return tauriInvoke("factory_check_suggestions", { checkout });
}

export function factoryGateSave(checkout: string, repo: string, gate: string, privateFactory: boolean): Promise<FactoryDefinition> {
  return tauriInvoke("factory_gate_save", { checkout, repo, gate, private: privateFactory });
}

export function factoryPrivateRemove(repo: string): Promise<string> {
  return tauriInvoke("factory_private_remove", { repo });
}

export function factoryPrivateRestore(repo: string, recoveryId: string): Promise<FactoryDefinition> {
  return tauriInvoke("factory_private_restore", { repo, recoveryId });
}

export function factoryPrivateSetup(repo: string, gate: string): Promise<FactoryDefinition> {
  return tauriInvoke<FactoryDefinition>("factory_private_setup", { repo, gate });
}

/** Writes the role's agent file in the checkout (no commit, no push); `agent` null deletes it. */
export function factoryAgentSave(checkout: string, role: FactoryRole, agent: FactoryAgentEdit | null): Promise<FactoryDefinition> {
  return tauriInvoke<FactoryDefinition>("factory_agent_save", { checkout, role, agent });
}

/** Sets the skills and MCP servers every agent gets, in the checkout's `.lotus/factory.toml`. */
export function factorySharedSave(checkout: string, skills: string[], mcp: string[]): Promise<FactoryDefinition> {
  return tauriInvoke<FactoryDefinition>("factory_shared_save", { checkout, skills, mcp });
}

/** Raise cap on a run paused at its cap; resolves with the new cap. */
export function graphRunRaiseCap(id: string): Promise<number> {
  return tauriInvoke<number>("graph_run_raise_cap", { id });
}

/** Answers / approves / sends back a run waiting on its intake. Rejects with why when it does not fit. */
export function graphRunDecide(id: string, decision: FactoryDecision): Promise<void> {
  return tauriInvoke<void>("graph_run_decide", { id, decision });
}

/** What the Chief of Staff watches a run for (ADR-0056). Mirrors `ChiefSignal` in the Rust crate. */
export type FactoryChiefSignal = "waiting-on-you" | "paused-at-cap" | "stalled" | "recovery-required" | "budget-burn" | "feedback";

/** One Chief of Staff note on a run: a signal raised, or cleared, and why. */
export interface FactoryChiefEntry {
  /** Unix ms. */
  at: number;
  /** Absent on a note that is no signal ("While you were away: …"). */
  signal?: FactoryChiefSignal;
  raised: boolean;
  text: string;
}

/** Where a Factory PR stands (ADR-0056, "Factory PR state"). Mirrors `PrPhase` in the Rust crate. */
export type FactoryPrPhase = "in-review" | "revising" | "waiting-for-review" | "needs-you" | "out-of-rounds" | "merged" | "closed";

/** The Chief of Staff's view of a run's PR, kept on its record. Mirrors `PrWatch`. */
export interface FactoryPrWatch {
  number: number;
  url: string;
  phase: FactoryPrPhase;
  seen: { review: number; reviewComment: number; comment: number; checks?: "pending" | "passing" | "failing" };
  /** Every Feedback Item found on the PR, oldest first (CoS 5). Absent = none yet. */
  feedback?: FactoryFeedbackItem[];
  /** Closed batches, oldest first. */
  batches?: FactoryFeedbackBatch[];
  /** Its Revision Runs, oldest first (CoS 6). Absent = none yet. */
  rounds?: FactoryRevisionRound[];
  /** The repo's `max_rounds` when the last round started. */
  maxRounds?: number;
  /** Feedback ids of what Lotus posted as the user, never read as feedback (CoS 9). */
  posted?: string[];
}

/** Rounds per Factory PR when the repo's factory.toml sets no `max_rounds`. Mirrors `DEFAULT_MAX_ROUNDS`. */
export const DEFAULT_MAX_ROUNDS = 3;

/** One Revision Run of a Factory PR. Mirrors `RevisionRound`. */
export interface FactoryRevisionRound {
  round: number;
  runId: string;
  startedAt: number;
  items: string[];
  /** Absent while it runs. */
  ended?: "pushed" | "needs-you";
  endedAt?: number;
  /** What it pushed, or why it needs you. */
  note?: string;
  /** It started by itself on failing CI alone (CoS 7): a PR gets one. */
  ciOnly?: boolean;
  /** The round summary Lotus would post on the PR (CoS 9). */
  summary?: string;
  /** When the summary was posted (Unix ms). */
  summarySent?: number;
  /** Its replies and summary are drafted. */
  drafted?: boolean;
  /** When the reviewers whose items it addressed were asked to review again (Unix ms). */
  rerequested?: number;
  /** The reply drafted for the Slack thread the PR's link was shared in (CoS 12). Absent = no thread. */
  slack?: FactorySlackReply;
}

/** A Slack thread a Factory PR's link was shared in. Mirrors `SlackThread`. */
export interface FactorySlackThread {
  channel: string;
  /** Without the `#`. */
  channelName: string;
  /** The thread's root message. */
  ts: string;
  permalink: string;
}

/** "Round N is pushed … Could you re-review?" in the PR's Slack thread. Mirrors `SlackReply`. */
export interface FactorySlackReply {
  thread: FactorySlackThread;
  /** Without the mentions: the known ones go in front when it is posted. */
  text: string;
  /** The reviewers the round asks again; `slack` = their member ID once known. */
  mention?: { github: string; slack?: string }[];
  /** When it was posted (Unix ms). */
  sent?: number;
}

/** Mirrors `FeedbackLabel`. */
export type FactoryFeedbackLabel = "change" | "nit" | "question" | "spec-change" | "none";
export const FACTORY_FEEDBACK_LABELS: readonly FactoryFeedbackLabel[] = ["change", "nit", "question", "spec-change", "none"];

/** One thing a reviewer or CI said on a Factory PR. Mirrors `FeedbackItem`. */
export interface FactoryFeedbackItem {
  /** `review:<id>`, `line:<id>`, `comment:<id>`, `check:<id>` or `status:<sha>`. */
  id: string;
  source: "review" | "review-comment" | "pr-comment" | "check";
  author: string;
  /** Passes the author filter; other items are shown and never start work. */
  counts: boolean;
  body: string;
  path?: string;
  line?: number;
  url?: string;
  at: number;
  label?: FactoryFeedbackLabel;
  /** The model's, 0 to 1. */
  confidence?: number;
  labelBy?: "rule" | "model" | "you";
  /** Why the label is missing or not trusted. */
  unsure?: string;
  /** `out-of-scope`: a spec change the user declined (CoS 8). */
  status: "new" | "in-round" | "addressed" | "not-addressed" | "declined" | "needs-you" | "out-of-scope";
  batch?: number;
  /** The drafted reply; posted only when the user presses Send. */
  reply?: string;
  /** When `reply` was posted (Unix ms, CoS 9). */
  replySent?: number;
  /** Why a round declined it or did not address it (CoS 6). */
  why?: string;
  /** A spec change the user accepted: its Amendment's number (CoS 8). */
  amendment?: number;
}

/** Mirrors `FeedbackBatch`. */
export interface FactoryFeedbackBatch {
  id: number;
  closedAt: number;
  reason: "review" | "checks" | "quiet";
  items: string[];
}

/** The Chief of Staff's notes on one run, kept on its record. */
export interface FactoryChiefLog {
  log: FactoryChiefEntry[];
  /** Raised and not cleared yet. */
  open: FactoryChiefSignal[];
}

/** When the Chief of Staff last looked at the runs (Unix ms); null before its first look. */
export function factoryChiefCheckedAt(): Promise<number | null> {
  return tauriInvoke<number | null>("factory_chief_checked_at");
}

/** The user's label for a Feedback Item (CoS 5). The run changes; the page reads it again. */
export function factorySetFeedbackLabel(runId: string, itemId: string, label: FactoryFeedbackLabel): Promise<void> {
  return tauriInvoke<void>("factory_set_feedback_label", { runId, itemId, label });
}

/** Starts the next Revision Run on the PR that run `runId` opened ("Start round", CoS 6). Returns the round's run id. */
export function factoryStartRound(runId: string): Promise<string> {
  return tauriInvoke<string>("factory_start_round", { runId });
}

/** Accepts a spec change: `criteria` become an Amendment on the approved spec (CoS 8). Starts no round. */
export function factoryAcceptSpecChange(runId: string, itemId: string, criteria: string[]): Promise<void> {
  return tauriInvoke<void>("factory_accept_spec_change", { runId, itemId, criteria });
}

/** Declines a spec change as out of scope; a reply is drafted and nothing is posted (CoS 8). */
export function factoryDeclineSpecChange(runId: string, itemId: string): Promise<void> {
  return tauriInvoke<void>("factory_decline_spec_change", { runId, itemId });
}

/** Sets a reply draft's text (`key` = an item id or `summary:<round>`); empty discards it (CoS 9). */
export function factoryEditDraft(runId: string, key: string, text: string): Promise<void> {
  return tauriInvoke<void>("factory_edit_draft", { runId, key, text });
}

/** Send: posts one reply draft on the PR as the user (CoS 9). */
export function factorySendDraft(runId: string, key: string): Promise<void> {
  return tauriInvoke<void>("factory_send_draft", { runId, key });
}

/** Send all: posts every draft, then asks the reviewers whose items were addressed to review again (CoS 9). */
export function factorySendAll(runId: string): Promise<void> {
  return tauriInvoke<void>("factory_send_all", { runId });
}

/** Remembers GitHub `github`'s Slack member ID and puts it into every Slack reply that waits (CoS 12). */
export function factorySetSlackIdentity(github: string, slack: string): Promise<void> {
  return tauriInvoke<void>("factory_set_slack_identity", { github, slack });
}

/** The Slack thread run `runId`'s PR link was shared in, as Slack search finds it now; null = none (CoS 12). */
export function factoryFindSlackThread(runId: string): Promise<FactorySlackThread | null> {
  return tauriInvoke<FactorySlackThread | null>("factory_find_slack_thread", { runId });
}

/** Opens a Factory Run's worktree in Finder; rejects when the run has none any more. */
export function factoryOpenWorktree(id: string): Promise<void> {
  return tauriInvoke<void>("factory_open_worktree", { id });
}

export function graphRunAbort(id: string): Promise<void> {
  return tauriInvoke<void>("graph_run_abort", { id });
}

export function onGraphRunChanged(handler: (event: GraphRunChanged) => void): Promise<UnlistenFn> {
  return listen<GraphRunChanged>(GRAPH_RUN_CHANGED_EVENT, (event) => handler(event.payload));
}
