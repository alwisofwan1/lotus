/**
 * `+n −n` from an ACP `diff` block's before/after texts: an LCS over lines; large files trim
 * the common prefix and suffix instead (right for one contiguous edit, not quadratic).
 */
const LCS_LINE_CAP = 2000;

export interface DiffStat {
  additions: number;
  deletions: number;
}

export function diffStat(oldText: string, newText: string): DiffStat {
  const before = lines(oldText);
  const after = lines(newText);
  return before.length > LCS_LINE_CAP || after.length > LCS_LINE_CAP
    ? trimmed(before, after)
    : viaLcs(before, after);
}

/** A trailing newline ends the last line; it does not start an empty one. */
function lines(text: string): string[] {
  if (text === "") return [];
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
}

function viaLcs(before: string[], after: string[]): DiffStat {
  const rows = before.length;
  const cols = after.length;
  // table[i][j] = length of the longest common subsequence of before[i..] and after[j..].
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const row = table[i];
      const next = table[i + 1];
      if (row === undefined || next === undefined) continue;
      row[j] = before[i] === after[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const common = table[0]?.[0] ?? 0;
  return { additions: cols - common, deletions: rows - common };
}

function trimmed(before: string[], after: string[]): DiffStat {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return { additions: after.length - head - tail, deletions: before.length - head - tail };
}
