import type { StopReason, ToolKind } from "../../../../../types/conversation.js";
import { isRecord } from "../acp/parts.js";

/**
 * The `stream-json` vocabulary, as `claude --print --output-format stream-json` actually
 * writes it. Probed against the real binary on 2026-09-07 (`__tests__/fixtures/`).
 *
 * One process, many turns: a second prompt on the same stdin continues the same
 * `session_id`. That is what lets a Claude cell live here the way a Codex or an ACP one
 * does, and it is why this bridge needs no SDK — the protocol is already line-delimited
 * JSON, the same shape the transport in `structured/jsonrpc-stdio.ts` was written for.
 *
 * Types seen, in the order a turn produces them: `system{subtype: init|status|
 * thinking_tokens|hook_started|hook_response}`, `stream_event` (partial deltas, only with
 * `--include-partial-messages`), `assistant` (whole message, `content[]` of `text` /
 * `thinking` / `tool_use`), `user` (a `tool_result` coming back), `rate_limit_event`, and
 * `result`.
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
 * Claude's tool names, mapped to the ACP kinds the rest of Lotus speaks.
 *
 * Read from the name because `stream-json` has no kind of its own. A name this map does
 * not know becomes `other` rather than a guess — the same rule the ACP bridge follows for
 * an unknown kind, and the reason a new tool renders as a plain step instead of a wrong one.
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
 * The one line a step renders beside its name.
 *
 * Claude's tool inputs are per-tool shapes, so this reads the field that names the target
 * for each: a path for the file tools, the command for `Bash`, the pattern for a search.
 * Nothing is stringified wholesale — a rendered `[object Object]` is worse than a step with
 * no target at all.
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
 * The rate-limit window Claude volunteers on its own stream.
 *
 * Worth naming precisely, because it is the answer to a problem found the hard way on
 * Cursor: with the plan exhausted, a turn there completed normally and the agent's prose
 * was "upgrade your plan to continue" — a quota wall indistinguishable from an answer
 * (`plans/provider-bridge-adoption/PLAN.md` G8). Claude says it outright, per turn, with
 * no dashboard call and no second credential.
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
 * What to tell the operator about a plan window, or nothing.
 *
 * Only on a **change away from plain `allowed`**, for two reasons. A notice on every turn
 * would be a line of noise per step on a healthy plan; and the state that matters is the
 * transition — the moment the answer stops being "yes" is the moment G8 describes, where an
 * exhausted plan reads as an odd reply rather than as a wall.
 *
 * The reset time is included when the runner gave one, as the epoch seconds it sent. It is
 * not formatted here: the client knows the operator's timezone and this does not.
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
