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
 * ACP `session/update` payloads, as `cursor-agent acp` actually sends them.
 *
 * Verified against a capture of the real binary on 2026-09-06
 * (`__tests__/fixtures/cursor-acp-turn.jsonl`). Everything here is `unknown`-in, typed-out:
 * an agent is free to send a field we have never seen, and a shape we cannot read must
 * become an `unknown` part rather than a thrown parse.
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
 * `op` is read from which side is empty, so a created file is `add` and a truncated one is
 * `delete` — the same three-way `FileDiff` the hook pipeline produces, but with real counts
 * instead of hunk arithmetic.
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
 * A tool's output, from whichever shape the agent used.
 *
 * `execute` answers `{exitCode, stdout, stderr}` and `read` answers `{content}`; anything
 * else is left absent rather than stringified, since a rendered `[object Object]` is worse
 * than a step with no output.
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
 * The key is the agent's own id, never the option's position — the rule ADR-8 pinned after a
 * phone answered the wrong option because the list had been reordered.
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
 * A `tool_call` or `tool_call_update` folded onto whatever we already held for that call.
 *
 * ACP sends a call three or four times — `pending` with an empty `rawInput`, then a retitle,
 * then `in_progress`, then `completed` with the output — and each message carries only what
 * changed. Absent is therefore *unchanged*, never *cleared*, which is why every field falls
 * back to the held one rather than to a default.
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
