/**
 * Files opened in an Editor pane, per workspace (machine + folder), newest first.
 *
 * Kept in localStorage: it is a per-device convenience, and losing it costs nothing. Every read
 * and write survives a missing or full storage.
 */

export type RecentFile = { path: string; at: number };

const STORAGE_PREFIX = "lotus:editor-recent:v1:";
const MAX_KEPT = 24;

function storageKey(workspaceKey: string): string {
  return `${STORAGE_PREFIX}${workspaceKey}`;
}

function read(workspaceKey: string): RecentFile[] {
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RecentFile =>
      typeof entry?.path === "string" && typeof entry?.at === "number");
  } catch {
    return [];
  }
}

function write(workspaceKey: string, files: RecentFile[]): void {
  try {
    window.localStorage.setItem(storageKey(workspaceKey), JSON.stringify(files.slice(0, MAX_KEPT)));
  } catch {
    // Private mode or a full disk: recent files are only a convenience.
  }
}

function isAtOrUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base.replace(/\/+$/, "")}/`);
}

export function listRecentFiles(workspaceKey: string): RecentFile[] {
  return read(workspaceKey).sort((left, right) => right.at - left.at);
}

export function recordRecentFile(workspaceKey: string, path: string, at = Date.now()): void {
  write(workspaceKey, [{ path, at }, ...listRecentFiles(workspaceKey).filter((entry) => entry.path !== path)]);
}

/** After a delete: the file, or every file under the folder. */
export function forgetRecentFiles(workspaceKey: string, path: string): void {
  const kept = listRecentFiles(workspaceKey).filter((entry) => !isAtOrUnder(entry.path, path));
  write(workspaceKey, kept);
}

/** After a rename: the file, or every file under the folder, keeps its place under the new name. */
export function moveRecentFiles(workspaceKey: string, from: string, to: string): void {
  const base = from.replace(/\/+$/, "");
  write(workspaceKey, listRecentFiles(workspaceKey).map((entry) =>
    isAtOrUnder(entry.path, base) ? { ...entry, path: `${to}${entry.path.slice(base.length)}` } : entry));
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "now", "14 min", "3 h" (today), "yesterday", "4 d", "8 w". */
export function formatRecentAge(at: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return "now";
  if (elapsed < 60 * MINUTE) return `${Math.floor(elapsed / MINUTE)} min`;
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days <= 0) return `${Math.floor(elapsed / (60 * MINUTE))} h`;
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} d`;
  return `${Math.floor(days / 7)} w`;
}
