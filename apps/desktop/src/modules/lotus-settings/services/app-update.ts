/**
 * Lotus self-update (plans/app-updates, Phase 2), behaving like bb's desktop updater: check, then
 * download in the background without asking, then offer one "Restart to update".
 *
 * The feed is `latest.json` on the public `alwisofwan1/lotus` repo (tauri.conf.json →
 * plugins.updater), signed with the key in ~/.lotus-dev/updater. Dev builds never check: they would
 * compare against a release they are not, and an install would replace the dev binary.
 */
import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/tauri/runtime";
import type { Update } from "@tauri-apps/plugin-updater";

export type AppUpdatePhase = "idle" | "checking" | "downloading" | "ready" | "installing" | "error";

export interface AppUpdateSnapshot {
  enabled: boolean;
  phase: AppUpdatePhase;
  /** Version offered by the feed, once one is newer than this build. */
  version: string | null;
  /** 0..1 while downloading, when the server sent a length. */
  progress: number | null;
  /** Feed `notes`: the release title, a blank line, then the markdown body (release-macos.mjs). */
  notes: string | null;
  /** Feed `pub_date`, as the updater plugin formats it. */
  date: string | null;
  error: string | null;
  checkedAt: number | null;
}

const ENABLED = isTauri() && process.env.NODE_ENV === "production";

let snapshot: AppUpdateSnapshot = { enabled: ENABLED, phase: "idle", version: null, notes: null, date: null, progress: null, error: null, checkedAt: null };
let pending: Update | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<AppUpdateSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
}

export function useAppUpdate(): AppUpdateSnapshot {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** Check the feed; a newer build starts downloading right away. A failed check keeps a ready update. */
export async function checkAppUpdate(): Promise<void> {
  if (!snapshot.enabled || snapshot.phase === "checking" || snapshot.phase === "downloading" || snapshot.phase === "installing") return;
  if (snapshot.phase === "ready") return;
  set({ phase: "checking", error: null });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    set({ checkedAt: Date.now() });
    if (!update) {
      set({ phase: "idle", version: null, notes: null, date: null });
      return;
    }
    pending = update;
    set({ phase: "downloading", version: update.version, notes: update.body?.trim() || null, date: update.date ?? null, progress: null });
    let total = 0;
    let received = 0;
    await update.download((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      if (event.event === "Progress") {
        received += event.data.chunkLength;
        if (total > 0) set({ progress: Math.min(1, received / total) });
      }
    });
    set({ phase: "ready", progress: 1 });
  } catch (err) {
    pending = null;
    set({ phase: "error", error: String(err), checkedAt: Date.now() });
  }
}

export function checkAppUpdateIfStale(maxAgeMs: number): void {
  if (snapshot.checkedAt === null || Date.now() - snapshot.checkedAt >= maxAgeMs) void checkAppUpdate();
}

/** Swap the bundle and relaunch. Only after a finished download. */
export async function installAppUpdate(): Promise<void> {
  if (snapshot.phase !== "ready" || !pending) return;
  set({ phase: "installing" });
  try {
    await pending.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err) {
    set({ phase: "error", error: String(err) });
  }
}

/** Test seam. */
export function resetAppUpdateForTest(next: Partial<AppUpdateSnapshot> = {}): void {
  pending = null;
  snapshot = { enabled: ENABLED, phase: "idle", version: null, notes: null, date: null, progress: null, error: null, checkedAt: null, ...next };
  listeners.forEach((l) => l());
}
