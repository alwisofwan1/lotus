/**
 * Ranks file paths for Go to file.
 *
 * Matches are sorted by intent first, then by how well the letters line up:
 * 4. the path starts with a query that names folders (`src/components/`);
 * 3. a query with slashes matches folder by folder, its last part in the file name (`comp/app`);
 * 2. the letters are all in the file name;
 * 1. the letters are somewhere in the path.
 * Inside a tier, letters at word starts and in runs score higher. Ties go to the earlier match,
 * then the shorter path, then A–Z. A query with a capital letter is case-sensitive.
 * The tiers follow bb's `packages/fuzzy-match`.
 */

export type PathHit = {
  path: string;
  relativePath: string;
  name: string;
  folder: string;
  /** Indexes into `name` of the matched letters, for highlighting. */
  nameMatches: number[];
  tier: number;
  score: number;
};

/** Go to file and the tree filter: later letters of a query wait this long for a pause in typing. */
export const PATH_QUERY_DEBOUNCE_MS = 120;

const MAX_QUERY_LENGTH = 256;
const BOUNDARY_BONUS = 8;
const RUN_BONUS = 5;
const FIRST_CHAR_BONUS = 2;
const GAP_PENALTY = 0.1;

type Match = { score: number; positions: number[] };

const isUpper = (code: number) => code >= 65 && code <= 90;
const isLower = (code: number) => code >= 97 && code <= 122;
const SEPARATORS = new Set([47, 46, 95, 45, 32]); // / . _ - space

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text.charCodeAt(index - 1);
  return SEPARATORS.has(previous) || (isUpper(text.charCodeAt(index)) && isLower(previous));
}

/*
 * `text` and `query` are compared as given: the caller passes both lowercased for a
 * case-insensitive query, and `original` keeps the casing that word starts are read from.
 */

function isSubsequence(text: string, query: string): boolean {
  let at = 0;
  for (let i = 0; i < text.length && at < query.length; i += 1) {
    if (text[i] === query[at]) at += 1;
  }
  return at === query.length;
}

// Grow-only work buffers: a key press scores thousands of names, so nothing is allocated per name.
let scoreBuffer = new Float64Array(0);
let backBuffer = new Int32Array(0);

/** Best placement of `query` in `text`, favouring word starts and runs. O(query × text). */
function bestMatch(text: string, query: string, original: string = text): Match | null {
  const n = text.length;
  const m = query.length;
  if (m === 0 || m > n || !isSubsequence(text, query)) return null;

  const charScore = (j: number) => 1 + (isBoundary(original, j) ? BOUNDARY_BONUS : 0) + (j === 0 ? FIRST_CHAR_BONUS : 0);

  if (m === 1) {
    let bestAt = -1;
    let bestScore = -Infinity;
    for (let j = 0; j < n; j += 1) {
      if (text[j] !== query) continue;
      const score = charScore(j);
      if (score > bestScore) {
        bestScore = score;
        bestAt = j;
      }
    }
    return { score: bestScore, positions: [bestAt] };
  }

  if (scoreBuffer.length < m * n) {
    scoreBuffer = new Float64Array(m * n * 2);
    backBuffer = new Int32Array(m * n * 2);
  }
  const score = scoreBuffer;
  const back = backBuffer;
  score.fill(-Infinity, 0, m * n);

  for (let j = 0; j < n; j += 1) {
    if (text[j] === query[0]) score[j] = charScore(j);
  }
  for (let i = 1; i < m; i += 1) {
    const row = i * n;
    const previous = row - n;
    // Best `score[i-1][k] + GAP_PENALTY * k` for k < j - 1, so a gap costs GAP_PENALTY per letter.
    let bestGap = -Infinity;
    let bestGapAt = -1;
    for (let j = 1; j < n; j += 1) {
      const k = j - 2;
      if (k >= 0 && score[previous + k] + GAP_PENALTY * k > bestGap) {
        bestGap = score[previous + k] + GAP_PENALTY * k;
        bestGapAt = k;
      }
      if (text[j] !== query[i]) continue;
      const viaRun = score[previous + j - 1] + RUN_BONUS;
      const viaGap = bestGap - GAP_PENALTY * (j - 1);
      if (viaRun === -Infinity && viaGap === -Infinity) continue;
      if (viaRun >= viaGap) {
        score[row + j] = viaRun + charScore(j);
        back[row + j] = j - 1;
      } else {
        score[row + j] = viaGap + charScore(j);
        back[row + j] = bestGapAt;
      }
    }
  }

  const lastRow = (m - 1) * n;
  let end = -1;
  for (let j = 0; j < n; j += 1) {
    if (score[lastRow + j] > (end < 0 ? -Infinity : score[lastRow + end])) end = j;
  }
  if (end < 0 || score[lastRow + end] === -Infinity) return null;

  const positions = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; i -= 1) {
    positions[i] = j;
    j = back[i * n + j];
  }
  return { score: score[lastRow + end], positions };
}

/** Greedy placement for a match that is only in the folders: cheap, and ranked below names. */
function greedyMatch(text: string, query: string, original: string): Match | null {
  const positions: number[] = [];
  let score = 0;
  let at = 0;
  for (let j = 0; j < text.length && at < query.length; j += 1) {
    if (text[j] !== query[at]) continue;
    score += 1 + (isBoundary(original, j) ? BOUNDARY_BONUS : 0) + (positions.at(-1) === j - 1 ? RUN_BONUS : 0);
    positions.push(j);
    at += 1;
  }
  return at === query.length ? { score: score - (positions[positions.length - 1] - positions[0]) * GAP_PENALTY, positions } : null;
}

type Prepared = {
  path: string;
  relativePath: string;
  relativeLower: string;
  name: string;
  nameLower: string;
  folder: string;
};

function relativeTo(rootDir: string, path: string): string {
  const root = rootDir.replace(/[\\/]+$/, "");
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

function prepare(path: string, rootDir: string): Prepared {
  const relativePath = relativeTo(rootDir, path);
  const slash = relativePath.lastIndexOf("/");
  const name = slash < 0 ? relativePath : relativePath.slice(slash + 1);
  return {
    path,
    relativePath,
    relativeLower: relativePath.toLowerCase(),
    name,
    nameLower: name.toLowerCase(),
    folder: slash < 0 ? "" : relativePath.slice(0, slash),
  };
}

// The index is the same array for every key press; prepare it once.
const preparedCache = new WeakMap<readonly string[], { rootDir: string; items: Prepared[] }>();

function preparedFor(paths: readonly string[], rootDir: string): Prepared[] {
  const cached = preparedCache.get(paths);
  if (cached && cached.rootDir === rootDir) return cached.items;
  const items = paths.map((path) => prepare(path, rootDir));
  preparedCache.set(paths, { rootDir, items });
  return items;
}

/** Folder-by-folder match for a query with slashes; the last part must be in the file name. */
function segmentMatch(item: Prepared, parts: string[], caseSensitive: boolean): Match | null {
  const segments = item.relativePath.split("/");
  const compared = caseSensitive ? segments : item.relativeLower.split("/");
  const last = parts.length - 1;
  const nameMatch = bestMatch(compared[compared.length - 1], parts[last], segments[segments.length - 1]);
  if (!nameMatch) return null;
  let score = nameMatch.score;
  let at = 0;
  for (const part of parts.slice(0, last)) {
    let found: Match | null = null;
    while (at < compared.length - 1 && !(found = bestMatch(compared[at], part, segments[at]))) at += 1;
    if (!found) return null;
    score += found.score;
    at += 1;
  }
  return { score, positions: nameMatch.positions };
}

/** The cheap filter every hit passes: the query's letters, in order, somewhere in the path. */
function containsLetters(item: Prepared, query: string, caseSensitive: boolean): boolean {
  return isSubsequence(caseSensitive ? item.relativePath : item.relativeLower, query);
}

/*
 * The paths that passed the last query's letter filter. Typing one more letter can only shrink
 * that set (a path holding "app" in order holds "ap"), so the next query scans it instead of the
 * whole index: in a 200k-file repo that is most of the cost of every key after the first. Only the
 * filter is narrowed, never the tiers: "src/" ranks "lib/src/app.ts" out, "src/app" takes it back.
 */
const narrowedCache = new WeakMap<readonly string[], { rootDir: string; query: string; caseSensitive: boolean; items: Prepared[] }>();

function candidatesFor(paths: readonly string[], rootDir: string, query: string, caseSensitive: boolean): Prepared[] {
  const previous = narrowedCache.get(paths);
  const pool = previous
    && previous.rootDir === rootDir
    && previous.caseSensitive === caseSensitive
    && isSubsequence(query, previous.query)
    ? previous.items
    : preparedFor(paths, rootDir);
  const items = pool.filter((item) => containsLetters(item, query, caseSensitive));
  narrowedCache.set(paths, { rootDir, query, caseSensitive, items });
  return items;
}

/** `item` already holds the query's letters (see `candidatesFor`). */
function scoreItem(item: Prepared, query: string, caseSensitive: boolean): PathHit | null {
  const base = { path: item.path, relativePath: item.relativePath, name: item.name, folder: item.folder };
  const relative = caseSensitive ? item.relativePath : item.relativeLower;

  if (query.includes("/")) {
    if (relative.startsWith(query)) {
      const rest = query.slice(query.lastIndexOf("/") + 1);
      const inName = rest ? bestMatch(caseSensitive ? item.name : item.nameLower, rest, item.name) : null;
      return { ...base, tier: 4, score: -item.relativePath.length * 0.01, nameMatches: inName?.positions ?? [] };
    }
    const parts = query.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    const match = segmentMatch(item, parts, caseSensitive);
    return match ? { ...base, tier: 3, score: match.score, nameMatches: match.positions } : null;
  }

  const inName = bestMatch(caseSensitive ? item.name : item.nameLower, query, item.name);
  if (inName) return { ...base, tier: 2, score: inName.score, nameMatches: inName.positions };

  const inPath = greedyMatch(relative, query, item.relativePath);
  if (!inPath) return null;
  const nameStart = item.relativePath.length - item.name.length;
  return {
    ...base,
    tier: 1,
    score: inPath.score,
    nameMatches: inPath.positions.filter((p) => p >= nameStart).map((p) => p - nameStart),
  };
}

function compareHits(a: PathHit, b: PathHit): number {
  return b.tier - a.tier
    || b.score - a.score
    || (a.nameMatches[0] ?? Infinity) - (b.nameMatches[0] ?? Infinity)
    || a.relativePath.length - b.relativePath.length
    || (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
}

export function rankPaths(
  rawQuery: string,
  paths: readonly string[],
  options: { rootDir: string; limit: number },
): PathHit[] {
  const trimmed = rawQuery.trim().replace(/^\.\//, "").slice(0, MAX_QUERY_LENGTH);
  if (!trimmed || options.limit <= 0) return [];
  const caseSensitive = trimmed !== trimmed.toLowerCase();
  const query = caseSensitive ? trimmed : trimmed.toLowerCase();

  // Keep only the best `limit`, in order: sorting every match of a one-letter query is the slow part.
  const best: PathHit[] = [];
  for (const item of candidatesFor(paths, options.rootDir, query, caseSensitive)) {
    const hit = scoreItem(item, query, caseSensitive);
    if (!hit) continue;
    if (best.length === options.limit && compareHits(hit, best[best.length - 1]) >= 0) continue;
    let low = 0;
    let high = best.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (compareHits(best[mid], hit) <= 0) low = mid + 1;
      else high = mid;
    }
    best.splice(low, 0, hit);
    if (best.length > options.limit) best.pop();
  }
  return best;
}
