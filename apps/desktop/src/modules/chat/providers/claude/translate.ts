// Translates Claude Agent SDK messages into provider-neutral ThreadEvents. Runs inside the chat
// bridge, one translator per thread. Pure: no I/O, ids come from `newId`.
//
// What the SDK stream looks like (see ./__fixtures__, recorded from real sessions):
// - With `includePartialMessages`, each API message streams as `stream_event` message_start →
//   content_block_start/delta/stop per block → message_delta (stop_reason) → message_stop. An
//   `assistant` message carrying the finished block arrives just before its content_block_stop.
// - Tool results come back as a `user` message with `tool_result` blocks, plus a structured
//   `tool_use_result` (diff, stdout, …) when there is exactly one result.
// - A turn ends with one `result` message. The SDK has no "turn started" message. With
//   `replay-user-messages`, the CLI echoes each input (`isReplay`, our `uuid`) when it takes it in:
//   with no turn open that input starts one; during a turn it is a steer the agent took in at a
//   tool boundary (PLAN finding 8). Without the echo (older fixtures), a turn starts at the first
//   message after the previous `result` and takes the oldest queued input.
// - An interrupted turn still ends with `subtype: "success"`; `terminal_reason` says "aborted_*".
//
// Shape of the block bookkeeping adapted from bb (plugins/provider-claude-code), Copyright (c)
// 2026 Michael Yong, MIT License — see apps/desktop/scripts/chat-bridge/LICENSE-bb.

import type { AuthSource, Interaction, Question, ThreadEvent, ThreadItem, TurnInput, TurnStatus, TurnUsage } from "../../domain/thread-event";
import { permissionLabel } from "../../domain/permissions";
import { asArr, asNum, asObj, asStr, type Obj } from "./read-json";
import { completeTool, contentText, toolItem } from "./tool-items";

interface Block {
  itemId: string;
  // Position in the streamed API message; null when the block only came in an `assistant` message.
  index: number | null;
  type: string;
  text: string;
  json: string;
  toolUseId: string | null;
  toolName: string | null;
  // The `assistant` message for this block has been seen.
  matched: boolean;
  done: boolean;
  // The Agent tool call this block's sub-agent runs under (`parent_tool_use_id`).
  parentId: string | null;
}

const under = (block: Block) => (block.parentId ? { parentId: block.parentId } : {});

interface OpenTextItem {
  kind: "agentMessage" | "reasoning";
  text: string;
}

export interface ToolPermissionNotice {
  toolName: string;
  toolUseId: string | null;
  input: unknown;
  blockedPath: string | null;
}

export interface ClaudeTranslatorOptions {
  newId?: () => string;
}

export class ClaudeTranslator {
  /** The sign-in Lotus asked this session to use; the CLI reports what it actually used. */
  requestedAuth: AuthSource | null = null;
  private readonly newId: () => string;
  private turnId: string | null = null;
  private forkPoint: string | null = null;
  private readonly queuedInputs: Array<{ uuid: string | null; input: TurnInput }> = [];
  // The input that opened the running turn, so its echo is not shown a second time.
  private turnInputUuid: string | null = null;
  private interruptRequested = false;
  private currentMessageId: string | null = null;
  private readonly blocksByMessage = new Map<string, Block[]>();
  private readonly openText = new Map<string, OpenTextItem>();
  private readonly runningTools = new Map<string, ThreadItem>();
  private readonly interactionTools = new Map<string, string | null>();
  private readonly declinedTools = new Set<string>();
  // Agent calls sent to the background: their result says "launched"; `task_notification` ends them.
  private readonly backgroundAgents = new Map<string, { turnId: string; item: ThreadItem }>();
  /** The mode the session reported last; null until its first `init`. */
  private permissionMode: string | null = null;
  private parent: string | null = null;
  // The main agent's latest model call: its prompt size is how full the context window is now.
  private lastCall: { tokens: number; model: string | null } | null = null;

  constructor(options: ClaudeTranslatorOptions = {}) {
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  // A user message was handed to the SDK with this `uuid`. It opens a turn or steers the running
  // one; the CLI's echo of it says which.
  noteInput(input: TurnInput, uuid: string | null = null): void {
    this.queuedInputs.push({ uuid, input });
  }

  noteInterrupt(): void {
    if (this.turnId) this.interruptRequested = true;
  }

  interactionRequested(interactionId: string, notice: ToolPermissionNotice): ThreadEvent[] {
    this.interactionTools.set(interactionId, notice.toolUseId);
    // AskUserQuestion reaches the host as a permission request; it is answered through
    // `updatedInput.answers` (PLAN finding 11).
    const questions = notice.toolName === "AskUserQuestion" ? readQuestions(notice.input) : null;
    const interaction: Interaction = questions
      ? { id: interactionId, kind: "question", itemId: notice.toolUseId, questions }
      : {
          id: interactionId,
          kind: "toolPermission",
          itemId: notice.toolUseId,
          toolName: notice.toolName,
          input: notice.input,
          blockedPath: notice.blockedPath,
        };
    return [{ type: "interaction/requested", turnId: this.turnId, interaction }];
  }

  interactionResolved(
    interactionId: string,
    decision: { behavior: "allow" | "deny"; message?: string; answers?: Record<string, string> },
  ): ThreadEvent[] {
    const toolUseId = this.interactionTools.get(interactionId);
    this.interactionTools.delete(interactionId);
    if (decision.behavior === "deny" && toolUseId) this.declinedTools.add(toolUseId);
    const answers = decision.behavior === "allow" ? (decision.answers ?? null) : null;
    return [
      {
        type: "interaction/resolved",
        interactionId,
        decision: answers ? "answered" : decision.behavior === "allow" ? "allowed" : "denied",
        message: decision.message ?? null,
        answers,
      },
    ];
  }

  translate(message: unknown): ThreadEvent[] {
    const msg = asObj(message);
    if (!msg) return [];
    // A sub-agent's messages come on the same stream, tagged with the Agent call they belong to.
    this.parent = asStr(msg.parent_tool_use_id);
    const out: ThreadEvent[] = [];
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") out.push(this.sessionConfigured(msg));
        // `init` and `status` carry the mode; it changes on its own when ExitPlanMode is allowed
        // (plan → default, seen live 2026-11-02). The first report is the mode Lotus started it in.
        if (msg.subtype === "init" || msg.subtype === "status") this.observeMode(asStr(msg.permissionMode), out);
        if (msg.subtype === "task_notification") this.backgroundAgentEnded(msg, out);
        // A level signal (replace, never pair edges); absent from CLIs that predate it.
        if (msg.subtype === "background_tasks_changed" && Array.isArray(msg.tasks)) {
          out.push({ type: "session/background", running: msg.tasks.length });
        }
        break;
      case "stream_event":
        this.streamEvent(asObj(msg.event), out);
        break;
      case "assistant":
        // The main chain's last entry is where a fork resumes through (`resumeSessionAt`).
        if (!msg.parent_tool_use_id && asStr(msg.uuid)) this.forkPoint = asStr(msg.uuid);
        this.assistant(asObj(msg.message), out);
        break;
      case "user":
        if (msg.isReplay === true) this.inputTakenIn(asStr(msg.uuid), out);
        else this.toolResults(msg, out);
        break;
      case "result":
        this.result(msg, out);
        break;
      case "rate_limit_event": {
        // Every turn sends one; only a warning or a rejection is worth keeping.
        const info = asObj(msg.rate_limit_info);
        const status = asStr(info?.status);
        if (info && status && status !== "allowed") {
          const resetsAt = typeof info.resetsAt === "number" && info.resetsAt > 0 ? info.resetsAt * 1000 : null;
          out.push({ type: "session/rateLimit", status, rateLimitType: asStr(info.rateLimitType), resetsAtMs: resetsAt });
        }
        break;
      }
      // hook_*, status, thinking_tokens, … carry nothing the thread shows.
    }
    return out;
  }

  // The SDK stream ended (session stopped or crashed). Closes a turn that never got its `result`.
  end(error: string | null): ThreadEvent[] {
    const out: ThreadEvent[] = [];
    if (this.turnId) this.completeTurn(out, error ? "failed" : "interrupted", error, null);
    // Messages handed over but never echoed: without a turn of their own the chat shows them as
    // "Starting" forever and they are in no history.
    while (this.queuedInputs.length > 0) {
      this.ensureTurn(out);
      this.completeTurn(out, "failed", error ?? "The session ended before Claude took this message in. Send it again.", null);
    }
    out.push({ type: "session/ended", error });
    return out;
  }

  private observeMode(mode: string | null, out: ThreadEvent[]): void {
    if (!mode || mode === this.permissionMode) return;
    if (this.permissionMode !== null) out.push({ type: "session/permissionChanged", mode, label: permissionLabel(mode) });
    this.permissionMode = mode;
  }

  private sessionConfigured(msg: Obj): ThreadEvent {
    const apiKeySource = asStr(msg.apiKeySource);
    // "none" = no API key: the user's own claude.ai login (or a cloud provider's own auth).
    const authSource: AuthSource =
      apiKeySource === "none" ? "accountLogin" : apiKeySource ? "apiKey" : "unknown";
    return {
      type: "session/configured",
      providerSessionId: asStr(msg.session_id),
      model: asStr(msg.model),
      authSource,
      ...(this.requestedAuth && { requestedAuth: this.requestedAuth }),
      cwd: asStr(msg.cwd),
    };
  }

  private ensureTurn(out: ThreadEvent[], uuid: string | null = null): string {
    if (this.turnId) return this.turnId;
    // An echo of something Lotus never sent (a hook's injected context) can open the turn; the
    // turn is still the one our oldest message starts, so it keeps that input and title.
    const next = this.takeInput(uuid) ?? (uuid ? this.takeInput(null) : null);
    this.turnId = this.newId();
    this.turnInputUuid = next?.uuid ?? null;
    out.push({ type: "turn/started", turnId: this.turnId, input: next?.input ?? null });
    return this.turnId;
  }

  // The input with this uuid, or the oldest one when there is no uuid.
  private takeInput(uuid: string | null): { uuid: string | null; input: TurnInput } | null {
    const index = uuid ? this.queuedInputs.findIndex((q) => q.uuid === uuid) : 0;
    return index < 0 ? null : (this.queuedInputs.splice(index, 1)[0] ?? null);
  }

  private inputTakenIn(uuid: string | null, out: ThreadEvent[]): void {
    if (!this.turnId) {
      this.ensureTurn(out, uuid);
      return;
    }
    if (uuid && uuid === this.turnInputUuid) return;
    const steer = this.takeInput(uuid);
    if (!steer) return;
    const { text, clientRequestId, attachments } = steer.input;
    out.push({
      type: "item/completed",
      turnId: this.turnId,
      item: { id: this.newId(), kind: "userMessage", status: "completed", text, clientRequestId, ...(attachments?.length && { attachments }) },
    });
  }

  private streamEvent(event: Obj | null, out: ThreadEvent[]): void {
    if (!event) return;
    const turnId = this.ensureTurn(out);
    switch (event.type) {
      case "message_start": {
        const id = asStr(asObj(event.message)?.id) ?? this.newId();
        this.currentMessageId = id;
        if (!this.blocksByMessage.has(id)) this.blocksByMessage.set(id, []);
        return;
      }
      case "content_block_start": {
        const index = asNum(event.index);
        const content = asObj(event.content_block);
        if (index === null || !content || !this.currentMessageId) return;
        const block = this.addBlock(this.currentMessageId, `${this.currentMessageId}:${index}`, index, content);
        if (block.type === "text" || block.type === "thinking") this.startText(turnId, block, out);
        return;
      }
      case "content_block_delta": {
        const block = this.streamingBlock(asNum(event.index));
        const delta = asObj(event.delta);
        if (!block || !delta || block.done) return;
        if (delta.type === "text_delta" || delta.type === "thinking_delta") {
          const text = asStr(delta.text) ?? asStr(delta.thinking) ?? "";
          if (!text) return;
          block.text += text;
          const open = this.openText.get(block.itemId);
          if (open) open.text += text;
          out.push({ type: "item/delta", turnId, itemId: block.itemId, delta: text });
        } else if (delta.type === "input_json_delta") {
          block.json += asStr(delta.partial_json) ?? "";
        }
        return;
      }
      case "content_block_stop": {
        const block = this.streamingBlock(asNum(event.index));
        if (block) this.finishBlock(turnId, block, null, out);
        return;
      }
      case "message_delta":
        // The main agent's last message; a sub-agent's end_turn only ends its own run.
        if (!this.parent && asObj(event.delta)?.stop_reason === "end_turn") out.push({ type: "turn/answered", turnId });
        return;
    }
  }

  private assistant(message: Obj | null, out: ThreadEvent[]): void {
    if (!message) return;
    const turnId = this.ensureTurn(out);
    const callUsage = asObj(message.usage);
    if (callUsage && !this.parent) this.lastCall = { tokens: promptTokens(callUsage), model: asStr(message.model) };
    const messageId = asStr(message.id) ?? this.newId();
    const blocks = this.blocksByMessage.get(messageId) ?? [];
    this.blocksByMessage.set(messageId, blocks);
    for (const raw of asArr(message.content)) {
      const content = asObj(raw);
      if (!content) continue;
      const type = asStr(content.type) ?? "unknown";
      const toolUseId = asStr(content.id);
      let block = blocks.find((b) =>
        type === "tool_use" ? b.toolUseId === toolUseId : b.type === type && !b.matched,
      );
      // No stream events for this block (partial messages off, or a replayed message).
      if (!block) {
        block = this.addBlock(messageId, `${messageId}:a${blocks.length}`, null, content);
        if (type === "text" || type === "thinking") this.startText(turnId, block, out);
      }
      block.matched = true;
      this.finishBlock(turnId, block, content, out);
    }
  }

  private addBlock(messageId: string, itemId: string, index: number | null, content: Obj): Block {
    const type = asStr(content.type) ?? "unknown";
    const block: Block = {
      itemId: type === "tool_use" ? (asStr(content.id) ?? itemId) : itemId,
      index,
      type,
      text: "",
      json: "",
      toolUseId: asStr(content.id),
      toolName: asStr(content.name),
      matched: false,
      done: false,
      parentId: this.parent,
    };
    this.blocksByMessage.get(messageId)?.push(block);
    return block;
  }

  private streamingBlock(index: number | null): Block | null {
    if (index === null || !this.currentMessageId) return null;
    return this.blocksByMessage.get(this.currentMessageId)?.find((b) => b.index === index) ?? null;
  }

  private startText(turnId: string, block: Block, out: ThreadEvent[]): void {
    const kind = block.type === "thinking" ? "reasoning" : "agentMessage";
    this.openText.set(block.itemId, { kind, text: "" });
    out.push({ type: "item/started", turnId, item: { id: block.itemId, kind, status: "running", text: "", ...under(block) } });
  }

  // `content` is the finished block from an `assistant` message; null means content_block_stop.
  private finishBlock(turnId: string, block: Block, content: Obj | null, out: ThreadEvent[]): void {
    if (block.done) return;
    if (block.type === "text" || block.type === "thinking") {
      const final = content ? (asStr(content.text) ?? asStr(content.thinking)) : null;
      const open = this.openText.get(block.itemId);
      const text = final ?? open?.text ?? block.text;
      this.openText.delete(block.itemId);
      block.done = true;
      const kind = block.type === "thinking" ? "reasoning" : "agentMessage";
      out.push({ type: "item/completed", turnId, item: { id: block.itemId, kind, status: "completed", text, ...under(block) } });
      return;
    }
    if (block.type === "tool_use") {
      const input = content ? content.input : parseJson(block.json);
      block.done = true;
      const item = { ...toolItem(block.itemId, block.toolName ?? "unknown", asObj(input) ?? {}), ...under(block) };
      this.runningTools.set(block.itemId, item);
      out.push({ type: "item/started", turnId, item });
    }
  }

  private toolResults(msg: Obj, out: ThreadEvent[]): void {
    const message = asObj(msg.message);
    const results = asArr(message?.content)
      .map(asObj)
      .filter((c): c is Obj => c?.type === "tool_result");
    if (results.length === 0) return; // plain user text, e.g. "[Request interrupted by user]"
    const turnId = this.ensureTurn(out);
    const structured = results.length === 1 ? msg.tool_use_result : undefined;
    for (const result of results) {
      const toolUseId = asStr(result.tool_use_id);
      const item = toolUseId ? this.runningTools.get(toolUseId) : undefined;
      if (!item || !toolUseId) continue;
      this.runningTools.delete(toolUseId);
      const status = this.declinedTools.has(toolUseId)
        ? "declined"
        : result.is_error === true
          ? "failed"
          : asObj(structured)?.interrupted === true
            ? "interrupted"
            : "completed";
      this.declinedTools.delete(toolUseId);
      const done = completeTool(item, status, contentText(result.content), structured);
      if (status === "completed" && asObj(structured)?.status === "async_launched") {
        // Still working: it stays running until its task_notification.
        this.backgroundAgents.set(toolUseId, { turnId, item: done });
        out.push({ type: "item/completed", turnId, item: { ...done, status: "running" } });
        continue;
      }
      out.push({ type: "item/completed", turnId, item: done });
    }
  }

  private backgroundAgentEnded(msg: Obj, out: ThreadEvent[]): void {
    const toolUseId = asStr(msg.tool_use_id);
    const agent = toolUseId ? this.backgroundAgents.get(toolUseId) : undefined;
    if (!agent || !toolUseId) return;
    this.backgroundAgents.delete(toolUseId);
    const ended = asStr(msg.status);
    const status = ended === "completed" ? "completed" : ended === "failed" ? "failed" : "interrupted";
    const item = agent.item.kind === "tool" ? { ...agent.item, output: asStr(msg.summary) ?? agent.item.output } : agent.item;
    out.push({ type: "item/completed", turnId: agent.turnId, item: { ...item, status } });
  }

  private result(msg: Obj, out: ThreadEvent[]): void {
    this.ensureTurn(out);
    const terminalReason = asStr(msg.terminal_reason) ?? "";
    const failed = msg.is_error === true || (asStr(msg.subtype) ?? "success") !== "success";
    let status: TurnStatus = "completed";
    let error: string | null = null;
    if (this.interruptRequested || terminalReason.startsWith("aborted")) {
      status = "interrupted";
    } else if (failed) {
      status = "failed";
      const errors = asArr(msg.errors).map(asStr).filter((e): e is string => !!e);
      error = errors.join("\n") || asStr(msg.result) || asStr(msg.subtype) || terminalReason || "turn failed";
    }
    this.completeTurn(out, status, error, usageOf(msg, this.lastCall));
  }

  private completeTurn(out: ThreadEvent[], status: TurnStatus, error: string | null, usage: TurnUsage | null): void {
    const turnId = this.turnId;
    if (!turnId) return;
    const leftover = status === "completed" ? "completed" : "interrupted";
    for (const [id, open] of this.openText) {
      out.push({ type: "item/completed", turnId, item: { id, kind: open.kind, status: leftover, text: open.text } });
    }
    for (const item of this.runningTools.values()) {
      out.push({ type: "item/completed", turnId, item: { ...item, status: "interrupted" } });
    }
    out.push({ type: "turn/completed", turnId, status, error, usage, forkPoint: status === "completed" ? this.forkPoint : null });
    this.forkPoint = null;
    this.turnId = null;
    this.interruptRequested = false;
    this.currentMessageId = null;
    this.lastCall = null;
    this.blocksByMessage.clear();
    this.openText.clear();
    this.runningTools.clear();
    this.declinedTools.clear();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Everything the model read for one call: fresh input plus cache writes and reads. */
function promptTokens(usage: Obj): number {
  return (asNum(usage.input_tokens) ?? 0) + (asNum(usage.cache_creation_input_tokens) ?? 0) + (asNum(usage.cache_read_input_tokens) ?? 0);
}

// `result.usage` sums every call in the turn (spend); the window gauge needs the last call alone,
// sized by `modelUsage[model].contextWindow` (fixtures: 1000000 on a 1M model).
function usageOf(msg: Obj, lastCall: { tokens: number; model: string | null } | null): TurnUsage | null {
  const usage = asObj(msg.usage);
  if (!usage) return null;
  const models = asObj(msg.modelUsage);
  const windowOf = (m: unknown) => asNum(asObj(m)?.contextWindow);
  const contextWindow =
    (lastCall?.model && models ? windowOf(models[lastCall.model]) : null) ??
    (models ? Math.max(0, ...Object.values(models).map((m) => windowOf(m) ?? 0)) || null : null);
  return {
    inputTokens: promptTokens(usage),
    outputTokens: asNum(usage.output_tokens) ?? 0,
    costUsd: asNum(msg.total_cost_usd),
    durationMs: asNum(msg.duration_ms),
    contextTokens: lastCall?.tokens ?? null,
    contextWindow,
  };
}

// AskUserQuestion's input, or null when it is not the shape the UI can offer as choices.
function readQuestions(input: unknown): Question[] | null {
  const raw = asObj(input)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: Question[] = [];
  for (const entry of raw) {
    const q = asObj(entry);
    const question = asStr(q?.question);
    if (!q || !question) return null;
    const options = asArr(q.options).flatMap((o) => {
      const label = asStr(asObj(o)?.label);
      return label ? [{ label, description: asStr(asObj(o)?.description) }] : [];
    });
    questions.push({ question, header: asStr(q.header) ?? "", options, multiSelect: q.multiSelect === true });
  }
  return questions;
}
