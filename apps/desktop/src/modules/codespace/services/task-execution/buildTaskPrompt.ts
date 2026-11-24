import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";

/**
 * Hard cap on the knowledge body when injected into the agent prompt.
 * Reserves headroom for the workspace context block, the title/goal
 * preamble, and the trailing execute instruction so total prompt size
 * stays well clear of CLI argument and token-window limits.
 *
 * 150 KB is intentionally less than the 200 KB store cap (`TASK_CAPS.knowledge`)
 * because real prompts pay overhead for headers, escaping, and any context
 * the orchestrator prepends.
 */
export const KNOWLEDGE_PROMPT_CAP_BYTES = 150_000;

const TRUNCATION_MARKER = "\n\n[truncated — see full knowledge in BridgeBoard task]";

export type TaskPromptContext = {
  workspaceLabel?: string;
  cwd?: string;
  /** `INT-2` — the name the task is called by, which the worker needs to speak about it. */
  taskKey?: string;
};

/**
 * Build the prompt sent to the agent CLI when a task is dispatched.
 * Pure: no IO, no timestamps, no external state. The caller composes the
 * final command (e.g. wrapping in a CLI invocation) around this string.
 */
export function buildTaskPrompt(task: BridgeTask, ctx?: TaskPromptContext): string {
  const sections: string[] = [];

  if (ctx && (ctx.workspaceLabel || ctx.cwd)) {
    sections.push(renderContextBlock(ctx));
  }

  const key = ctx?.taskKey?.trim();
  sections.push(key ? `Task: ${key} — ${task.title.trim()}` : `Task: ${task.title.trim()}`);

  if (task.goal.trim().length > 0) {
    sections.push(`Goal:\n${task.goal.trim()}`);
  }

  // A checklist is only mentioned when there is one: an empty "Sub-tasks" heading claims there
  // was a checklist and that the worker has nothing to do from it.
  if (task.subtasks?.length) {
    const lines = task.subtasks
      .map((subtask) => `- [${subtask.status === "completed" ? "x" : " "}] ${subtask.title}`)
      .join("\n");
    sections.push(`Sub-tasks:\n${lines}`);
  }

  const truncated = truncateKnowledge(task.knowledge);
  if (truncated.length > 0) {
    sections.push(`Context:\n${truncated}`);
  }

  sections.push(renderReportBack(task));
  sections.push("Execute the task above.");

  return sections.join("\n\n").trimEnd() + "\n";
}

/**
 * What the worker is asked to send back, and which tool sends it.
 *
 * Added because the detail panel has been able to draw an agent's record since the MCP tools
 * shipped and has been empty in practice: the prompt ended at "Execute the task above." and never
 * mentioned that the task was tracked at all. A worker cannot report to a surface nobody told it
 * about.
 *
 * The ids are printed because every one of these calls needs both, and a worker asked to find its
 * own task id will either guess or waste a turn looking.
 */
function renderReportBack(task: BridgeTask): string {
  return [
    "Report back",
    `This task is tracked in Lotus. workspaceId=${task.workspaceId} taskId=${task.id}`,
    "- Read the full record first: lotus_get_task",
    "- Report each real step, not each command: lotus_append_task_feedback_event with kind \"agent-result\"",
    "- Ask for review when the work is done: lotus_request_task_review",
    "- Cannot proceed: lotus_canvas_mark_blocked, and say what would unblock it",
    "Do not report a blocked task as finished. The list would then tell somebody to stop looking.",
  ].join("\n");
}

function renderContextBlock(ctx: TaskPromptContext): string {
  const lines = ["<workspace-state>"];
  if (ctx.workspaceLabel) lines.push(`workspace=${ctx.workspaceLabel}`);
  if (ctx.cwd) lines.push(`cwd=${ctx.cwd}`);
  lines.push("</workspace-state>");
  return lines.join("\n");
}

/**
 * Trim knowledge to the byte cap without splitting a multi-byte UTF-8
 * codepoint. Encodes once, slices on the byte buffer, then decodes with
 * `ignoreBOM: true` so any partial trailing bytes are dropped cleanly.
 */
function truncateKnowledge(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";

  const encoded = new TextEncoder().encode(trimmed);
  if (encoded.byteLength <= KNOWLEDGE_PROMPT_CAP_BYTES) return trimmed;

  const sliced = encoded.subarray(0, KNOWLEDGE_PROMPT_CAP_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  // The "stream" decoder gracefully drops trailing partial codepoints.
  const safe = decoder.decode(sliced);
  return safe + TRUNCATION_MARKER;
}
