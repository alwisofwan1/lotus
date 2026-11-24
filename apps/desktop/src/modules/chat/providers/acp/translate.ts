// Translates an Agent Client Protocol session (`agy acp`, plans/chat-acp-runners/PLAN.md) into
// provider-neutral ThreadEvents. Runs inside the chat bridge, one translator per thread. Pure: the
// session feeds it every message, its own as `lotus/*` ones.
//
// What the stream looks like (./__fixtures__/agy-tool-turn.jsonl, recorded from agy 1.5.9):
// - ACP has no turn ids and no turn notifications: `session/prompt` is a request that stays open
//   for the whole turn and answers `{stopReason, usage}`. The session reports both ends as
//   `lotus/turnStarted` and `lotus/turnEnded`; the turn id is Lotus's own.
// - `session/update` carries `agent_message_chunk` / `agent_thought_chunk` text, and tools as
//   `tool_call` then `tool_call_update`s by `toolCallId`, each with the full `kind`, `title`,
//   `rawInput` and, once done, `rawOutput`.
// - Approvals are `session/request_permission` server requests with `allow_once` / `reject_once`
//   options; agy asked before `run_command` in mode "default", not before `read_file`.

import type { ThreadEvent, ThreadItem, TurnInput, TurnUsage } from "../../domain/thread-event";
import { asArr, asNum, asObj, asStr, type Obj } from "../claude/read-json";
import { hunksOf } from "../codex/translate";

/** What the session asks the host, in the shape the Claude path already uses. */
export interface AcpPermission {
  toolName: string;
  toolUseId: string | null;
  input: Record<string, unknown>;
  blockedPath: string | null;
  remember?: boolean;
}

const STATUS: Record<string, ThreadItem["status"]> = { pending: "running", in_progress: "running", completed: "completed", failed: "failed" };

// Cursor's ids hold a newline (memory: cursor-agent-acp-quirks); ids end up in line-oriented logs.
const itemId = (raw: unknown) => asStr(raw)?.replace(/\s+/g, "-") ?? null;

/** agy's `mcp_lotus-dev_lotus_chat_list` as Claude's `mcp__lotus-dev__lotus_chat_list`, which the timeline reads. */
export function toolName(name: string): string {
  const m = /^mcp_([^_]+)_(.+)$/.exec(name);
  return m ? `mcp__${m[1]}__${m[2]}` : name;
}

const pathOf = (call: Obj) => asStr(asObj(asArr(call.locations)[0])?.path) ?? asStr(asObj(call.rawInput)?.Path);

/** The tool's text output: agy's `rawOutput.output`, else the text blocks ACP's `content` holds. */
function outputOf(call: Obj): string | null {
  const raw = asObj(call.rawOutput);
  const text = asStr(raw?.output) ?? asStr(call.rawOutput);
  if (text !== null) return text;
  const parts = asArr(call.content)
    .map((c) => asStr(asObj(asObj(c)?.content)?.text))
    .filter((t): t is string => t !== null);
  return parts.length > 0 ? parts.join("\n") : null;
}

/** One Lotus item for an ACP tool call, by its `kind`. */
export function toolItem(call: Obj, id: string, status: ThreadItem["status"]): ThreadItem {
  const input = asObj(call.rawInput) ?? {};
  const title = asStr(call.title) ?? asStr(call.name) ?? "tool";
  const done = status !== "running";
  switch (asStr(call.kind)) {
    case "read": {
      const path = pathOf(call);
      if (path) return { id, status, kind: "fileRead", path, lineCount: null };
      break;
    }
    case "execute":
      return { id, status, kind: "command", command: asStr(input.CommandLine) ?? asStr(input.command) ?? title, description: asStr(input.toolSummary), output: done ? outputOf(call) : null };
    case "edit": {
      const path = pathOf(call);
      if (!path) break;
      const diff = asArr(call.content).map(asObj).find((c) => c?.type === "diff");
      const added = !!diff && (diff.oldText === null || diff.oldText === undefined);
      const patch = done && added && asStr(diff?.newText) !== null ? hunksOf(asStr(diff?.newText)!, true) : null;
      return { id, status, kind: "fileChange", path, change: added ? "create" : "edit", patch };
    }
    case "search":
      return { id, status, kind: "search", query: title, output: done ? outputOf(call) : null };
  }
  return { id, status, kind: "tool", name: toolName(asStr(call.name) ?? title), input: call.rawInput ?? null, output: done ? outputOf(call) : null };
}

interface OpenText {
  id: string;
  kind: "agentMessage" | "reasoning";
  text: string;
}

export class AcpTranslator {
  /** Kept for the bridge's shared wiring; the agent signs in with its own CLI login. */
  requestedAuth = null;
  private turnId: string | null = null;
  private readonly inputs = new Map<string, TurnInput>();
  private interruptRequested = false;
  private context: { used: number; size: number } | null = null;
  private text: OpenText | null = null;
  // Tool calls by id, merged across updates (ACP may send only what changed).
  private readonly tools = new Map<string, Obj>();
  private nextItem = 0;

  noteInput(input: TurnInput, uuid: string | null = null): void {
    if (uuid) this.inputs.set(uuid, input);
  }

  noteInterrupt(): void {
    this.interruptRequested = true;
  }

  /** The host's question for a `session/request_permission`. */
  permission(params: Obj): AcpPermission {
    const call = asObj(params.toolCall) ?? {};
    const input = asObj(call.rawInput) ?? {};
    const toolUseId = itemId(call.toolCallId);
    const remember = asArr(params.options).some((o) => asObj(o)?.kind === "allow_always");
    const base = { toolUseId, blockedPath: null, ...(remember && { remember: true }) };
    switch (asStr(call.kind)) {
      case "execute":
        return { ...base, toolName: "Bash", input: { command: asStr(input.CommandLine) ?? asStr(input.command) ?? asStr(call.title), description: asStr(input.toolSummary) } };
      case "edit":
        return { ...base, toolName: "Edit", input: { file_path: pathOf(call), description: asStr(call.title) } };
      // agy asks before reading outside the workspace.
      case "read":
        return { ...base, toolName: "Read", input: { file_path: pathOf(call) } };
      default:
        return { ...base, toolName: toolName(asStr(call.name) ?? asStr(call.title) ?? "tool"), input };
    }
  }

  interactionRequested(interactionId: string, notice: AcpPermission): ThreadEvent[] {
    return [
      {
        type: "interaction/requested",
        turnId: this.turnId,
        interaction: { id: interactionId, kind: "toolPermission", itemId: notice.toolUseId, toolName: notice.toolName, input: notice.input, blockedPath: notice.blockedPath, ...(notice.remember && { remember: true }) },
      },
    ];
  }

  interactionResolved(interactionId: string, decision: { behavior: "allow" | "deny"; message?: string }): ThreadEvent[] {
    return [
      {
        type: "interaction/resolved",
        interactionId,
        decision: decision.behavior === "allow" ? "allowed" : "denied",
        message: decision.behavior === "deny" ? (decision.message ?? null) : null,
        answers: null,
      },
    ];
  }

  translate(message: unknown): ThreadEvent[] {
    const msg = asObj(message);
    const params = asObj(msg?.params) ?? {};
    switch (asStr(msg?.method)) {
      case "lotus/configured":
        return [{ type: "session/configured", providerSessionId: asStr(params.sessionId), model: asStr(params.model), authSource: "accountLogin", cwd: asStr(params.cwd) }];
      case "lotus/turnStarted": {
        const uuid = asStr(params.uuid) ?? String(++this.nextItem);
        this.turnId = `turn-${uuid}`;
        this.interruptRequested = false;
        const input = this.inputs.get(uuid) ?? null;
        this.inputs.delete(uuid);
        return [{ type: "turn/started", turnId: this.turnId, input }];
      }
      case "lotus/turnEnded":
        return this.turnEnded(params);
      case "session/update":
        return this.update(asObj(params.update) ?? {});
      default:
        return [];
    }
  }

  end(error: string | null): ThreadEvent[] {
    return [...this.turnEnded({ error }), { type: "session/ended", error }];
  }

  private update(u: Obj): ThreadEvent[] {
    if (!this.turnId) return [];
    switch (asStr(u.sessionUpdate)) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const delta = asStr(asObj(u.content)?.text);
        return delta ? this.write(u.sessionUpdate === "agent_message_chunk" ? "agentMessage" : "reasoning", delta) : [];
      }
      case "tool_call":
      case "tool_call_update": {
        const id = itemId(u.toolCallId);
        if (!id) return [];
        const out = this.closeText("completed");
        const known = this.tools.get(id);
        const call = { ...known, ...u };
        const status = STATUS[asStr(call.status) ?? ""] ?? "running";
        if (status === "running") {
          this.tools.set(id, call);
          // An update that only moves pending → in_progress is not news to the timeline.
          if (!known) out.push({ type: "item/started", turnId: this.turnId, item: toolItem(call, id, status) });
        } else {
          this.tools.delete(id);
          out.push({ type: "item/completed", turnId: this.turnId, item: toolItem(call, id, status) });
        }
        return out;
      }
      case "usage_update": {
        const used = asNum(u.used);
        const size = asNum(u.size);
        if (used !== null && size !== null) this.context = { used, size };
        return [];
      }
      default:
        // user_message_chunk (the input, shown from what Lotus sent), plan, commands, config, title.
        return [];
    }
  }

  private turnEnded(params: Obj): ThreadEvent[] {
    if (!this.turnId) return [];
    const error = asStr(params.error);
    const stop = asStr(params.stopReason);
    const status = error ? "failed" : this.interruptRequested || stop === "cancelled" ? "interrupted" : "completed";
    const itemStatus = status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted";
    const out = this.closeText(itemStatus);
    for (const [id, call] of this.tools) out.push({ type: "item/completed", turnId: this.turnId, item: toolItem(call, id, itemStatus === "completed" ? "interrupted" : itemStatus) });
    this.tools.clear();
    const u = asObj(params.usage);
    const usage: TurnUsage | null = u
      ? {
          inputTokens: asNum(u.inputTokens) ?? 0,
          outputTokens: asNum(u.outputTokens) ?? 0,
          costUsd: null,
          durationMs: asNum(params.durationMs),
          contextTokens: this.context?.used ?? null,
          contextWindow: this.context?.size ?? null,
        }
      : null;
    // No fork point: ACP cannot branch a session at a turn.
    out.push({ type: "turn/completed", turnId: this.turnId, status, error, usage, forkPoint: null });
    this.turnId = null;
    this.interruptRequested = false;
    return out;
  }

  private write(kind: OpenText["kind"], delta: string): ThreadEvent[] {
    const out: ThreadEvent[] = [];
    if (this.text?.kind !== kind) {
      out.push(...this.closeText("completed"));
      this.nextItem += 1;
      this.text = { id: `${this.turnId}-${kind}-${this.nextItem}`, kind, text: "" };
      out.push({ type: "item/started", turnId: this.turnId!, item: { id: this.text.id, kind, status: "running", text: "" } });
    }
    this.text!.text += delta;
    out.push({ type: "item/delta", turnId: this.turnId!, itemId: this.text!.id, delta });
    return out;
  }

  private closeText(status: ThreadItem["status"]): ThreadEvent[] {
    const open = this.text;
    if (!open || !this.turnId) return [];
    this.text = null;
    return [{ type: "item/completed", turnId: this.turnId, item: { id: open.id, kind: open.kind, status, text: open.text } }];
  }
}
