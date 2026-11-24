// Maps Claude Code tools to ThreadItem kinds, and fills in each tool's result.

import type { PatchHunk, ThreadItem } from "../../domain/thread-event";
import { asArr, asNum, asObj, asStr, type Obj } from "./read-json";

// Tool output kept per item. Longer output loses its middle, with a marker, so one `cat` of a big
// file cannot bloat the event store. The end stays: test runners print their counts last (#283).
export const MAX_TOOL_OUTPUT_CHARS = 32_000;
const KEEP_TAIL_CHARS = 8_000;

function clip(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const head = MAX_TOOL_OUTPUT_CHARS - KEEP_TAIL_CHARS;
  return `${text.slice(0, head)}\n… [${text.length - MAX_TOOL_OUTPUT_CHARS} more characters] …\n${text.slice(-KEEP_TAIL_CHARS)}`;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return clip(content);
  return clip(
    asArr(content)
      .map((part) => asStr(asObj(part)?.text))
      .filter((t): t is string => t !== null)
      .join("\n"),
  );
}

export function toolItem(id: string, name: string, input: Obj): ThreadItem {
  const base = { id, status: "running" as const };
  const path = asStr(input.file_path) ?? asStr(input.notebook_path);
  switch (name) {
    case "Bash":
      return { ...base, kind: "command", command: asStr(input.command) ?? "", description: asStr(input.description), output: null };
    case "Read":
      if (path) return { ...base, kind: "fileRead", path, lineCount: null };
      break;
    case "Write":
      if (path) return { ...base, kind: "fileChange", path, change: "create", patch: null };
      break;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      if (path) return { ...base, kind: "fileChange", path, change: "edit", patch: null };
      break;
    case "Grep":
    case "Glob":
      return { ...base, kind: "search", query: asStr(input.pattern) ?? "", output: null };
  }
  return { ...base, kind: "tool", name, input, output: null };
}

export function completeTool(item: ThreadItem, status: ThreadItem["status"], output: string, structured: unknown): ThreadItem {
  const detail = asObj(structured);
  switch (item.kind) {
    case "command":
    case "search":
    case "tool":
      return { ...item, status, output };
    case "fileRead": {
      const lineCount = asNum(asObj(detail?.file)?.numLines);
      return { ...item, status, lineCount };
    }
    case "fileChange": {
      const change = detail?.type === "update" ? "edit" : item.change;
      return { ...item, status, change, patch: status === "completed" ? patchOf(detail) : null };
    }
    default:
      return { ...item, status };
  }
}

function patchOf(detail: Obj | null): PatchHunk[] | null {
  if (!detail) return null;
  const hunks = asArr(detail.structuredPatch)
    .map(asObj)
    .filter((h): h is Obj => h !== null)
    .map((h) => ({
      oldStart: asNum(h.oldStart) ?? 0,
      oldLines: asNum(h.oldLines) ?? 0,
      newStart: asNum(h.newStart) ?? 0,
      newLines: asNum(h.newLines) ?? 0,
      lines: asArr(h.lines).map(asStr).filter((l): l is string => l !== null),
    }));
  if (hunks.length > 0) return hunks;
  // A new file comes with an empty patch and its full content.
  const content = asStr(detail.content);
  if (detail.type !== "create" || content === null) return null;
  const lines = content.replace(/\n$/, "").split("\n");
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
}
