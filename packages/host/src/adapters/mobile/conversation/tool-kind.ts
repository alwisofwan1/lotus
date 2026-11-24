import type { ToolKind } from "../../../types/conversation.js";

/**
 * A runner's tool name → ACP `ToolKind`.
 *
 * The Claude rows are the mapping `@zed-industries/claude-code-acp` ships in `src/tools.ts`;
 * the Codex rows are the `custom_tool_call` names seen in rollout files on this machine
 * (`exec`, `apply_patch`, `web.search`). Anything else is `other`, which is a kind, not a
 * failure — the phone draws it as a plain step.
 */
const KINDS: Record<string, ToolKind> = {
  read: "read",
  notebookread: "read",
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  notebookedit: "edit",
  apply_patch: "edit",
  bash: "execute",
  exec: "execute",
  shell: "execute",
  glob: "search",
  grep: "search",
  rg: "search",
  websearch: "fetch",
  webfetch: "fetch",
  "web.search": "fetch",
  task: "think",
  agent: "think",
  todowrite: "think",
  taskcreate: "think",
};

export function toolKindOf(toolName: string): ToolKind {
  return KINDS[toolName.trim().toLowerCase()] ?? "other";
}

/** Whether a `tool_call` of this kind names a file, so its title can double as a location. */
export function kindNamesAFile(kind: ToolKind): boolean {
  return kind === "read" || kind === "edit" || kind === "delete" || kind === "move";
}

/**
 * A short, stable id from a string — FNV-1a, 32-bit, hex.
 *
 * Parts have no runner-issued id yet, so one is derived from the entry's own composite
 * key (`timestamp|event|title|toolTarget|body.length`, the same key the phone's
 * `LiveTranscript` already dedupes on). Deterministic, so the same entry served in two
 * pages, or once over REST and once as a live frame, yields the same id.
 */
export function stableId(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
