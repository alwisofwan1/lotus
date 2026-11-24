import type { FileDiff, Part, ToolCallPart } from "../../../types/conversation.js";

/**
 * One `ThreadItem` from `codex app-server` → one [`Part`]. Shapes are from the generated
 * schema (`codex app-server generate-json-schema`, 0.150.1) and the live capture in
 * `__tests__/fixtures/app-server-turn.jsonl`.
 */
export interface CodexItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

const STATUS: Record<string, ToolCallPart["status"]> = {
  inProgress: "in_progress",
  completed: "completed",
  failed: "failed",
  // Declined by the operator: the call did not run. `cancelled` is the ACP word for that.
  declined: "cancelled",
};

export function partFromItem(item: CodexItem, at: number, seq: number, existing: Part | undefined): Part | undefined {
  const base = { id: item.id, ts: existing?.ts ?? at, seq, provenance: "native" as const };
  switch (item.type) {
    case "userMessage": {
      const content = item["content"] as Array<{ type?: string; text?: string }> | undefined;
      const text = (content ?? []).map((c) => c.text ?? "").join("\n");
      return { ...base, type: "user_message", text };
    }
    case "agentMessage": {
      // `item/started` carries `text: ""` and the deltas fill it; `item/completed` carries
      // the whole text. Between the two, keep whatever the deltas have accumulated.
      const text = typeof item["text"] === "string" && item["text"] !== ""
        ? item["text"]
        : existing?.type === "assistant_text" ? existing.text : "";
      const done = typeof item["text"] === "string" && item["text"] !== "";
      return { ...base, type: "assistant_text", text, state: done ? "done" : "streaming", truncated: false };
    }
    case "reasoning": {
      const summary = item["summary"] as string[] | undefined;
      const content = item["content"] as string[] | undefined;
      const text = (summary?.length ? summary : content ?? []).join("\n");
      if (text === "") return undefined;
      return { ...base, type: "reasoning", text, redacted: false };
    }
    case "commandExecution": {
      const actions = item["commandActions"] as Array<{ command?: string }> | undefined;
      const title = actions?.[0]?.command ?? (item["command"] as string | undefined) ?? "";
      const output = item["aggregatedOutput"] as string | null | undefined;
      const exitCode = item["exitCode"] as number | null | undefined;
      const part: ToolCallPart = {
        ...base, type: "tool_call", toolCallId: item.id, toolName: "exec", title, kind: "execute",
        status: STATUS[item["status"] as string] ?? "in_progress", locations: [],
      };
      if (typeof output === "string" || typeof exitCode === "number") {
        part.output = { text: output ?? "", truncated: false, ...(typeof exitCode === "number" ? { exitCode } : {}) };
      }
      return part;
    }
    case "fileChange": {
      const changes = item["changes"] as Record<string, { kind?: string; type?: string; unified_diff?: string; unifiedDiff?: string }> | Array<{ path: string; kind?: string; type?: string; unified_diff?: string; unifiedDiff?: string }> | undefined;
      const files: FileDiff[] = [];
      const entries: Array<[string, { kind?: string; type?: string; unified_diff?: string; unifiedDiff?: string }]> =
        Array.isArray(changes) ? changes.map((c) => [c.path, c]) : Object.entries(changes ?? {});
      for (const [path, change] of entries) {
        const diff = change.unified_diff ?? change.unifiedDiff;
        const op = opOf(change.kind ?? change.type);
        files.push(diff === undefined ? { path, op } : { path, op, ...diffStat(diff) });
      }
      return {
        ...base, type: "tool_call", toolCallId: item.id, toolName: "apply_patch",
        title: files.map((f) => f.path.split("/").pop() ?? f.path).join(", "), kind: "edit",
        status: STATUS[item["status"] as string] ?? "in_progress",
        locations: files.map((f) => ({ path: f.path })), diff: { files },
      };
    }
    case "mcpToolCall": {
      const title = `${item["server"] ?? ""}.${item["tool"] ?? ""}`.replace(/^\./, "");
      const error = item["error"] as { message?: string } | string | null | undefined;
      return {
        ...base, type: "tool_call", toolCallId: item.id, toolName: (item["tool"] as string) ?? "mcp", title, kind: "other",
        status: STATUS[item["status"] as string] ?? "in_progress", locations: [],
        ...(error ? { output: { text: typeof error === "string" ? error : error.message ?? "", truncated: false } } : {}),
      };
    }
    case "webSearch":
      return { ...base, type: "tool_call", toolCallId: item.id, toolName: "web.search", title: (item["query"] as string) ?? "", kind: "fetch", status: "completed", locations: [] };
    case "contextCompaction":
      return { ...base, type: "status", state: "compacted" };
    case "plan":
      return { ...base, type: "plan_update", entries: [{ content: (item["text"] as string) ?? "", priority: "medium", status: "in_progress" }] };
    default:
      return { ...base, type: "unknown", rawType: item.type, summary: "" };
  }
}

/** Appends a delta to the part it belongs to. `agentMessage/delta.delta` is a plain string. */
export function patchPart(existing: Part | undefined, method: string, delta: unknown, seq: number, itemId: string): Part | undefined {
  if (method === "item/agentMessage/delta") {
    const text = typeof delta === "string" ? delta : "";
    if (existing?.type === "assistant_text") return { ...existing, seq, text: existing.text + text };
    return { id: itemId, ts: Date.now(), seq, provenance: "native", type: "assistant_text", text, state: "streaming", truncated: false };
  }
  if (method === "item/commandExecution/outputDelta" && existing?.type === "tool_call") {
    const chunk = typeof delta === "string" ? delta : (delta as { text?: string } | undefined)?.text ?? "";
    return { ...existing, seq, output: { text: (existing.output?.text ?? "") + chunk, truncated: false, ...(existing.output?.exitCode === undefined ? {} : { exitCode: existing.output.exitCode }) } };
  }
  return undefined;
}

function opOf(kind: string | undefined): FileDiff["op"] {
  switch (kind) {
    case "add": return "add";
    case "delete": return "delete";
    default: return "modify";
  }
}

function diffStat(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}
