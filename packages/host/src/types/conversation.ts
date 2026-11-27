/** Follow Agent Client Protocol shapes so native and converted transcripts can feed the same client (plans/pocket-chat-conversation-model/RESEARCH.md). */

import type { PermissionPart, QuestionPart } from "./interaction.js";

export type { PermissionOption, PermissionPart, QuestionPart } from "./interaction.js";

/** How much of a given part kind this cell's pipeline can deliver. */
export type CapLevel =
  /** The runner and this host's pipeline both produce it. */
  | "expected"
  /** Something arrives, but derived or incomplete — a diffstat without the patch, a status inferred from pairing. */
  | "partial"
  /** Not coming from this runner through this pipeline. Not late — never. */
  | "never";

/** Report what each host pipeline delivers so clients can distinguish missing part types from unavailable transcripts. */
export interface RunnerTranscriptCaps {
  turns: CapLevel;
  text: CapLevel;
  streaming: CapLevel;
  reasoning: CapLevel;
  toolCalls: CapLevel;
  toolStatus: CapLevel;
  diff: CapLevel;
  output: CapLevel;
  permission: CapLevel;
  plan: CapLevel;
  subagent: CapLevel;
  usage: CapLevel;
  mode: CapLevel;
}

/** Where a part's facts came from. */
export type Provenance =
  /** The runner's own structured record (an ACP update, an app-server item). None yet — Fase 4. */
  | "native"
  /** Read from the runner's conversation file and reshaped by the host. */
  | "derived"
  /** Rebuilt from the hook ring: bounded, volatile, and the least a part can be. */
  | "hook";

export interface PartBase {
  /**
   * Stable across pages and across the REST / stream seam, so a client can dedupe by it.
   * Derived deterministically from the entry it came from until runners give us real ids.
   */
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  /** Order within the page — timestamps collide inside a millisecond. */
  seq: number;
  provenance: Provenance;
  /** The subagent this part belongs to, when the runner reports nesting. Absent = main agent. */
  agentId?: string;
  /** The tool call that spawned the subagent this part belongs to. */
  parentToolCallId?: string;
}

export interface UserMessagePart extends PartBase {
  type: "user_message";
  text: string;
}

export interface AssistantTextPart extends PartBase {
  type: "assistant_text";
  text: string;
  state: "streaming" | "done";
  /** True when `text` stops short of what the agent said (the 8000-byte hook cap). */
  truncated: boolean;
}

export interface ReasoningPart extends PartBase {
  type: "reasoning";
  text: string;
  redacted: boolean;
}

/** ACP `ToolKind`, verbatim. */
export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
/** ACP `ToolCallStatus` plus v2's `cancelled`. */
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface ToolLocation {
  path: string;
  line?: number;
}

export interface FileDiff {
  path: string;
  op: "add" | "delete" | "modify" | "move";
  /** Absent, not zero, when the pipeline had no count — `contract/README.md` says why. */
  additions?: number;
  deletions?: number;
}

export interface ToolCallPart extends PartBase {
  type: "tool_call";
  toolCallId: string;
  /** What the step did, in the runner's words — `Edit`, `exec`, `lotus_list_fleet`. */
  toolName: string;
  /** The one-line target a step renders beside its name — a path, a command, a query. */
  title: string;
  kind: ToolKind;
  status: ToolStatus;
  locations: ToolLocation[];
  diff?: { files: FileDiff[] };
  output?: { text: string; exitCode?: number; truncated: boolean };
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface PlanUpdatePart extends PartBase {
  type: "plan_update";
  entries: PlanEntry[];
}

export interface ModeChangePart extends PartBase {
  type: "mode_change";
  modeId: string;
}

export interface StatusPart extends PartBase {
  type: "status";
  state: "running" | "idle" | "requires_action" | "compacted" | "retrying" | "ended";
  detail?: string;
}

export interface ResultPart extends PartBase {
  type: "result";
  isError: boolean;
  numTurns?: number;
  durationMs?: number;
  usage?: { input?: number; output?: number; cachedRead?: number; cachedWrite?: number };
  costUsd?: number;
}

export interface ErrorPart extends PartBase {
  type: "error";
  message: string;
  recoverable: boolean;
}

/**
 * An event this host could not name. Kept rather than dropped — the rule Chat has always
 * followed for an unknown `event`, now with the raw type beside it so the phone can draw
 * a step and the operator can report what it was.
 */
export interface UnknownPart extends PartBase {
  type: "unknown";
  rawType: string;
  summary: string;
}

export type Part =
  | UserMessagePart
  | AssistantTextPart
  | ReasoningPart
  | ToolCallPart
  | PermissionPart
  | QuestionPart
  | PlanUpdatePart
  | ModeChangePart
  | StatusPart
  | ResultPart
  | ErrorPart
  | UnknownPart;

export type StopReason = "end_turn" | "cancelled" | "error" | "max_turns";

export interface Turn {
  turnId: string;
  startedAt: number;
  /** Absent while the turn is still open — the last turn on a live cell usually is. */
  endedAt?: number;
  stopReason?: StopReason;
  parts: Part[];
}

export interface ConversationPage {
  paneId: string;
  /** Runner family — `claude`, `codex`, `cursor`, `custom` — the key `capabilities` was looked up by. */
  runner: string;
  /** What the operator calls it, when the fleet knows (`FleetMember.runnerLabel`). */
  runnerLabel?: string;
  capabilities: RunnerTranscriptCaps;
  /** Same meaning as on `TranscriptResponse`; `hook` provenance follows from `ring`. */
  source: "file" | "ring";
  turns: Turn[];
  oldestCursor?: number;
  hasMore: boolean;
  totalEver?: number;
  /** Carried through from `/transcript`, same three-way meaning. */
  hostSupports?: boolean;
  transcriptOutlook?: "never" | "unknown";
}

/** Resend the settled part so clients may ignore incremental text deltas without losing content (ADR-4). */
export type ConversationUpdate =
  | { kind: "turn"; turn: Omit<Turn, "parts"> }
  | { kind: "part"; turnId: string; part: Part }
  | {
      kind: "text";
      turnId: string;
      /** The `Part.id` this grows. Always one a `part` update opened first. */
      partId: string;
      /** What was appended — **not** the text so far. */
      delta: string;
      /** The part's `seq` after the append, so a client orders it against a later revision. */
      seq: number;
    };

/** One conversation delta as the host logs it, with the per-cell cursor a client resumes from. */
export type ConversationListener = (paneId: string, agentType: string, update: ConversationUpdate, cursor: number) => void;

export interface ConversationResume {
  deltas: Array<{ cursor: number; agentType: string; update: ConversationUpdate }>;
  /** The asked cursor fell off the ring: the client must refetch the page. */
  truncated: boolean;
  oldestCursor: number;
}

/** What a `/v1/chat-cell/:action` call answers: the HTTP status and JSON body, decided by the adapter. */
export interface ChatActionResult {
  status: number;
  body: Record<string, unknown>;
}
