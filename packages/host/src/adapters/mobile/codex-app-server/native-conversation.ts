import type {
  ConversationPage,
  ConversationUpdate,
  Part,
  PermissionPart,
  Turn,
} from "../../../types/conversation.js";
import { runnerTranscriptCaps } from "../conversation/runner-caps.js";
import { type CodexItem, partFromItem, patchPart } from "./native-items.js";

/**
 * A Codex `app-server` thread as a live [`ConversationPage`] — the first **native**
 * producer of parts (`provenance: "native"`). Ids are Codex's own, so the phone can dedupe on
 * them across REST and the stream; `seq` counts arrivals.
 */
export type { ConversationUpdate };

export class NativeConversation {
  private readonly turns: Turn[] = [];
  private readonly listeners: Array<(u: ConversationUpdate) => void> = [];
  private seq = 0;
  private usage: { input?: number; output?: number; cachedRead?: number; cachedWrite?: number } | undefined;

  constructor(readonly paneId: string) {}

  onUpdate(listener: (u: ConversationUpdate) => void): void {
    this.listeners.push(listener);
  }

  page(): ConversationPage {
    return {
      paneId: this.paneId,
      runner: "codex",
      capabilities: {
        ...runnerTranscriptCaps("codex"),
        streaming: "expected",
        toolStatus: "expected",
        output: "expected",
        permission: "expected",
        reasoning: "partial",
        usage: "expected",
      },
      source: "file",
      turns: this.turns.map((t) => ({ ...t, parts: [...t.parts] })),
      hasMore: false,
      totalEver: this.turns.reduce((n, t) => n + t.parts.length, 0),
    };
  }

  /** The permission still waiting for an answer, if any — what `/permission` reports. */
  pendingPermission(): PermissionPart | undefined {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i];
      if (turn === undefined) continue;
      for (let j = turn.parts.length - 1; j >= 0; j--) {
        const p = turn.parts[j];
        if (p?.type === "permission" && p.outcome === undefined) return p;
      }
    }
    return undefined;
  }

  apply(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    const turnId = typeof p["turnId"] === "string" ? p["turnId"] : undefined;
    switch (method) {
      case "turn/started": {
        const turn = p["turn"] as { id: string; startedAt?: number | null } | undefined;
        if (turn === undefined) return;
        this.openTurn(turn.id, secondsToMs(turn.startedAt) ?? Date.now());
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = p["item"] as CodexItem | undefined;
        if (item === undefined || turnId === undefined) return;
        const at = (p["completedAtMs"] ?? p["startedAtMs"]) as number | undefined;
        const part = partFromItem(item, at ?? Date.now(), this.seq++, this.existing(turnId, item.id));
        if (part !== undefined) this.upsert(turnId, part);
        return;
      }
      case "item/agentMessage/delta":
      case "item/commandExecution/outputDelta": {
        const itemId = p["itemId"] as string | undefined;
        if (turnId === undefined || itemId === undefined) return;
        const existing = this.existing(turnId, itemId);
        const patched = patchPart(existing, method, p["delta"], this.seq++, itemId);
        if (patched !== undefined) this.upsert(turnId, patched);
        return;
      }
      case "thread/tokenUsage/updated": {
        const total = (p["tokenUsage"] as { total?: Record<string, number> } | undefined)?.total;
        if (total === undefined) return;
        const usage: NonNullable<typeof this.usage> = {};
        if (typeof total["inputTokens"] === "number") usage.input = total["inputTokens"];
        if (typeof total["outputTokens"] === "number") usage.output = total["outputTokens"];
        if (typeof total["cachedInputTokens"] === "number") usage.cachedRead = total["cachedInputTokens"];
        if (typeof total["cacheWriteInputTokens"] === "number") usage.cachedWrite = total["cacheWriteInputTokens"];
        this.usage = usage;
        return;
      }
      case "turn/completed": {
        const turn = p["turn"] as { id: string; status: string; completedAt?: number | null; durationMs?: number | null; error?: { message?: string } | null } | undefined;
        if (turn === undefined) return;
        this.closeTurn(turn);
        return;
      }
      default:
    }
  }

  /**
   * A server request for approval, as a `permission` part. Options are the decisions the
   * schema offers (`CommandExecutionApprovalDecision`), keyed `1`–`3` because the phone
   * answers by the printed digit (ADR-8). Returns the part so the session can wait on it.
   */
  requestApproval(method: string, params: unknown, requestId: string): PermissionPart | undefined {
    const p = (params ?? {}) as Record<string, unknown>;
    const turnId = p["turnId"] as string | undefined;
    if (turnId === undefined) return undefined;
    const isFile = method === "item/fileChange/requestApproval";
    const command = typeof p["command"] === "string" ? p["command"] : undefined;
    const reason = typeof p["reason"] === "string" ? p["reason"] : undefined;
    const part: PermissionPart = {
      id: `perm-${requestId}`, ts: Date.now(), seq: this.seq++, provenance: "native",
      type: "permission", requestId,
      ...(typeof p["itemId"] === "string" ? { toolCallId: p["itemId"] } : {}),
      title: isFile ? `Allow file changes${reason ? ` — ${reason}` : ""}` : `Run ${command ?? "this command"}?`,
      options: [
        { key: "1", label: "Allow once", kind: "allow_once" },
        { key: "2", label: "Allow for this session", kind: "allow_always" },
        { key: "3", label: "Decline", kind: "reject_once" },
      ],
    };
    this.upsert(turnId, part);
    return part;
  }

  /** Records the operator's answer on the pending permission; returns Codex's decision word. */
  decide(requestId: string, key: string): "accept" | "acceptForSession" | "decline" | undefined {
    const decision = ({ "1": "accept", "2": "acceptForSession", "3": "decline" } as const)[key];
    if (decision === undefined) return undefined;
    for (const turn of this.turns) {
      const i = turn.parts.findIndex((q) => q.type === "permission" && q.requestId === requestId);
      const part = turn.parts[i];
      if (i < 0 || part?.type !== "permission") continue;
      this.upsert(turn.turnId, { ...part, seq: this.seq++, outcome: { selected: key } });
      return decision;
    }
    return undefined;
  }

  private openTurn(turnId: string, startedAt: number): void {
    if (this.turns.some((t) => t.turnId === turnId)) return;
    const turn: Turn = { turnId, startedAt, parts: [] };
    this.turns.push(turn);
    this.emit({ kind: "turn", turn: { turnId, startedAt } });
  }

  private closeTurn(turn: { id: string; status: string; completedAt?: number | null; durationMs?: number | null; error?: { message?: string } | null }): void {
    const held = this.turns.find((t) => t.turnId === turn.id);
    if (held === undefined) return;
    held.endedAt = secondsToMs(turn.completedAt) ?? Date.now();
    held.stopReason = turn.status === "completed" ? "end_turn" : turn.status === "interrupted" ? "cancelled" : "error";
    const result: Part = {
      id: `result-${turn.id}`, ts: held.endedAt, seq: this.seq++, provenance: "native",
      type: "result", isError: turn.status === "failed",
      ...(typeof turn.durationMs === "number" ? { durationMs: turn.durationMs } : {}),
      ...(this.usage === undefined ? {} : { usage: this.usage }),
    };
    this.upsert(turn.id, result);
    if (turn.error?.message) {
      this.upsert(turn.id, { id: `error-${turn.id}`, ts: held.endedAt, seq: this.seq++, provenance: "native", type: "error", message: turn.error.message, recoverable: false });
    }
    this.emit({ kind: "turn", turn: { turnId: held.turnId, startedAt: held.startedAt, endedAt: held.endedAt, stopReason: held.stopReason } });
  }

  private existing(turnId: string, id: string): Part | undefined {
    return this.turns.find((t) => t.turnId === turnId)?.parts.find((q) => q.id === id);
  }

  private upsert(turnId: string, part: Part): void {
    let turn = this.turns.find((t) => t.turnId === turnId);
    if (turn === undefined) {
      // An item for a turn we never saw open — a reconnect mid-turn. Open it rather than
      // drop the part; the start time is the best we have.
      this.openTurn(turnId, part.ts);
      turn = this.turns.find((t) => t.turnId === turnId);
      if (turn === undefined) return;
    }
    const i = turn.parts.findIndex((q) => q.id === part.id);
    if (i >= 0) turn.parts[i] = part;
    else turn.parts.push(part);
    this.emit({ kind: "part", turnId, part });
  }

  private emit(update: ConversationUpdate): void {
    for (const l of this.listeners) l(update);
  }
}

/** Codex stamps turn times in seconds and item times in milliseconds. */
function secondsToMs(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value * 1000 : undefined;
}
