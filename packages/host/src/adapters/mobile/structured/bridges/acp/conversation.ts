import type {
  ConversationPage,
  ConversationUpdate,
  Part,
  PermissionPart,
  Turn,
} from "../../../../../types/conversation.js";
import { runnerTranscriptCaps } from "../../../conversation/runner-caps.js";
import {
  type AcpUpdate,
  isRecord,
  mergeToolCall,
  normalizeToolCallId,
  permissionOptions,
  planEntries,
  readStopReason,
  textOf,
} from "./parts.js";

/**
 * ACP as a live [`ConversationPage`]. **ACP v1 has no turn events**: the session calls
 * [`openTurn`] / [`closeTurn`] (`stopReason`); an update with no open turn opens one, else the
 * part is never seen. Fixture: `__tests__/fixtures/cursor-acp-turn.jsonl`.
 */
export class AcpConversation {
  private readonly turns: Turn[] = [];
  private readonly listeners: Array<(u: ConversationUpdate) => void> = [];
  private seq = 0;
  private openTurnId: string | undefined;
  private nextTurn = 0;
  private streamingText: string | undefined;
  private streamingThought: string | undefined;
  /** The `title` a tool call arrived with, which is its name before later updates retitle it. */
  private readonly toolNames = new Map<string, string>();
  /** The session title the agent picked for this thread, when it has said one. */
  title: string | undefined;
  /** The mode the agent reports it is in — `agent`, `plan`, `ask` for Cursor. */
  mode: string | undefined;

  constructor(readonly paneId: string, private readonly runner: string) {}

  onUpdate(listener: (u: ConversationUpdate) => void): void {
    this.listeners.push(listener);
  }

  page(): ConversationPage {
    return {
      paneId: this.paneId,
      runner: this.runner,
      capabilities: {
        ...runnerTranscriptCaps(this.runner),
        // Read off the wire, not off the runner table: over ACP this runner reports what the
        // hook pipeline could only guess at. `permission` stays as the table has it — Cursor
        // ran `rm` and a network call over ACP without ever asking (probe 2026-09-06).
        turns: "expected",
        text: "expected",
        streaming: "expected",
        reasoning: "expected",
        toolCalls: "expected",
        toolStatus: "expected",
        diff: "expected",
        output: "expected",
        mode: "expected",
      },
      source: "file",
      turns: this.turns.map((t) => ({ ...t, parts: [...t.parts] })),
      hasMore: false,
      totalEver: this.turns.reduce((n, t) => n + t.parts.length, 0),
    };
  }

  pendingPermission(): PermissionPart | undefined {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      for (const p of [...(this.turns[i]?.parts ?? [])].reverse()) {
        if (p.type === "permission" && p.outcome === undefined) return p;
      }
    }
    return undefined;
  }

  /** Called by the session when it sends a prompt; the prompt itself becomes the turn's first part. */
  openTurn(prompt?: string): string {
    const turnId = `t-${this.nextTurn++}`;
    const startedAt = Date.now();
    this.turns.push({ turnId, startedAt, parts: [] });
    this.openTurnId = turnId;
    this.streamingText = undefined;
    this.streamingThought = undefined;
    this.emit({ kind: "turn", turn: { turnId, startedAt } });
    if (prompt !== undefined) {
      this.upsert({ type: "user_message", text: prompt, ...this.stamp(`${turnId}-prompt`) });
    }
    return turnId;
  }

  /** Called with whatever `session/prompt` answered: `end_turn`, `cancelled`, `refusal`, an error. */
  closeTurn(stopReason: string | undefined, error?: string): void {
    const turnId = this.openTurnId;
    const turn = this.turns.find((t) => t.turnId === turnId);
    if (turn === undefined || turnId === undefined) return;
    turn.endedAt = Date.now();
    turn.stopReason = readStopReason(stopReason, error);
    this.settleStreaming();
    this.upsert({
      type: "result",
      isError: error !== undefined,
      durationMs: turn.endedAt - turn.startedAt,
      ...this.stamp(`${turnId}-result`),
    });
    if (error !== undefined) {
      this.upsert({ type: "error", message: error, recoverable: true, ...this.stamp(`${turnId}-error`) });
    }
    this.emit({
      kind: "turn",
      turn: { turnId, startedAt: turn.startedAt, endedAt: turn.endedAt, stopReason: turn.stopReason },
    });
    this.openTurnId = undefined;
  }

  /** One `session/update` notification. Anything unreadable becomes an `unknown` part, never a throw. */
  apply(update: AcpUpdate): void {
    switch (update.sessionUpdate) {
      case "session_info_update":
        if (typeof update["title"] === "string") this.title = update["title"];
        return;
      case "current_mode_update": {
        const modeId = update["currentModeId"];
        if (typeof modeId !== "string") return;
        this.mode = modeId;
        this.upsert({ type: "mode_change", modeId, ...this.stamp(`mode-${modeId}-${this.seq}`) });
        return;
      }
      // A menu, not a step. It changes what the composer offers, never the transcript.
      case "available_commands_update":
        return;
      case "user_message_chunk":
        this.upsert({ type: "user_message", text: textOf(update["content"]), ...this.stamp(`user-${this.seq}`) });
        return;
      case "agent_message_chunk":
        this.stream("text", textOf(update["content"]));
        return;
      case "agent_thought_chunk":
        this.stream("thought", textOf(update["content"]));
        return;
      case "tool_call":
      case "tool_call_update":
        this.toolCall(update);
        return;
      case "plan":
        this.plan(update);
        return;
      default:
        this.upsert({
          type: "unknown",
          rawType: update.sessionUpdate,
          summary: JSON.stringify(update).slice(0, 200),
          ...this.stamp(`unknown-${this.seq}`),
        });
    }
  }

  /** A `session/request_permission` server request, recorded so `/permission` can answer it. */
  requestPermission(requestId: string, params: unknown): PermissionPart | undefined {
    if (!isRecord(params)) return undefined;
    const toolCall = isRecord(params["toolCall"]) ? params["toolCall"] : {};
    const toolCallId = normalizeToolCallId(toolCall["toolCallId"]);
    const part: Part = {
      type: "permission",
      requestId,
      ...(toolCallId === "" ? {} : { toolCallId }),
      title: typeof toolCall["title"] === "string" ? toolCall["title"] : "Permission requested",
      options: permissionOptions(params["options"]),
      ...this.stamp(`perm-${requestId}`),
    };
    this.upsert(part);
    return part as PermissionPart;
  }

  /** Answer a pending permission by its `optionId`. Returns the id to send back, or `undefined`. */
  decide(requestId: string, key: string): string | undefined {
    const part = this.pendingPermission();
    if (part === undefined || part.requestId !== requestId) return undefined;
    const option = part.options.find((o) => o.key === key);
    if (option === undefined) return undefined;
    this.upsert({ ...part, outcome: { selected: option.key }, seq: this.seq++ });
    return option.key;
  }

  private toolCall(update: AcpUpdate): void {
    const toolCallId = normalizeToolCallId(update["toolCallId"]);
    if (toolCallId === "") return;
    const id = `tool-${toolCallId}`;
    const previous = this.existing(id);
    const held = previous?.type === "tool_call" ? previous : undefined;
    // The first title a call arrives with is the tool's name (`Read File`); later updates
    // replace it with the target (`Read notes.txt`). Keeping the first is the only way to
    // report a name at all — ACP carries no separate tool identifier.
    const title = typeof update["title"] === "string" ? update["title"] : held?.title ?? "";
    if (!this.toolNames.has(toolCallId) && title !== "") this.toolNames.set(toolCallId, title);
    const merged = mergeToolCall(update, held, this.toolNames.get(toolCallId) ?? title);
    // A call keeps the moment it opened; only its `seq` moves, so the phone can order the revision.
    this.upsert({ ...merged, ...this.stamp(id), ...(held === undefined ? {} : { ts: held.ts }) });
  }

  private plan(update: AcpUpdate): void {
    const entries = planEntries(update["entries"]);
    if (entries.length === 0) return;
    this.upsert({ type: "plan_update", entries, ...this.stamp(`plan-${this.turnId()}`) });
  }

  /**
   * Streamed prose and streamed reasoning are each one part that grows, not one part per
   * chunk: 46 `agent_message_chunk`s for two sentences in the capture, and a phone that
   * appended each of them would render a column of single words.
   */
  private stream(lane: "text" | "thought", chunk: string): void {
    const turnId = this.turnId();
    const id = lane === "text" ? this.streamingText : this.streamingThought;
    if (id === undefined) {
      const fresh = `${lane}-${turnId}-${this.seq}`;
      if (lane === "text") this.streamingText = fresh;
      else this.streamingThought = fresh;
      this.upsert(
        lane === "text"
          ? { type: "assistant_text", text: chunk, state: "streaming", truncated: false, ...this.stamp(fresh) }
          : { type: "reasoning", text: chunk, redacted: false, ...this.stamp(fresh) },
      );
      return;
    }
    this.append(id, chunk);
  }

  /**
   * Puts **only the chunk** on the wire; re-sending the part copies a growing prefix each time.
   * The page still accumulates the whole text for `/conversation`.
   */
  private append(id: string, chunk: string): void {
    const turnId = this.turnId();
    const turn = this.turns.find((t) => t.turnId === turnId);
    const at = turn?.parts.findIndex((p) => p.id === id) ?? -1;
    const held = at < 0 ? undefined : turn?.parts[at];
    if (turn === undefined || held === undefined || at < 0) return;
    if (held.type !== "assistant_text" && held.type !== "reasoning") return;
    const seq = this.seq++;
    turn.parts[at] = { ...held, text: held.text + chunk, seq };
    this.emit({ kind: "text", turnId, partId: id, delta: chunk, seq });
  }

  /** A turn that ended stops any text still marked `streaming`, so nothing renders as live forever. */
  private settleStreaming(): void {
    const id = this.streamingText;
    const held = id === undefined ? undefined : this.existing(id);
    if (held?.type === "assistant_text") this.upsert({ ...held, state: "done", seq: this.seq++ });
    this.streamingText = undefined;
    this.streamingThought = undefined;
  }

  private turnId(): string {
    return this.openTurnId ?? this.openTurn();
  }

  private stamp(id: string): { id: string; ts: number; seq: number; provenance: "native" } {
    return { id, ts: Date.now(), seq: this.seq++, provenance: "native" };
  }

  private existing(id: string): Part | undefined {
    return this.turns.find((t) => t.turnId === this.openTurnId)?.parts.find((p) => p.id === id);
  }

  private upsert(part: Part): void {
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
