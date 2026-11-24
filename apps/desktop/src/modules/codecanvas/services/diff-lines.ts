export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const META_PREFIXES = ["diff --git", "index ", "new file", "deleted file", "rename ", "similarity ", "--- ", "+++ "];

function classify(line: string): DiffLineKind {
  if (META_PREFIXES.some((p) => line.startsWith(p))) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** Split a unified git diff into classified lines for syntax-coloured rendering. */
export function parseDiffLines(diff: string): DiffLine[] {
  if (!diff.trim()) return [];
  return diff
    .replace(/\n$/, "")
    .split("\n")
    .map((text) => ({ kind: classify(text), text }));
}
