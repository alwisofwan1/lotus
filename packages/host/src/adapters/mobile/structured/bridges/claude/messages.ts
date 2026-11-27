import type { StopReason, ToolKind } from "../../../../../types/conversation.js";
import { isRecord } from "../acp/parts.js";

/**
 * The `stream-json` vocabulary (`__tests__/fixtures/`). One process, many turns: a second prompt
 * on stdin continues the same `session_id`, so no SDK. Types: `system`, `stream_event`
 * (needs `--include-partial-messages`), `assistant`, `user`, `rate_limit_event`, `result`.
 */
export interface ClaudeMessage {
  type: string;
  [key: string]: unknown;
}

/** A content block inside an `assistant` message. */
export interface ClaudeBlock {
  type: string;
  [key: string]: unknown;
}

export function blocksOf(message: unknown): ClaudeBlock[] {
  if (!isRecord(message)) return [];
  const inner = isRecord(message["message"]) ? message["message"] : message;
  const content = inner["content"];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) =>
    isRecord(b) && typeof b["type"] === "string" ? [{ ...b, type: b["type"] }] : [],
  );
}

/**
 * Tool names → ACP kinds (`stream-json` has none). Unknown becomes `other`, not a guess.
 */
const KINDS: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>([
  ["Read", "read"],
  ["NotebookRead", "read"],
  ["Glob", "search"],
  ["Grep", "search"],
  ["Edit", "edit"],
  ["Write", "edit"],
  ["NotebookEdit", "edit"],
  ["MultiEdit", "edit"],
  ["Bash", "execute"],
  ["BashOutput", "execute"],
  ["KillShell", "execute"],
  ["Task", "think"],
  ["TodoWrite", "think"],
  ["WebFetch", "fetch"],
  ["WebSearch", "fetch"],
]);

export function toolKindOf(name: string): ToolKind {
  return KINDS.get(name) ?? "other";
}

/**
 * The line a step shows beside its name: the per-tool target field. Never stringify
 * wholesale; `[object Object]` is worse than no target.
 */
export function toolTargetOf(name: string, input: unknown): string {
  if (!isRecord(input)) return "";
  for (const key of ["file_path", "notebook_path", "command", "pattern", "url", "path", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/** `tool_result.content` is a string for most tools and a block list for the rest. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((b) => (isRecord(b) && typeof b["text"] === "string" ? [b["text"]] : []))
    .join("");
}

export interface RateLimitWindow {
  /** `allowed`, `allowed_warning`, `rejected` — the runner's own word, kept verbatim. */
  status: string;
  /** `five_hour`, `weekly`, … */
  window: string;
  /** Epoch **seconds**, as the runner sends it. */
  resetsAt?: number;
}

/**
 * The rate-limit window Claude reports per turn. Answers G8
 * (`plans/provider-bridge-adoption/PLAN.md`): an exhausted plan looks like an ordinary reply.
 */
export function rateLimitOf(message: unknown): RateLimitWindow | undefined {
  if (!isRecord(message)) return undefined;
  const info = message["rate_limit_info"];
  if (!isRecord(info) || typeof info["status"] !== "string") return undefined;
  const resetsAt = info["resetsAt"];
  return {
    status: info["status"],
    window: typeof info["rateLimitType"] === "string" ? info["rateLimitType"] : "unknown",
    ...(typeof resetsAt === "number" ? { resetsAt } : {}),
  };
}

/** A tool Claude wanted to run and was not allowed to, named in the turn's `result`. */
export interface PermissionDenial {
  toolName: string;
  toolUseId: string;
  target: string;
}

export function denialsOf(result: unknown): PermissionDenial[] {
  if (!isRecord(result) || !Array.isArray(result["permission_denials"])) return [];
  return result["permission_denials"].flatMap((d) => {
    if (!isRecord(d) || typeof d["tool_name"] !== "string") return [];
    return [{
      toolName: d["tool_name"],
      toolUseId: typeof d["tool_use_id"] === "string" ? d["tool_use_id"] : "",
      target: toolTargetOf(d["tool_name"], d["tool_input"]),
    }];
  });
}

export function stopReasonOf(message: ClaudeMessage): StopReason {
  if (message["is_error"] === true) return "error";
  switch (message["stop_reason"]) {
    case "max_turns":
      return "max_turns";
    case "cancelled":
    case "abort":
      return "cancelled";
    case "error":
      return "error";
    default:
      return "end_turn";
  }
}

/** Absent counts stay absent — a turn that reported no tokens must not render as zero. */
export function usageOf(raw: unknown): { input?: number; output?: number } | undefined {
  if (!isRecord(raw)) return undefined;
  const input = raw["input_tokens"];
  const output = raw["output_tokens"];
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  return {
    ...(typeof input === "number" ? { input } : {}),
    ...(typeof output === "number" ? { output } : {}),
  };
}

/**
 * A notice only on a **change away from plain `allowed`** (G8); per-turn is noise. The reset
 * time stays epoch seconds: the client knows the timezone.
 */
export function rateLimitNotice(
  window: RateLimitWindow,
  previousStatus: string | undefined,
): string | undefined {
  if (window.status === "allowed") return undefined;
  if (window.status === previousStatus) return undefined;
  const resets = window.resetsAt === undefined ? "" : ` Resets at ${window.resetsAt}.`;
  return `${window.window} plan limit: ${window.status}.${resets}`;
}
