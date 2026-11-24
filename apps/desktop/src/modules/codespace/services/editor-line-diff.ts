/*
 * Which lines of the editor differ from git's copy, for the marks beside the line numbers (the
 * "git gutter"): lines added, lines changed, and the places where lines were removed. A Myers
 * diff over whole lines; past a size or an edit count where it would get slow, the changed middle
 * is marked as one block instead.
 */

export type LineChangeKind = "added" | "modified" | "deleted";
/** Lines in the current text, 1-based and inclusive. A deletion sits on the line above the gap (0: before line 1). */
export type LineChange = { kind: LineChangeKind; startLine: number; endLine: number };

const MAX_LINES = 50_000;
const MAX_EDITS = 2000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  // A final break ends the last line; it does not start one more.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Pairs of equal lines (a index, b index), in order, as Myers' shortest edit script finds them. */
function myersMatches(a: readonly number[], b: readonly number[]): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max; d += 1) {
    if (d > MAX_EDITS) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  // Walk back through the saved rows, collecting the diagonal (equal) steps.
  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d -= 1) {
    const row = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && row[offset + k - 1] < row[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : row[offset + prevK];
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  return matches.reverse();
}

function hunk(removed: number, addedStart: number, addedCount: number): LineChange {
  // addedStart is a 0-based index into the current lines.
  if (addedCount === 0) return { kind: "deleted", startLine: addedStart, endLine: addedStart };
  return { kind: removed === 0 ? "added" : "modified", startLine: addedStart + 1, endLine: addedStart + addedCount };
}

export function computeLineChanges(base: string, current: string): LineChange[] {
  if (base === current) return [];
  const a = splitLines(base);
  const b = splitLines(current);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  if (start === endA && start === endB) return [];
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const ids = new Map<string, number>();
  const id = (line: string) => {
    let value = ids.get(line);
    if (value === undefined) {
      value = ids.size;
      ids.set(line, value);
    }
    return value;
  };
  const matches = middleA.length + middleB.length > MAX_LINES
    ? null
    : myersMatches(middleA.map(id), middleB.map(id));
  if (!matches) return [hunk(middleA.length, start, middleB.length)];
  const changes: LineChange[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ma, mb] of [...matches, [middleA.length, middleB.length] as [number, number]]) {
    if (ma > ai || mb > bi) changes.push(hunk(ma - ai, start + bi, mb - bi));
    ai = ma + 1;
    bi = mb + 1;
  }
  return changes;
}
