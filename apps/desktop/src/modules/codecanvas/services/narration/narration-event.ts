/**
 * Layer 1 of the narration stack: normalize agent-CLI hook drops into one event shape
 * (Slice 3 of `plans/voice-narration-layer/`).
 *
 * **No schema change was needed.** The v1 drop payload's `event` is a free string — the Rust parser
 * only checks it is non-empty and clamps it to 32 chars, and the processor does not filter on it
 * (`src-tauri/src/agent_hooks/payload.rs`). New narration kinds therefore ride the existing v1
 * contract with no `PAYLOAD_VERSION` bump and no Tauri rebuild. Tool identity travels in the
 * existing display fields by convention: `title` carries the tool name, `body` the detail.
 *
 * This module is deterministic and never calls a model — see the layer boundary rule in PLAN.md.
 */

/** The v1 drop payload as it reaches the frontend on `lotus://agent-hook`. */
export interface AgentHookDropPayload {
  version: number;
  sessionId: string | null;
  agentType: string;
  event: string;
  status: string;
  title: string;
  body: string;
  userPrompt: string;
  cwd: string;
  pid: number | null;
  agentPid: number | null;
  paneId?: string | null;
  timestamp: number;
}

/** What the agent is doing, at the granularity narration cares about. */
export type NarrationKind = "tool_pre" | "tool_post" | "prompt_intent" | "intermediate" | "final";

export interface NarrationEvent {
  kind: NarrationKind;
  /**
   * The routing key every layer above reads: `tool_edit`, `tool_post_failure`, `prompt_intent`, …
   * Pierce rules and digest verb counts are both keyed on this, never on free text.
   */
  tag: string;
  /** Plain source text. Material for narration — never spoken verbatim. */
  neutral: string;
  /** Canvas pane the event belongs to (LOTUS_PANE_ID). */
  paneId: string;
  /**
   * Absolute path of the file this tool touched, when it touched one. Set for tool events only —
   * a `final`'s body is prose and a prompt's is the user's words; treating either as a path would
   * corrupt the per-agent area label derived from touched directories.
   */
  filePath?: string;
  ts: number;
}

/** Drop `event` values that map onto a narration kind. Anything else is not narration-relevant. */
const KIND_BY_HOOK_EVENT: Readonly<Record<string, NarrationKind>> = {
  "tool-pre": "tool_pre",
  "tool-post": "tool_post",
  "tool-post-failed": "tool_post",
  "prompt-submit": "prompt_intent",
  stop: "final",
};

/**
 * The one hook event that means a tool failed.
 *
 * Failure is signalled by the EVENT NAME rather than by `status`, because `status` belongs to
 * another consumer: codespace's `useAgentHookEvents` filters on status alone — never on the event
 * name — and reads `"error"` as "the agent failed" and `"idle"` as "the agent completed". A tool
 * drop carrying either would mislabel the whole agent on every single tool call. Tool drops are
 * therefore always `status: "running"`, which that consumer skips.
 */
const TOOL_FAILED_EVENT = "tool-post-failed";

/** `"Edit"` → `"edit"`, `"NotebookEdit"` → `"notebookedit"`; empty stays empty. */
function toolSlug(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * The routing tag for one drop.
 *
 * A failed tool result collapses to a single `tool_post_failure` regardless of which tool failed:
 * every pierce rule downstream keys on that one string, and letting the tool name vary would mean
 * each new tool silently opting out of the "failures always speak" invariant.
 */
function narrationTag(kind: NarrationKind, payload: AgentHookDropPayload): string {
  if (kind === "prompt_intent") return "prompt_intent";
  if (kind === "final") return "final";
  if (payload.event === TOOL_FAILED_EVENT) return "tool_post_failure";
  const slug = toolSlug(payload.title) || "unknown";
  return kind === "tool_post" ? `tool_post_${slug}` : `tool_${slug}`;
}

/**
 * Normalize one hook drop into a {@link NarrationEvent}, or `null` when the drop is not something
 * narration speaks about.
 */
export function toNarrationEvent(payload: AgentHookDropPayload): NarrationEvent | null {
  const kind = KIND_BY_HOOK_EVENT[payload.event];
  if (!kind) return null;
  const isToolEvent = kind === "tool_pre" || kind === "tool_post";
  const filePath = isToolEvent ? payload.body.trim() : "";
  return {
    kind,
    tag: narrationTag(kind, payload),
    ...(filePath ? { filePath } : {}),
    // At submit time the substance is the user's prompt; `body` is still empty.
    neutral: kind === "prompt_intent" ? payload.userPrompt : payload.body,
    paneId: payload.paneId ?? "",
    ts: payload.timestamp,
  };
}
