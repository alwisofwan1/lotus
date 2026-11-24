import type { BridgeProvider } from "./api.js";
import type { ConversationPage, ConversationUpdate, PermissionPart, QuestionPart } from "./conversation.js";

/**
 * The seam between "an agent runs somewhere" and "Lotus knows what it is doing": the bridge
 * knows its provider's dialect, the store above it knows the timeline. Naming it before there
 * is a second implementation is what makes the second one an added file rather than a copied
 * store — `plans/provider-bridge-adoption/PLAN.md` §4.
 */

export interface BridgeConversation {
  onUpdate(listener: (u: ConversationUpdate) => void): void;
  page(): ConversationPage;
  /** The question this cell is holding, when it is holding one. */
  pendingPermission(): PermissionPart | undefined;
  /** The newest question this cell is holding. Absent on a bridge that cannot be asked one. */
  pendingQuestion?(): QuestionPart | undefined;
}

/**
 * What a runner says about the plan behind it, when it says anything.
 *
 * Deliberately the runner's **own words** for `status` and `window` rather than an enum of
 * ours: the vocabularies differ per provider and a normalised one would be wrong for
 * whichever provider moved next. A client renders the pair and decides nothing.
 *
 * This exists because of a failure worth naming: run against an exhausted Cursor plan, a turn
 * completed normally and the agent's prose was "upgrade your plan to continue" — a quota wall
 * indistinguishable from an answer (`plans/provider-bridge-adoption/PLAN.md` G8). A runner
 * that reports this makes that state a fact rather than a sentence to be interpreted.
 */
export interface ProviderUsage {
  /** `allowed`, `allowed_warning`, `rejected` — verbatim. */
  status: string;
  /** Which window it is about: `five_hour`, `weekly`, … */
  window: string;
  /** Epoch **seconds**, as runners send it. Absent when none was given. */
  resetsAt?: number;
}

/** A Chat Attachment as a bridge takes it: a file on this machine. */
export interface PromptAttachment {
  kind: "image" | "file";
  path: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface ProviderBridgeSession {
  readonly conversation: BridgeConversation;
  readonly alive: boolean;
  /** The runner's own session id, once it has said one. */
  readonly thread: string | undefined;
  start(): Promise<void>;
  prompt(text: string, attachments?: readonly PromptAttachment[]): Promise<void>;
  interrupt(): Promise<void>;
  /** Answer a pending permission by its printed key. `false` when nothing was waiting. */
  decide(key: string): boolean;
  /**
   * Moves this cell's posture **without restarting it**, in the runner's own vocabulary.
   *
   * Optional on the seam because it is a capability, not an assumption: `--permission-mode` is
   * a spawn flag for every runner here, and only one has been shown to take it back. Claude
   * does, over its control channel (probed 2026-09-09). A bridge that cannot must leave this
   * out, so a route can refuse instead of reporting a change that never happened.
   */
  setPermissionMode?(mode: string): Promise<void>;
  close(): void;
  /**
   * The plan window this runner last reported, if it reports one at all.
   *
   * Optional on the seam because most do not: Claude volunteers it on every turn, Codex
   * reports token counts but no quota, and ACP carries no usage at all (`usage_update` is
   * still an RFD). A bridge that cannot say must leave this out rather than answer a shape
   * meaning "fine" — the whole point is telling silence from health.
   */
  usage?(): ProviderUsage | undefined;
}

export interface ProviderBridgeSpawn {
  paneId: string;
  cwd: string;
  /** One stop on the scale this runner advertises; expanding it into the provider's own axes is the factory's job. */
  permissionMode?: string;
  model?: string;
  effort?: string;
  /**
   * Which of the machine's authenticated accounts to run as.
   *
   * One cell, one account, chosen deliberately — its limits stay its own. Absent means the
   * runner's own default, which is what every cell did before this existed. A bridge whose
   * provider has no such notion ignores it; one that does must **refuse** an id it cannot
   * resolve rather than fall back, because launching under the wrong account does not read as
   * an error, it reads as an expired session.
   */
  profileId?: string;
  /** The runner's conversation id to continue instead of starting one. A bridge that cannot resume throws. */
  resume?: string;
}

export interface ProviderBridgeFactory {
  /**
   * This runner's own word for a stop on the phone's scale — the same translation the factory
   * already performs at spawn, exposed so a **later** change goes through one mapping rather
   * than a second one that can drift from it.
   */
  posture?(mode: string | undefined): string;
  /** Closed union on purpose: adding a runner starts by widening `BridgeProvider`, and the compiler says so. */
  readonly agentType: BridgeProvider;
  readonly runnerLabel: string;
  /** Whether the binary is here. A host never advertises a runner it cannot start. */
  available(env?: NodeJS.ProcessEnv): boolean;
  /** Read from the same expansion `create` performs, so a member cannot claim `skipped` while the cell waits. */
  gating(permissionMode: string | undefined): "asks" | "skipped";
  create(spawn: ProviderBridgeSpawn): ProviderBridgeSession;
}
