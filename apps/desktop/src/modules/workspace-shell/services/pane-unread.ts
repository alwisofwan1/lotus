/**
 * Which panes finished a turn the user has not looked at yet.
 *
 * The contract is the "Kontrak notifikasi selesai" mockup (S11): a finished turn is marked until that
 * pane is opened, it never takes focus, and opening one pane never clears another. Hover is not
 * opening — the caller only calls {@link PaneUnreadStore.markRead} from a click or a keyboard focus.
 *
 * WHEN a turn is over is not decided here; that is `pane-turn-ends`. This only remembers the answer
 * against what the user was looking at when it arrived.
 *
 * Persisted (2026-11-22, user decision): a result nobody opened stays marked across a reload or a
 * restart, until that pane is opened. Pane ids are the cell ids in codespace.sqlite3, so they survive.
 * The cost: a result read elsewhere (Pocket) stays marked here until the pane is opened on desktop.
 */
export interface PaneUnreadStore {
  /**
   * A pane's turn ended. `seen` is whether the user was looking at that pane right then: focused,
   * on screen, in a window that has focus. A result watched as it landed is already read.
   */
  finished(paneId: string, options: { seen: boolean; at: number }): void;
  /** The user opened the pane — by pointer or by keyboard. */
  markRead(paneId: string): void;
  /** Drop every pane not in `paneIds`: a closed pane has nothing left to read. */
  retain(paneIds: ReadonlySet<string>): void;
  isUnread(paneId: string): boolean;
  /** When the pane first finished unread, for "Done · 2m ago". */
  since(paneId: string): number | undefined;
  /** Oldest first — the result that has waited longest is the one to reach first. */
  unreadIds(): string[];
  subscribe(listener: () => void): () => void;
  /** Monotonic, for `useSyncExternalStore`: the Map itself would tear. */
  version(): number;
}

/** Where the marks are kept between runs. Absent (tests, SSR): memory only. */
export interface PaneUnreadStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PANE_UNREAD_KEY = "lotus.code.pane-unread";

function load(storage: PaneUnreadStorage | undefined): Map<string, number> {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(PANE_UNREAD_KEY) ?? "{}");
    if (!raw || typeof raw !== "object") return new Map();
    return new Map(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return new Map();
  }
}

export function createPaneUnreadStore(storage?: PaneUnreadStorage): PaneUnreadStore {
  // paneId → when it FIRST finished unread. A second finish before a read keeps the older stamp, so
  // a busy pane cannot jump the queue ahead of one that has been waiting.
  const unread = load(storage);
  const listeners = new Set<() => void>();
  let version = 0;

  const emit = () => {
    version += 1;
    try {
      storage?.setItem(PANE_UNREAD_KEY, JSON.stringify(Object.fromEntries(unread)));
    } catch {
      // A full or blocked storage only costs the marks their life past this run.
    }
    for (const listener of listeners) listener();
  };

  return {
    finished(paneId, { seen, at }) {
      if (seen || unread.has(paneId)) return;
      unread.set(paneId, at);
      emit();
    },
    markRead(paneId) {
      if (unread.delete(paneId)) emit();
    },
    retain(paneIds) {
      let changed = false;
      for (const paneId of [...unread.keys()]) {
        if (paneIds.has(paneId)) continue;
        unread.delete(paneId);
        changed = true;
      }
      if (changed) emit();
    },
    isUnread(paneId) {
      return unread.has(paneId);
    },
    since(paneId) {
      return unread.get(paneId);
    },
    unreadIds() {
      return [...unread.entries()].sort((left, right) => left[1] - right[1]).map(([paneId]) => paneId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version() {
      return version;
    },
  };
}
