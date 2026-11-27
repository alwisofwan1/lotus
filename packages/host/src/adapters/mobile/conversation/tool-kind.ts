import type { ToolKind } from "../../../types/conversation.js";

/**
 * Tool name → ACP `ToolKind`. Claude rows mirror `@zed-industries/claude-code-acp`; Codex rows
 * are `custom_tool_call` names from rollout files. Anything else is `other`.
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
 * FNV-1a 32-bit hex of the entry's composite key (`timestamp|event|title|toolTarget|body.length`,
 * as the phone's `LiveTranscript` dedupes), so REST and live copies share an id.
 */
export function stableId(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
