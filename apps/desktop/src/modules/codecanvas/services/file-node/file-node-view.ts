import type { LineChange } from "@/modules/codespace/services/editor-line-diff";

/** Past this many lines the body shows plain text: Shiki runs on the main thread. */
export const MAX_HIGHLIGHT_LINES = 3000;

export function fileNodeNames(path: string, root: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const folder = slash >= 0 ? path.slice(0, slash) : "";
  const base = root.replace(/\/+$/, "");
  if (base && (folder === base || folder.startsWith(`${base}/`))) return { name, dir: folder.slice(base.length + 1) };
  return { name, dir: folder };
}

export type GutterMark = "added" | "modified" | "deleted" | "deleted-top";

/** Line number (1-based) to its mark. Added/modified beat a deletion that lands on the same line. */
export function gutterMarksByLine(changes: readonly LineChange[]): Map<number, GutterMark> {
  const marks = new Map<number, GutterMark>();
  for (const change of changes) {
    if (change.kind === "deleted") {
      const line = Math.max(1, change.startLine);
      if (!marks.has(line)) marks.set(line, change.startLine === 0 ? "deleted-top" : "deleted");
      continue;
    }
    for (let line = change.startLine; line <= change.endLine; line += 1) marks.set(line, change.kind);
  }
  return marks;
}

/** The slice of lines worth drawing for a scrolled, fixed-line-height body. End is exclusive. */
export function lineWindow(input: { scrollTop: number; viewportHeight: number; lineHeight: number; total: number; overscan: number }): { start: number; end: number } {
  // A body scrolled past a shrunken file (it was edited shorter) still draws its last lines.
  const first = Math.min(Math.floor(input.scrollTop / input.lineHeight), Math.max(0, input.total - 1));
  const last = Math.ceil((input.scrollTop + input.viewportHeight) / input.lineHeight);
  return {
    start: Math.max(0, Math.min(input.total, first - input.overscan)),
    end: Math.max(0, Math.min(input.total, last + input.overscan)),
  };
}
