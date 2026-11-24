// Translates `codex app-server` notifications into provider-neutral ThreadEvents (#286). Runs
// inside the chat bridge, one translator per thread. Pure: the session feeds it every message.
//
// What the app-server stream looks like (see ./__fixtures__, recorded from codex-cli 0.164.0):
// - `turn/started` → `item/started` / `item/completed` per item → `turn/completed` {turn.status}.
//   Items carry their own ids; agent text streams as `item/agentMessage/delta`.
// - The user's message comes back as a `userMessage` item; the turn's input is known from what
//   Lotus sent, so it is not shown twice. The session reports its own sends as `lotus/*` messages.
// - One `fileChange` item holds every file of one patch; each becomes one Lotus item.
// - Approvals are server requests (`item/commandExecution/requestApproval`,
//   `item/fileChange/requestApproval`), answered with `accept` / `decline`.
// - No `turn/plan/updated` arrived in three recordings, even with `experimentalApi`: the agent
//   says its `update_plan` tool is not available, so a plan is plain text for now.

import type { AuthSource, PatchHunk, ThreadEvent, ThreadItem, TurnInput, TurnStatus, TurnUsage } from "../../domain/thread-event";
import { asArr, asNum, asObj, asStr, type Obj } from "../claude/read-json";

/** What the session asks the host, in the shape the Claude path already uses. */
export interface CodexPermission {
  toolName: string;
  toolUseId: string | null;
  input: Record<string, unknown>;
  blockedPath: string | null;
  /** Codex can keep an Allow for the rest of the session. */
  remember?: boolean;
}

const ITEM_STATUS: Record<string, ThreadItem["status"]> = {
  inProgress: "running",
  completed: "completed",
  failed: "failed",
  declined: "declined",
};

const TURN_STATUS: Record<string, TurnStatus> = { completed: "completed", interrupted: "interrupted", failed: "failed" };

/** "/bin/zsh -lc 'ls -1A'" → "ls -1A": what the agent asked to run, without the shell it runs in. */
export function shownCommand(item: Obj): string {
  const actions = asArr(item.commandActions).map(asObj);
  if (actions.length === 1 && asStr(actions[0]?.command)) return asStr(actions[0]?.command)!;
  const command = asStr(item.command) ?? "";
  const m = /^\S*\/(?:ba|z)?sh -l?c ([\s\S]*)$/.exec(command);
  if (!m) return command;
  const inner = m[1];
  return /^'[\s\S]*'$/.test(inner) ? inner.slice(1, -1).replace(/'\\''/g, "'") : /^"[\s\S]*"$/.test(inner) ? inner.slice(1, -1).replace(/\\"/g, '"') : inner;
}

/** A unified diff's hunks; a new file's diff is its plain content. */
export function hunksOf(diff: string, added: boolean): PatchHunk[] | null {
  const lines = diff.replace(/\n$/, "").split("\n");
  if (added) return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
  const hunks: PatchHunk[] = [];
  for (const line of lines) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (head) {
      hunks.push({ oldStart: +head[1], oldLines: +(head[2] ?? 1), newStart: +head[3], newLines: +(head[4] ?? 1), lines: [] });
    } else if (hunks.length > 0 && /^[ +-]/.test(line)) {
      hunks.at(-1)!.lines.push(line);
    }
  }
  return hunks.length > 0 ? hunks : null;
}

export class CodexTranslator {
  /** Kept for the bridge's shared wiring; Codex reports its own sign-in. */
  requestedAuth: AuthSource | null = null;
  private turnId: string | null = null;
  private readonly inputs = new Map<string, TurnInput>();
  // The input the next `turn/started` opens with: what the session last sent as a new turn.
  private nextTurnInput: TurnInput | null = null;
  private interruptRequested = false;
  private usage: TurnUsage | null = null;
  /** The thread's running total just before this turn's first call: `total` minus that call's `last`. */
  private turnBase: { input: number; output: number } | null = null;
  private readonly fileChanges = new Map<string, Obj[]>();
  // Started and not yet completed; a turn that ends closes them.
  private readonly open = new Map<string, ThreadItem>();

  noteInput(input: TurnInput, uuid: string | null = null): void {
    if (uuid) this.inputs.set(uuid, input);
  }

  noteInterrupt(): void {
    this.interruptRequested = true;
  }

  /** The host's question for an approval request; null for one Lotus does not ask about. */
  permission(method: string, params: Obj): CodexPermission | null {
    const itemId = asStr(params.itemId);
    if (method === "item/commandExecution/requestApproval") {
      return {
        toolName: "Bash",
        toolUseId: itemId,
        input: { command: shownCommand(params), description: asStr(params.reason) },
        blockedPath: null,
      };
    }
    if (method === "item/fileChange/requestApproval") {
      const changes = (itemId && this.fileChanges.get(itemId)) || [];
      const first = changes[0];
      return {
        toolName: asObj(first?.kind)?.type === "add" ? "Write" : "Edit",
        toolUseId: itemId,
        input: {
          file_path: asStr(first?.path),
          diff: asStr(first?.diff),
          added: asObj(first?.kind)?.type === "add",
          files: changes.map((c) => asStr(c.path)).filter(Boolean),
          description: asStr(params.reason),
        },
        blockedPath: asStr(params.grantRoot),
      };
    }
    // An MCP tool call under "ask": Codex asks with a form-less elicitation. Named like Claude's
    // tools so both agents' cards read the same.
    const meta = asObj(params._meta);
    if (method === "mcpServer/elicitation/request" && meta?.codex_approval_kind === "mcp_tool_call") {
      const tool = /run tool "([^"]+)"/.exec(asStr(params.message) ?? "")?.[1] ?? "tool";
      return {
        toolName: `mcp__${asStr(params.serverName) ?? "mcp"}__${tool}`,
        toolUseId: null,
        input: asObj(meta.tool_params) ?? {},
        blockedPath: null,
        remember: asArr(meta.persist).includes("session"),
      };
    }
    return null;
  }

  interactionRequested(interactionId: string, notice: CodexPermission): ThreadEvent[] {
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
    const method = asStr(msg?.method);
    const params = asObj(msg?.params) ?? {};
    switch (method) {
      case "lotus/configured":
        return [this.configured(params)];
      case "lotus/turnSent": {
        this.nextTurnInput = this.inputs.get(asStr(params.uuid) ?? "") ?? null;
        return [];
      }
      case "lotus/steered": {
        const input = this.inputs.get(asStr(params.uuid) ?? "");
        if (!input || !this.turnId) return [];
        const item: ThreadItem = { id: `steer-${asStr(params.uuid)}`, status: "completed", kind: "userMessage", ...input };
        return [{ type: "item/completed", turnId: this.turnId, item }];
      }
      case "turn/started": {
        const turnId = asStr(asObj(params.turn)?.id);
        if (!turnId) return [];
        this.turnId = turnId;
        this.usage = null;
        this.turnBase = null;
        const input = this.nextTurnInput;
        this.nextTurnInput = null;
        return [{ type: "turn/started", turnId, input }];
      }
      case "item/started":
      case "item/completed":
        return this.item(method, params);
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta": {
        const itemId = asStr(params.itemId);
        const delta = asStr(params.delta);
        return this.turnId && itemId && delta ? [{ type: "item/delta", turnId: this.turnId, itemId, delta }] : [];
      }
      case "thread/tokenUsage/updated": {
        const tokenUsage = asObj(params.tokenUsage);
        const last = asObj(tokenUsage?.last);
        const total = asObj(tokenUsage?.total) ?? last;
        // `last.totalTokens` against `modelContextWindow` is the fill Codex's own TUI reports.
        // Spend is the turn's share of `total`, which also counts earlier turns; `last` is one call.
        if (last && total) {
          const n = (o: Obj, k: string) => asNum(o[k]) ?? 0;
          this.turnBase ??= { input: n(total, "inputTokens") - n(last, "inputTokens"), output: n(total, "outputTokens") - n(last, "outputTokens") };
          this.usage = {
            inputTokens: n(total, "inputTokens") - this.turnBase.input,
            outputTokens: n(total, "outputTokens") - this.turnBase.output,
            costUsd: null,
            durationMs: null,
            contextTokens: asNum(last.totalTokens),
            contextWindow: asNum(tokenUsage?.modelContextWindow),
          };
        }
        return [];
      }
      case "turn/completed": {
        const turn = asObj(params.turn) ?? {};
        if (!this.turnId) return [];
        const out: ThreadEvent[] = [];
        let status = TURN_STATUS[asStr(turn.status) ?? ""] ?? "completed";
        if (this.interruptRequested && status === "completed") status = "interrupted";
        const usage = this.usage ? { ...this.usage, durationMs: asNum(turn.durationMs) } : null;
        this.complete(out, status, asStr(asObj(turn.error)?.message), usage);
        return out;
      }
      default:
        return [];
    }
  }

  end(error: string | null): ThreadEvent[] {
    const out: ThreadEvent[] = [];
    if (this.turnId) this.complete(out, error ? "failed" : "interrupted", error, null);
    out.push({ type: "session/ended", error });
    return out;
  }

  private complete(out: ThreadEvent[], status: TurnStatus, error: string | null, usage: TurnUsage | null): void {
    const itemStatus = status === "failed" ? "failed" : "interrupted";
    for (const item of this.open.values()) out.push({ type: "item/completed", turnId: this.turnId!, item: { ...item, status: itemStatus } });
    this.open.clear();
    out.push({ type: "turn/completed", turnId: this.turnId!, status, error, usage, forkPoint: status === "completed" ? this.turnId : null });
    this.turnId = null;
    this.interruptRequested = false;
  }

  private configured(params: Obj): ThreadEvent {
    const account = asStr(asObj(params.account)?.type);
    return {
      type: "session/configured",
      providerSessionId: asStr(params.threadId),
      model: asStr(params.model),
      authSource: account === "chatgpt" ? "accountLogin" : account === "apiKey" ? "apiKey" : "unknown",
      cwd: asStr(params.cwd),
    };
  }

  private item(method: "item/started" | "item/completed", params: Obj): ThreadEvent[] {
    const raw = asObj(params.item);
    const turnId = asStr(params.turnId) ?? this.turnId;
    const id = asStr(raw?.id);
    if (!raw || !id || !turnId) return [];
    const done = method === "item/completed";
    const status = done ? (ITEM_STATUS[asStr(raw.status) ?? ""] ?? "completed") : "running";
    const items = this.items(raw, id, status, done);
    for (const item of items) {
      if (done) this.open.delete(item.id);
      else this.open.set(item.id, item);
    }
    const out: ThreadEvent[] = items.map((item) => ({ type: method, turnId, item }));
    // The closing reply is in; Stop hooks may still hold turn/completed back.
    if (done && raw.type === "agentMessage" && raw.phase === "final_answer" && turnId === this.turnId) out.push({ type: "turn/answered", turnId });
    return out;
  }

  private items(raw: Obj, id: string, status: ThreadItem["status"], done: boolean): ThreadItem[] {
    switch (asStr(raw.type)) {
      case "agentMessage":
        return [{ id, status, kind: "agentMessage", text: asStr(raw.text) ?? "" }];
      case "reasoning":
        return [{ id, status, kind: "reasoning", text: asArr(raw.summary).map(asStr).filter(Boolean).join("\n\n") }];
      case "commandExecution": {
        const actions = asArr(raw.commandActions).map(asObj);
        const read = actions.length === 1 && actions[0]?.type === "read" ? asStr(actions[0].path) : null;
        if (read) return [{ id, status, kind: "fileRead", path: read, lineCount: null }];
        return [{ id, status, kind: "command", command: shownCommand(raw), description: null, output: asStr(raw.aggregatedOutput) }];
      }
      case "fileChange": {
        const changes = asArr(raw.changes).map(asObj).filter((c): c is Obj => c !== null);
        this.fileChanges.set(id, changes);
        if (done) this.fileChanges.delete(id);
        return changes.map((change, i) => {
          const added = asObj(change.kind)?.type === "add";
          const diff = asStr(change.diff);
          return {
            id: `${id}:${i}`,
            status,
            kind: "fileChange",
            path: asStr(change.path) ?? "",
            change: added ? "create" : "edit",
            patch: status === "completed" && diff ? hunksOf(diff, added) : null,
          };
        });
      }
      case "webSearch":
        return [{ id, status, kind: "search", query: asStr(raw.query) ?? "", output: null }];
      case "mcpToolCall":
        return [{ id, status, kind: "tool", name: `${asStr(raw.server) ?? "mcp"} · ${asStr(raw.tool) ?? "tool"}`, input: raw.arguments ?? null, output: done ? JSON.stringify(raw.result ?? raw.error ?? null) : null }];
      case "dynamicToolCall":
        return [{ id, status, kind: "tool", name: asStr(raw.tool) ?? "tool", input: raw.arguments ?? null, output: null }];
      default:
        // userMessage (the input, shown from what Lotus sent), hooks, compaction, review mode: not timeline items.
        return [];
    }
  }
}

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Lotus's four modes as Codex's sandbox × approval policy. */
export function codexPolicy(mode: PermissionMode): { sandbox: string; approvalPolicy: string } {
  switch (mode) {
    case "plan":
      return { sandbox: "read-only", approvalPolicy: "on-request" };
    case "acceptEdits":
      return { sandbox: "workspace-write", approvalPolicy: "on-request" };
    case "bypassPermissions":
      return { sandbox: "danger-full-access", approvalPolicy: "never" };
    default:
      return { sandbox: "workspace-write", approvalPolicy: "untrusted" };
  }
}
