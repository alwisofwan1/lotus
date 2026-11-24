import { isTauri } from "@/lib/tauri/runtime";
import {
  codecanvasDeleteSession,
  codecanvasListSessions,
  codecanvasUpsertSession,
} from "@/lib/tauri/codecanvas";
import type { CanvasSessionRecord } from "./session-record";

/**
 * Durable store for agent sessions (`plans/codecanvas-session-widget/`, Slice 01).
 *
 * The seam mirrors `agent-run-store.ts`: SQLite in the desktop app, an in-memory twin everywhere
 * else, and the interface is what the tests talk to.
 */
export interface CanvasSessionStore {
  /** Sessions recorded for a project, most recently active first. */
  list(projectId: string): Promise<CanvasSessionRecord[]>;
  /**
   * Insert or update one session.
   *
   * Rejects when `providerSessionId` is already claimed by another session in the same project.
   * That rejection is load-bearing, not an edge case: session ids are captured by diffing the CLI's
   * transcript directory, so two agents launched in the same cwd can both pick up the same fresh id.
   * Callers must treat a rejected write as "someone else owns this id", not as a lost write
   * (issue 07).
   */
  upsert(session: CanvasSessionRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

/** SQLite-backed store (production) — survives app restart and project close. */
export function createTauriCanvasSessionStore(): CanvasSessionStore {
  return {
    list: (projectId) => codecanvasListSessions(projectId),
    upsert: (session) => codecanvasUpsertSession(session),
    remove: (id) => codecanvasDeleteSession(id),
  };
}

/** Process-lifetime store for tests and the browser dev server. Enforces the same uniqueness. */
export function createInMemoryCanvasSessionStore(): CanvasSessionStore {
  const byId = new Map<string, CanvasSessionRecord>();

  return {
    async list(projectId) {
      return Array.from(byId.values())
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
        .map((s) => ({ ...s }));
    },
    async upsert(session) {
      const provider = session.providerSessionId;
      if (provider) {
        const claimedByAnother = Array.from(byId.values()).some(
          (s) => s.id !== session.id && s.projectId === session.projectId && s.providerSessionId === provider,
        );
        if (claimedByAnother) {
          throw new Error(`session id ${provider} is already claimed in project ${session.projectId}`);
        }
      }
      byId.set(session.id, { ...session });
    },
    async remove(id) {
      byId.delete(id);
    },
  };
}

/** Process-wide store — SQLite in the desktop app, volatile in browser/tests. */
export const canvasSessionStore: CanvasSessionStore = isTauri()
  ? createTauriCanvasSessionStore()
  : createInMemoryCanvasSessionStore();
