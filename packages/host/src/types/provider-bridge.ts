import type { BridgeProvider } from "./api.js";
import type { ConversationPage, ConversationUpdate, PermissionPart, QuestionPart } from "./conversation.js";

/** Keep provider-specific events behind the bridge so timelines can be shared (plans/provider-bridge-adoption/PLAN.md). */

export interface BridgeConversation {
  onUpdate(listener: (u: ConversationUpdate) => void): void;
  page(): ConversationPage;
  /** The question this cell is holding, when it is holding one. */
  pendingPermission(): PermissionPart | undefined;
  /** The newest question this cell is holding. Absent on a bridge that cannot be asked one. */
  pendingQuestion?(): QuestionPart | undefined;
}

/** Preserve provider quota vocabulary so clients can distinguish exhaustion from agent output (plans/provider-bridge-adoption/PLAN.md). */
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
  /** Expose live permission changes only when the runner can apply them without restarting. */
  setPermissionMode?(mode: string): Promise<void>;
  close(): void;
  /** Omit usage when the runner cannot report it so silence never implies healthy quota. */
  usage?(): ProviderUsage | undefined;
}

export interface ProviderBridgeSpawn {
  paneId: string;
  cwd: string;
  /** One stop on the scale this runner advertises; expanding it into the provider's own axes is the factory's job. */
  permissionMode?: string;
  model?: string;
  effort?: string;
  /** Reject unresolved profile IDs when profiles are supported so the cell cannot launch under the wrong account. */
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
