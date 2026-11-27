import type {
  FileDiff,
  PermissionOption,
  PlanEntry,
  StopReason,
  ToolCallPart,
  ToolKind,
  ToolStatus,
} from "../../../../../types/conversation.js";
import { diffStat } from "./diffstat.js";

/**
 * ACP `session/update` payloads (fixture `__tests__/fixtures/cursor-acp-turn.jsonl`). `unknown`
 * in, typed out: an unreadable shape becomes an `unknown` part, never a thrown parse.
 */
export interface AcpUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

const TOOL_KINDS: ReadonlySet<string> = new Set<ToolKind>([
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other",
]);
const TOOL_STATUSES: ReadonlySet<string> = new Set<ToolStatus>([
  "pending", "in_progress", "completed", "failed", "cancelled",
]);

/**
 * `toolCallId` arrives with a literal newline in it — `call-<uuid>-0\nfc_<hex>_0` in every
 * capture. It reaches log lines, `Part.id`, and the phone's dedupe key, all of which read a
 * line at a time, so it is folded to a space here and never seen raw above this file.
 */
export function normalizeToolCallId(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!isRecord(content)) return "";
  return typeof content["text"] === "string" ? content["text"] : "";
}

export function toolKind(raw: unknown): ToolKind {
  return typeof raw === "string" && TOOL_KINDS.has(raw) ? (raw as ToolKind) : "other";
}

export function toolStatus(raw: unknown, fallback: ToolStatus): ToolStatus {
  return typeof raw === "string" && TOOL_STATUSES.has(raw) ? (raw as ToolStatus) : fallback;
}

export function locationsOf(raw: unknown): ToolCallPart["locations"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry["path"] !== "string") return [];
    const line = entry["line"];
    return [{ path: entry["path"], ...(typeof line === "number" ? { line } : {}) }];
  });
}

/**
 * The `diff` blocks in a tool call's `content`, counted.
 *
 * `op` is read from which side is empty: a created file is `add`, a truncated one `delete`.
 */
export function diffOf(raw: unknown): { files: FileDiff[] } | undefined {
  if (!Array.isArray(raw)) return undefined;
  const files: FileDiff[] = [];
  for (const block of raw) {
    if (!isRecord(block) || block["type"] !== "diff" || typeof block["path"] !== "string") continue;
    const oldText = typeof block["oldText"] === "string" ? block["oldText"] : "";
    const newText = typeof block["newText"] === "string" ? block["newText"] : "";
    const { additions, deletions } = diffStat(oldText, newText);
    files.push({
      path: block["path"],
      op: oldText === "" ? "add" : newText === "" ? "delete" : "modify",
      additions,
      deletions,
    });
  }
  return files.length === 0 ? undefined : { files };
}

/**
 * A tool's output: `execute` gives `{exitCode, stdout, stderr}`, `read` `{content}`; anything
 * else stays absent, as `[object Object]` is worse than none.
 */
export function outputOf(raw: unknown): ToolCallPart["output"] | undefined {
  if (!isRecord(raw)) return undefined;
  const exitCode = raw["exitCode"];
  const parts = [raw["stdout"], raw["stderr"], raw["content"]].filter(
    (v): v is string => typeof v === "string" && v !== "",
  );
  if (parts.length === 0 && typeof exitCode !== "number") return undefined;
  return {
    text: parts.join(""),
    ...(typeof exitCode === "number" ? { exitCode } : {}),
    truncated: false,
  };
}

/**
 * ACP `PermissionOption.kind` is already our vocabulary; `optionId` is the key.
 *
 * The key is the agent's own id, never the option's position (ADR-8).
 */
export function permissionOptions(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry["optionId"] !== "string") return [];
    const kind = entry["kind"];
    return [{
      key: entry["optionId"],
      label: typeof entry["name"] === "string" ? entry["name"] : entry["optionId"],
      kind:
        kind === "allow_once" || kind === "allow_always" || kind === "reject_once" || kind === "reject_always"
          ? kind
          : "other",
    }];
  });
}

/**
 * Folds a `tool_call(_update)` onto the held call. ACP sends each call several times with only
 * what changed: absent means *unchanged*, never *cleared*.
 */
export function mergeToolCall(
  update: AcpUpdate,
  held: ToolCallPart | undefined,
  toolName: string,
): Omit<ToolCallPart, "id" | "ts" | "seq" | "provenance"> {
  const diff = diffOf(update["content"]) ?? held?.diff;
  const output = outputOf(update["rawOutput"]) ?? held?.output;
  const locations = locationsOf(update["locations"]);
  return {
    type: "tool_call",
    toolCallId: normalizeToolCallId(update["toolCallId"]),
    toolName,
    title: typeof update["title"] === "string" ? update["title"] : held?.title ?? "",
    kind: update["kind"] === undefined ? held?.kind ?? "other" : toolKind(update["kind"]),
    status: toolStatus(update["status"], held?.status ?? "pending"),
    locations: locations.length > 0 ? locations : held?.locations ?? [],
    ...(diff === undefined ? {} : { diff }),
    ...(output === undefined ? {} : { output }),
  };
}

/** ACP `plan.entries`, narrowed. An entry we cannot read is dropped, not defaulted into the list. */
export function planEntries(raw: unknown): PlanEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e): PlanEntry[] => {
    if (!isRecord(e) || typeof e["content"] !== "string") return [];
    const priority = e["priority"];
    const status = e["status"];
    return [{
      content: e["content"],
      priority: priority === "high" || priority === "low" ? priority : "medium",
      status: status === "in_progress" || status === "completed" ? status : "pending",
    }];
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ACP's `stopReason` vocabulary, narrowed to ours. An error outranks whatever was reported. */
export function readStopReason(stopReason: string | undefined, error: string | undefined): StopReason {
  if (error !== undefined) return "error";
  switch (stopReason) {
    case "cancelled":
      return "cancelled";
    case "max_turn_requests":
    case "max_tokens":
      return "max_turns";
    case "refusal":
      return "error";
    default:
      return "end_turn";
  }
}
