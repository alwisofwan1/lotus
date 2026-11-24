import type { SessionInfo } from "@/lib/tauri-api";

type CloseRequestEvent = {
  preventDefault: () => void;
};

export type RecentPaneCloseRequestSuppressor = {
  recordPaneCloseShortcut(): void;
  shouldSuppressCloseRequest(): boolean;
};

type RecentPaneCloseRequestSuppressorOptions = {
  now?: () => number;
  windowMs?: number;
};

export function createRecentPaneCloseRequestSuppressor({
  now = () => Date.now(),
  windowMs = 1000,
}: RecentPaneCloseRequestSuppressorOptions = {}): RecentPaneCloseRequestSuppressor {
  let lastPaneCloseShortcutAt = -Infinity;
  return {
    recordPaneCloseShortcut() {
      lastPaneCloseShortcutAt = now();
    },
    shouldSuppressCloseRequest() {
      const age = now() - lastPaneCloseShortcutAt;
      const shouldSuppress = age >= 0 && age <= windowMs;
      lastPaneCloseShortcutAt = -Infinity;
      return shouldSuppress;
    },
  };
}

type ShutdownPolicyDeps = {
  listSessions: () => Promise<SessionInfo[]>;
  killSession: (sessionId: string) => Promise<void>;
  confirm: (message: string, options: { title: string; kind: "warning" }) => Promise<boolean>;
  clearCodeSpaceSnapshot?: () => Promise<void>;
  closeWindow: () => Promise<void>;
  isCloseAllowed: () => boolean;
  allowClose: () => void;
  shouldSuppressCloseRequest?: () => boolean;
  /** Editor files with unsaved edits in this window; they are lost when it closes. */
  countUnsavedFiles?: () => number;
  /** The user chose to lose them: their hot-exit copies go too, or the next start brings them back. */
  discardUnsavedFiles?: () => Promise<void>;
};

export function formatTerminalShutdownConfirmation(sessionCount: number): string {
  const noun = sessionCount === 1 ? "terminal session is" : "terminal sessions are";
  return `${sessionCount} ${noun} still running in this window. Close it and terminate them?`;
}

/** One question for everything closing the window would lose: unsaved files, running terminals. */
export function formatCloseConfirmation(sessionCount: number, unsavedCount: number): string {
  if (unsavedCount === 0) return formatTerminalShutdownConfirmation(sessionCount);
  const files = unsavedCount === 1 ? "1 file has" : `${unsavedCount} files have`;
  const terminals = sessionCount === 0
    ? ""
    : ` ${sessionCount} ${sessionCount === 1 ? "terminal session is" : "terminal sessions are"} also still running.`;
  return `${files} unsaved changes in this window.${terminals} Close it and lose the changes?`;
}

async function discardUnsavedBestEffort(deps: ShutdownPolicyDeps, unsaved: number): Promise<void> {
  if (unsaved === 0) return;
  try {
    await deps.discardUnsavedFiles?.();
  } catch (error) {
    console.warn("[editor] failed to drop the unsaved-file backups before close:", error);
  }
}

async function clearSnapshotBestEffort(clearCodeSpaceSnapshot?: () => Promise<void>): Promise<void> {
  try {
    await clearCodeSpaceSnapshot?.();
  } catch (error) {
    console.warn("[codespace] failed to clear persisted snapshot before close:", error);
  }
}

export async function terminatePtySessions(
  sessions: SessionInfo[],
  killSession: (sessionId: string) => Promise<void>,
): Promise<void> {
  await Promise.allSettled(sessions.map((session) => killSession(session.id)));
}

export async function handleTerminalShutdownCloseRequest(
  event: CloseRequestEvent,
  deps: ShutdownPolicyDeps,
): Promise<void> {
  if (deps.isCloseAllowed()) return;

  event.preventDefault();

  if (deps.shouldSuppressCloseRequest?.()) return;



  const unsaved = deps.countUnsavedFiles?.() ?? 0;
  let sessions: SessionInfo[] = [];
  try {
    sessions = await deps.listSessions();
  } catch (error) {
    console.warn("[codespace] failed to inspect terminal sessions before close:", error);
    if (unsaved > 0 && !(await deps.confirm(formatCloseConfirmation(0, unsaved), {
      title: "Discard unsaved changes?",
      kind: "warning",
    }))) return;
    await discardUnsavedBestEffort(deps, unsaved);
    deps.allowClose();
    await deps.closeWindow();
    return;
  }

  if (sessions.length === 0 && unsaved === 0) {
    await clearSnapshotBestEffort(deps.clearCodeSpaceSnapshot);
    deps.allowClose();
    await deps.closeWindow();
    return;
  }

  const confirmed = await deps.confirm(formatCloseConfirmation(sessions.length, unsaved), {
    title: unsaved > 0 ? "Discard unsaved changes?" : "Close window?",
    kind: "warning",
  });
  if (!confirmed) return;

  await terminatePtySessions(sessions, deps.killSession);
  await discardUnsavedBestEffort(deps, unsaved);
  await clearSnapshotBestEffort(deps.clearCodeSpaceSnapshot);
  deps.allowClose();
  await deps.closeWindow();
}
