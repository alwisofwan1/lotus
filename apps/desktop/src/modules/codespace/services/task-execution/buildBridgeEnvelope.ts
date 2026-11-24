import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";
import type { TaskPromptContext } from "./buildTaskPrompt";

/**
 * Knowledge cap when delivering via Bridge. Tighter than the direct-CLI cap
 * (150 KB) because the Bridge LLM also has to spend tokens reasoning about
 * routing and may inject its own framing prompts.
 */
export const BRIDGE_KNOWLEDGE_CAP_BYTES = 100_000;

const TRUNCATION_MARKER = "\n\n[truncated — see BridgeBoard task for full knowledge]";

/**
 * Encode the task as a single XML element the Bridge orchestrator can
 * detect, parse, and decide how to dispatch (which agent, single-shot vs
 * multi-step, etc.). XML chosen over JSON because:
 *   - Trivial to spot in PTY stream visually
 *   - Bridge's existing context-serializer already speaks XML
 *   - Survives shell escaping without requiring quote-the-quoting
 *
 * Pure: no IO, no timestamps. Caller composes the final write into the PTY.
 */
export function buildBridgeEnvelope(task: BridgeTask, ctx?: TaskPromptContext): string {
  const attrs: string[] = [
    `id=${quote(task.id)}`,
    `workspace=${quote(task.workspaceId)}`,
  ];
  if (task.priority && task.priority !== "none") {
    attrs.push(`priority=${quote(task.priority)}`);
  }
  if (ctx?.workspaceLabel) attrs.push(`workspace-label=${quote(ctx.workspaceLabel)}`);
  if (ctx?.cwd) attrs.push(`cwd=${quote(ctx.cwd)}`);

  const children: string[] = [];
  children.push(`<title>${escape(task.title)}</title>`);
  if (task.goal.trim().length > 0) {
    children.push(`<goal>${escape(task.goal.trim())}</goal>`);
  }
  if (task.assignees.length > 0) {
    children.push(`<assignees>${escape(task.assignees.join(", "))}</assignees>`);
  }
  const knowledge = truncate(task.knowledge);
  if (knowledge.length > 0) {
    children.push(`<knowledge>${escape(knowledge)}</knowledge>`);
  }

  return `<bridge-task ${attrs.join(" ")}>\n${children.map((c) => "  " + c).join("\n")}\n</bridge-task>\n`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function quote(s: string): string {
  return `"${escape(s)}"`;
}

function truncate(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const enc = new TextEncoder().encode(trimmed);
  if (enc.byteLength <= BRIDGE_KNOWLEDGE_CAP_BYTES) return trimmed;
  const sliced = enc.subarray(0, BRIDGE_KNOWLEDGE_CAP_BYTES);
  const safe = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
  return safe + TRUNCATION_MARKER;
}
