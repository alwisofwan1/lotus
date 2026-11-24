/**
 * The Workbench (the chat's right panel) as each thread left it: open or not, which tab, how wide.
 * Kept in localStorage; a thread unseen for 14 days falls back to the default.
 * See plans/chat-right-sidebar/PLAN.md (M1).
 */

export type WorkbenchTab = "changes" | "files" | "runs" | "preview" | "context";
export const WORKBENCH_TABS: readonly WorkbenchTab[] = ["changes", "files", "runs", "preview", "context"];

export interface WorkbenchState {
  open: boolean;
  tab: WorkbenchTab;
  /** A width the user dragged to, in px; null is the default (the CSS clamp). */
  width: number | null;
  /** Takes the page, leaving the chat a readable column (⇧⌘↩). */
  wide: boolean;
  /** Preview was opened here before: only the first time does it widen the panel by itself. */
  previewSeen: boolean;
  /** When this thread's entry was last written, for the TTL. */
  at: number;
}

export type Workbenches = Record<string, WorkbenchState>;

export const WORKBENCH_STORAGE_KEY = "lotus.chat.workbench.v1";
export const WORKBENCH_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const WORKBENCH_MIN_WIDTH = 320;
/** The chat column never gets narrower than this while the panel is dragged. */
export const CHAT_MIN_WIDTH = 420;

export const DEFAULT_WORKBENCH: WorkbenchState = { open: false, tab: "changes", width: null, wide: false, previewSeen: false, at: 0 };

export function workbenchOf(all: Workbenches, threadId: string | null): WorkbenchState {
  return (threadId && all[threadId]) || DEFAULT_WORKBENCH;
}

/** The thread's entry changed by `patch`, stamped `now`. */
export function patchWorkbench(all: Workbenches, threadId: string, patch: Partial<WorkbenchState>, now: number): Workbenches {
  return { ...all, [threadId]: { ...workbenchOf(all, threadId), ...patch, at: now } };
}

/** Selecting a tab opens the panel; the first Preview in a thread opens it wide. */
export function showTab(all: Workbenches, threadId: string, tab: WorkbenchTab, now: number): Workbenches {
  const current = workbenchOf(all, threadId);
  const first = tab === "preview" && !current.previewSeen;
  return patchWorkbench(all, threadId, { open: true, tab, ...(first ? { wide: true, previewSeen: true } : {}) }, now);
}

/** What was stored, without entries that are malformed or older than the TTL. */
export function parseWorkbenches(raw: string | null, now: number): Workbenches {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object") return {};
  const out: Workbenches = {};
  for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as Partial<WorkbenchState>;
    if (typeof e.at !== "number" || now - e.at > WORKBENCH_TTL_MS) continue;
    out[id] = {
      open: e.open === true,
      tab: WORKBENCH_TABS.includes(e.tab as WorkbenchTab) ? (e.tab as WorkbenchTab) : "changes",
      width: typeof e.width === "number" && Number.isFinite(e.width) ? e.width : null,
      wide: e.wide === true,
      previewSeen: e.previewSeen === true,
      at: e.at,
    };
  }
  return out;
}

/** A dragged width kept between the panel's minimum and what leaves the chat its minimum. */
export function clampWorkbenchWidth(width: number, room: number): number {
  return Math.round(Math.max(WORKBENCH_MIN_WIDTH, Math.min(width, room - CHAT_MIN_WIDTH)));
}
