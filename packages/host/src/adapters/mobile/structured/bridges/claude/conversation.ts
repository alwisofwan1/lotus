import type {
  ConversationPage,
  ConversationUpdate,
  Part,
  PermissionOption,
  PermissionPart,
  QuestionPart,
  ToolCallPart,
  Turn,
} from "../../../../../types/conversation.js";
import { runnerTranscriptCaps } from "../../../conversation/runner-caps.js";
import { isRecord } from "../acp/parts.js";
import {
  blocksOf,
  denialsOf,
  rateLimitNotice,
  rateLimitOf,
  stopReasonOf,
  toolKindOf,
  toolResultText,
  toolTargetOf,
  usageOf,
  type ClaudeMessage,
  type RateLimitWindow,
} from "./messages.js";
import { applyAssistant, applyDelta, applyToolResults } from "./blocks.js";
import {
  CLAUDE_STREAM_CAPS,
  claudePermissionPart,
  closingParts,
  findPending,
  findPendingQuestion,
} from "./pending.js";

/**
 * A `claude --print --output-format stream-json` session as a live [`ConversationPage`].
 *
 * Turn boundaries come from the protocol, unlike ACP: a prompt opens one and `result`
 * closes it. In between is Claude's own account — real `tool_use` ids, the `tool_result`
 * answering each, thinking as its own part, streamed text under `--include-partial-messages`.
 *
 * **Approvals are real here.** `--permission-prompt-tool` names an MCP tool the runner calls
 * before a gated tool runs, and — probed 2026-09-07 — it then **waits indefinitely**. So a
 * `permission` part is a question the operator is holding, answered by digit like every other
 * bridge. A tool refused anyway is still named in `result.permission_denials`.
 */
export class ClaudeConversation {
  private readonly turns: Turn[] = [];
  private readonly listeners: Array<(u: ConversationUpdate) => void> = [];
  private seq = 0;
  private openTurnId: string | undefined;
  private nextTurn = 0;
  /** Claude's own session id, from `system/init`. */
  sessionId: string | undefined;
  /** The last rate-limit window the runner volunteered. */
  rateLimit: RateLimitWindow | undefined;
  /** @internal for `blocks.ts`. The streaming text part currently growing. */
  streamingText: string | undefined;

  constructor(readonly paneId: string) {}

  onUpdate(listener: (u: ConversationUpdate) => void): void {
    this.listeners.push(listener);
  }

  page(): ConversationPage {
    return {
      paneId: this.paneId,
      runner: "claude",
      // Read off this wire, not off the hook table: over `stream-json` the runner reports
      // what a hook pipeline could only pair up by name and guess at.
      capabilities: { ...runnerTranscriptCaps("claude"), ...CLAUDE_STREAM_CAPS },
      source: "file",
      turns: this.turns.map((t) => ({ ...t, parts: [...t.parts] })),
      hasMore: false,
      totalEver: this.turns.reduce((n, t) => n + t.parts.length, 0),
    };
  }

  /** The question this cell is holding, if any — what `/permission` reports. */
  pendingPermission(): PermissionPart | undefined {
    return findPending(this.turns);
  }

  /** The newest question this cell is holding, if any. */
  pendingQuestion(): QuestionPart | undefined {
    return findPendingQuestion(this.turns);
  }

  /** The id of whatever this cell is holding — a question or a permission, one at a time. */
  pendingRequestId(): string | undefined {
    return this.pendingQuestion()?.requestId ?? this.pendingPermission()?.requestId;
  }

  /** The runner is asking. Recorded as a part; the answer comes back through [`decide`]. */
  requestPermission(requestId: string, request: {
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
  }): PermissionPart | QuestionPart {
    const part = claudePermissionPart({ ...request, requestId, stamp: this.stamp(`perm-${requestId}`) });
    this.upsert(part);
    return part;
  }

  /**
   * Answer by printed digit — a permission's option, or a question's.
   *
   * One entry point for both because the caller has one: a digit arrives on `/input` and no
   * route knows, or needs to know, which of the two this cell is holding.
   */
  decide(requestId: string, key: string): PermissionOption | undefined {
    const question = this.pendingQuestion();
    if (question !== undefined && question.requestId === requestId) {
      const asked = question.questions[0];
      const option = asked?.options.find((o) => o.key === key.trim());
      if (asked === undefined || option?.key === undefined) return undefined;
      this.upsert({ ...question, answered: { [asked.question]: [option.label] }, seq: this.seq++ });
      return { key: option.key, label: option.label, kind: "allow_once" };
    }
    const part = this.pendingPermission();
    if (part === undefined || part.requestId !== requestId) return undefined;
    const option = part.options.find((o) => o.key === key.trim());
    if (option === undefined) return undefined;
    this.upsert({ ...part, outcome: { selected: option.key }, seq: this.seq++ });
    return option;
  }

  openTurn(prompt?: string): string {
    const turnId = `t-${this.nextTurn++}`;
    const startedAt = Date.now();
    this.turns.push({ turnId, startedAt, parts: [] });
    this.openTurnId = turnId;
    this.streamingText = undefined;
    this.emit({ kind: "turn", turn: { turnId, startedAt } });
    if (prompt !== undefined) {
      this.upsert({ type: "user_message", text: prompt, ...this.stamp(`${turnId}-prompt`) });
    }
    return turnId;
  }

  /** One line off the runner's stdout. Anything unreadable becomes an `unknown` part. */
  apply(message: ClaudeMessage): void {
    switch (message.type) {
      case "system":
        return this.system(message);
      case "stream_event":
        return applyDelta(this, message);
      case "assistant":
        return applyAssistant(this, message);
      case "user":
        return applyToolResults(this, message);
      case "rate_limit_event":
        return this.planWindow(message);
      case "result":
        return this.result(message);
      default:
        this.upsert({
          type: "unknown",
          rawType: message.type,
          summary: JSON.stringify(message).slice(0, 200),
          ...this.stamp(`unknown-${this.seq}`),
        });
    }
  }

  /**
   * A plan window the runner volunteered. A change away from `allowed` is said in the
   * **transcript**, where the operator already is — the whole of G8: an exhausted plan must
   * not read as an odd reply.
   */
  private planWindow(message: ClaudeMessage): void {
    const window = rateLimitOf(message);
    if (window === undefined) return;
    const notice = rateLimitNotice(window, this.rateLimit?.status);
    this.rateLimit = window;
    if (notice === undefined) return;
    this.upsert({
      type: "error",
      message: notice,
      recoverable: true,
      ...this.stamp(`limit-${window.window}-${window.status}`),
    });
  }

  /** `status`/`thinking_tokens`/`hook_*` are the runner narrating itself, and not steps. */
  private system(message: ClaudeMessage): void {
    if (message["subtype"] === "init" && typeof message["session_id"] === "string") {
      this.sessionId = message["session_id"];
    }
  }

  private result(message: ClaudeMessage): void {
    const turnId = this.openTurnId;
    const turn = this.turns.find((t) => t.turnId === turnId);
    if (turn === undefined || turnId === undefined) return;
    if (typeof message["session_id"] === "string") this.sessionId = message["session_id"];
    turn.endedAt = Date.now();
    turn.stopReason = stopReasonOf(message);
    this.settleStreaming();
    for (const part of closingParts(message, turn.endedAt - turn.startedAt, (s) =>
      this.stamp(`${turnId}-${s}`),
    )) {
      this.upsert(part);
    }
    this.emit({
      kind: "turn",
      turn: { turnId, startedAt: turn.startedAt, endedAt: turn.endedAt, stopReason: turn.stopReason },
    });
    this.openTurnId = undefined;
  }

  private settleStreaming(): void {
    const id = this.streamingText;
    const held = id === undefined ? undefined : this.existing(id);
    if (held?.type === "assistant_text") this.upsert({ ...held, state: "done", seq: this.seq++ });
    this.streamingText = undefined;
  }

  /**
   * @internal for `blocks.ts`. The arrival counter, read and advanced separately: an id is
   * minted from the count as it stands, while a revision needs a *new* one so a client can
   * order it after what it replaces.
   */
  seqNow(): number {
    return this.seq;
  }

  /** @internal for `blocks.ts`. */
  nextSeq(): number {
    return this.seq++;
  }

  /** @internal for `blocks.ts`. */
  turnId(): string {
    return this.openTurnId ?? this.openTurn();
  }

  /** @internal for `blocks.ts`. */
  stamp(id: string): { id: string; ts: number; seq: number; provenance: "native" } {
    return { id, ts: Date.now(), seq: this.seq++, provenance: "native" };
  }

  /** @internal for `blocks.ts`. */
  existing(id: string): Part | undefined {
    return this.turns.find((t) => t.turnId === this.openTurnId)?.parts.find((p) => p.id === id);
  }

  /**
   * @internal for `blocks.ts`. Grows a streaming part by a chunk, putting **only the chunk**
   * on the wire.
   *
   * `false` when there is nothing to grow — no such part, or one that does not carry text —
   * and the caller then opens it with a `part` update, which is what a delta is only ever
   * allowed to follow. The page held here still accumulates the whole text, because
   * `/conversation` serves it to a client that was not listening.
   */
  appendText(id: string, chunk: string): boolean {
    const turnId = this.turnId();
    const turn = this.turns.find((t) => t.turnId === turnId);
    const at = turn?.parts.findIndex((p) => p.id === id) ?? -1;
    const held = at < 0 ? undefined : turn?.parts[at];
    if (turn === undefined || held === undefined || at < 0) return false;
    if (held.type !== "assistant_text" && held.type !== "reasoning") return false;
    const seq = this.seq++;
    turn.parts[at] = { ...held, text: held.text + chunk, seq };
    this.emit({ kind: "text", turnId, partId: id, delta: chunk, seq });
    return true;
  }

  /** @internal for `blocks.ts`. */
  upsert(part: Part): void {
    const turnId = this.turnId();
    const turn = this.turns.find((t) => t.turnId === turnId);
    if (turn === undefined) return;
    const i = turn.parts.findIndex((p) => p.id === part.id);
    if (i >= 0) turn.parts[i] = part;
    else turn.parts.push(part);
    this.emit({ kind: "part", turnId, part });
  }

  private emit(update: ConversationUpdate): void {
    for (const l of this.listeners) l(update);
  }
}
