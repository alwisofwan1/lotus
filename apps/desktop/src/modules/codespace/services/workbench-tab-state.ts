import { isPathTab, type DiffTabTarget, type WorkbenchTab } from "@/modules/codespace/components/types";

/**
 * The Editor pane's tab list as plain functions: one file = one tab, closing one or many, and
 * the stack ⌘⇧T reopens from. `WorkbenchCell` owns the state; these decide what it becomes.
 */

/** Files ⌘⇧T can bring back, per pane. */
export const REOPEN_STACK_LIMIT = 25;

export type TabListState = { tabs: WorkbenchTab[]; activeTabId: string | null };

export type TabCloseScope = "one" | "others" | "right";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Stable, so the same file always lands on the same tab. */
export function fileTabId(filePath: string): string {
  return `file:${normalizePath(filePath)}`;
}

/**
 * One git diff tab per file (Staged / Working tree is switched inside it), and apart from it one
 * compare of the disk copy against the unsaved edits.
 */
export function diffTabId(filePath: string, target?: DiffTabTarget): string {
  return `${target === "disk" ? "compare" : "diff"}:${normalizePath(filePath)}`;
}

/**
 * Activates the tab that already holds the file, else appends one. Matched by path, not id:
 * tabs saved before ids came from paths still carry a random one.
 *
 * A `preview` open (one click in the tree) puts a new file in the place of the preview tab, as
 * long as that one has no unsaved edits; a normal open of the file in the preview tab keeps it.
 */
export function openFileInTabs(tabs: WorkbenchTab[], filePath: string, options: { preview?: boolean } = {}): TabListState {
  const path = normalizePath(filePath);
  const existing = tabs.find((tab) => tab.kind === "file" && normalizePath(tab.filePath) === path);
  if (existing) return { tabs: options.preview ? tabs : keepTab(tabs, existing.id), activeTabId: existing.id };
  if (!options.preview) {
    const tab: WorkbenchTab = { id: fileTabId(filePath), kind: "file", filePath };
    return { tabs: [...tabs, tab], activeTabId: tab.id };
  }
  const tab: WorkbenchTab = { id: fileTabId(filePath), kind: "file", filePath, preview: true };
  const replaced = tabs.findIndex((candidate) => candidate.kind === "file" && candidate.preview && !candidate.dirty);
  if (replaced < 0) return { tabs: [...tabs, tab], activeTabId: tab.id };
  return { tabs: tabs.map((candidate, index) => (index === replaced ? tab : candidate)), activeTabId: tab.id };
}

/** A preview tab becomes a normal one: double-clicked, edited, pinned or dragged. */
export function keepTab(tabs: WorkbenchTab[], tabId: string): WorkbenchTab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  const tab = tabs[index];
  if (tab?.kind !== "file" || !tab.preview) return tabs;
  const kept = { ...tab };
  delete kept.preview;
  return tabs.map((candidate, at) => (at === index ? kept : candidate));
}

/**
 * Activates the file's diff tab, switched to `target`, else adds one right after the file's
 * editor tab (or at the end when the file is not open). `repoRoot` is the repo the file is in,
 * when that is not the pane's own.
 */
export function openDiffInTabs(
  tabs: WorkbenchTab[],
  filePath: string,
  target: DiffTabTarget,
  repoRoot?: string,
): TabListState {
  const id = diffTabId(filePath, target);
  const existing = tabs.find((tab) => tab.id === id);
  if (existing?.kind === "diff") {
    if (existing.target === target && (repoRoot === undefined || existing.repoRoot === repoRoot)) return { tabs, activeTabId: id };
    const next = { ...existing, target, ...(repoRoot === undefined ? {} : { repoRoot }) };
    return { tabs: tabs.map((tab) => (tab.id === id ? next : tab)), activeTabId: id };
  }
  const tab: WorkbenchTab = { id, kind: "diff", filePath, target, ...(repoRoot === undefined ? {} : { repoRoot }) };
  const path = normalizePath(filePath);
  const fileIndex = tabs.findIndex((candidate) => candidate.kind === "file" && normalizePath(candidate.filePath) === path);
  if (fileIndex < 0) return { tabs: [...tabs, tab], activeTabId: id };
  return { tabs: [...tabs.slice(0, fileIndex + 1), tab, ...tabs.slice(fileIndex + 1)], activeTabId: id };
}

/**
 * Shows the commit in the one unpinned commit tab, so walking the graph does not pile up tabs;
 * a pinned commit tab stays. The tab of a commit already open is reused.
 */
export function openCommitInTabs(tabs: WorkbenchTab[], repoRoot: string, sha: string, subject?: string): TabListState {
  const id = `commit:${normalizePath(repoRoot)}:${sha}`;
  if (tabs.some((tab) => tab.id === id)) return { tabs, activeTabId: id };
  const tab: WorkbenchTab = { id, kind: "commit", repoRoot, sha, ...(subject === undefined ? {} : { subject }) };
  const replaced = tabs.findIndex((candidate) => candidate.kind === "commit" && !candidate.pinned);
  if (replaced < 0) return { tabs: [...tabs, tab], activeTabId: id };
  return { tabs: tabs.map((candidate, index) => (index === replaced ? tab : candidate)), activeTabId: id };
}

export function openGraphInTabs(tabs: WorkbenchTab[], repoRoot: string): TabListState {
  const id = `graph:${normalizePath(repoRoot)}`;
  if (tabs.some((tab) => tab.id === id)) return { tabs, activeTabId: id };
  return { tabs: [...tabs, { id, kind: "graph", repoRoot }], activeTabId: id };
}

/** Tabs read live from git, so the saved workspace never keeps them. */
export function isLiveOnlyTab(tab: WorkbenchTab): boolean {
  return tab.kind === "diff" || tab.kind === "commit" || tab.kind === "graph";
}

/** What the saved workspace keeps: diff, commit and graph tabs are the pane's only. */
export function withoutDiffTabs(state: TabListState): TabListState {
  const diffIds = state.tabs.filter(isLiveOnlyTab).map((tab) => tab.id);
  if (diffIds.length === 0) return state;
  return closeTabsInList(state.tabs, state.activeTabId, diffIds);
}

/** The tabs a tab's menu item acts on. Close others and Close to the right pass pinned tabs over. */
export function tabsInCloseScope(tabs: WorkbenchTab[], tabId: string, scope: TabCloseScope): WorkbenchTab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return [];
  if (scope === "one") return [tabs[index]];
  if (scope === "others") return tabs.filter((tab) => tab.id !== tabId && !tab.pinned);
  return tabs.slice(index + 1).filter((tab) => !tab.pinned);
}

function pinnedCount(tabs: readonly WorkbenchTab[]): number {
  return tabs.filter((tab) => tab.pinned).length;
}

/** Pinned goes to the end of the pinned group, unpinned to just after it. Either way it is kept. */
export function setTabPinned(tabs: WorkbenchTab[], tabId: string, pinned: boolean): WorkbenchTab[] {
  const tab = keepTab(tabs, tabId).find((candidate) => candidate.id === tabId);
  if (!tab || Boolean(tab.pinned) === pinned) return tabs;
  const next = { ...tab };
  if (pinned) next.pinned = true;
  else delete next.pinned;
  const others = tabs.filter((candidate) => candidate.id !== tabId);
  const at = pinnedCount(others);
  return [...others.slice(0, at), next, ...others.slice(at)];
}

/**
 * Drag to reorder: `toIndex` counts in the list without the dragged tab. Kept within its own
 * group, so pinned tabs stay in front; a dragged preview tab is kept.
 */
export function moveTab(tabs: WorkbenchTab[], tabId: string, toIndex: number): WorkbenchTab[] {
  const tab = keepTab(tabs, tabId).find((candidate) => candidate.id === tabId);
  if (!tab) return tabs;
  const others = tabs.filter((candidate) => candidate.id !== tabId);
  const pinnedEnd = pinnedCount(others);
  const at = tab.pinned
    ? Math.min(Math.max(toIndex, 0), pinnedEnd)
    : Math.min(Math.max(toIndex, pinnedEnd), others.length);
  const original = tabs.find((candidate) => candidate.id === tabId);
  if (tab === original && tabs[at] === tab) return tabs;
  return [...others.slice(0, at), tab, ...others.slice(at)];
}

/**
 * Removes the tabs. When the active one goes, `preferredActiveId` wins if it survives (the tab
 * whose menu was used); otherwise the nearest survivor on its left, then the first.
 */
export function closeTabsInList(
  tabs: WorkbenchTab[],
  activeTabId: string | null,
  closingIds: Iterable<string>,
  preferredActiveId?: string,
): TabListState {
  const closing = new Set(closingIds);
  const next = tabs.filter((tab) => !closing.has(tab.id));
  if (next.length === 0) return { tabs: [], activeTabId: null };
  const survives = (id: string | null | undefined): id is string => Boolean(id) && next.some((tab) => tab.id === id);
  if (survives(activeTabId)) return { tabs: next, activeTabId };
  if (survives(preferredActiveId)) return { tabs: next, activeTabId: preferredActiveId };
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  const left = tabs.slice(0, Math.max(0, activeIndex)).reverse().find((tab) => !closing.has(tab.id));
  return { tabs: next, activeTabId: left?.id ?? next[0].id };
}

/** Newest last. A file closed again moves to the top rather than appearing twice. */
export function pushClosedFiles(stack: readonly string[], closedPaths: readonly string[]): string[] {
  const closed = new Set(closedPaths.map(normalizePath));
  return [...stack.filter((path) => !closed.has(normalizePath(path))), ...closedPaths].slice(-REOPEN_STACK_LIMIT);
}

/** Whether ⌘⇧T has anything to try. A file deleted since it closed is only found out by trying. */
export function hasReopenCandidate(stack: readonly string[], openPaths: Iterable<string>): boolean {
  const open = new Set([...openPaths].map(normalizePath));
  return stack.some((path) => !open.has(normalizePath(path)));
}

/**
 * Pops until a file that still exists and is not already open; the skipped ones are dropped,
 * since a deleted file will not come back by pressing again.
 */
export async function popReopenableFile(
  stack: readonly string[],
  exists: (path: string) => Promise<boolean>,
  openPaths: Iterable<string>,
): Promise<{ path: string | null; stack: string[] }> {
  const open = new Set([...openPaths].map(normalizePath));
  const rest = [...stack];
  while (rest.length > 0) {
    const path = rest.pop() as string;
    if (open.has(normalizePath(path))) continue;
    if (await exists(path)) return { path, stack: rest };
  }
  return { path: null, stack: rest };
}

/**
 * Tabs that share a file name, by id, with the shortest run of parent folders that tells each
 * apart from the others (`src/app` beside `lib/app`). A file's own diff tab is not a namesake.
 */
export function tabFolderHints(tabs: readonly WorkbenchTab[]): Map<string, string> {
  const byName = new Map<string, { id: string; path: string; folders: string[] }[]>();
  for (const tab of tabs) {
    if (!isPathTab(tab)) continue;
    const segments = normalizePath(tab.filePath).split("/").filter(Boolean);
    const name = segments.pop() ?? "";
    const group = byName.get(name) ?? [];
    group.push({ id: tab.id, path: normalizePath(tab.filePath), folders: segments });
    byName.set(name, group);
  }
  const hints = new Map<string, string>();
  for (const group of byName.values()) {
    for (const entry of group) {
      const namesakes = group.filter((other) => other.path !== entry.path);
      if (namesakes.length === 0) continue;
      const suffix = (folders: string[], depth: number) => folders.slice(Math.max(0, folders.length - depth)).join("/");
      let depth = 1;
      while (depth < entry.folders.length && namesakes.some((other) => suffix(other.folders, depth) === suffix(entry.folders, depth))) depth += 1;
      hints.set(entry.id, suffix(entry.folders, depth));
    }
  }
  return hints;
}

/**
 * Which tab a digit chord jumps to, 0-based, or `"last"` for 9. VS Code's: ⌃1–9 on a Mac, Alt+1–9
 * elsewhere; ⌘1–9 (Ctrl elsewhere) already jumps to a pane. `code`, as ⌥ changes the typed key.
 */
export function tabIndexShortcut(event: KeyboardEvent, platform = navigator.platform): number | "last" | null {
  const mac = /Mac|iPhone|iPad/.test(platform);
  const chord = mac
    ? event.ctrlKey && !event.metaKey && !event.altKey
    : event.altKey && !event.ctrlKey && !event.metaKey;
  if (!chord || event.shiftKey) return null;
  const digit = /^Digit([1-9])$/.exec(event.code ?? "");
  if (!digit) return null;
  return digit[1] === "9" ? "last" : Number(digit[1]) - 1;
}
