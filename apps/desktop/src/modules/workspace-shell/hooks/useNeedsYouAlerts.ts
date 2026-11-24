/**
 * Needs you outside the window (GLOSSARY "Needs you", plans/needs-you-inbox Q4, Q7):
 * - the Dock icon counts the Waiting group;
 * - a new Waiting (default on) or Done (default off) item posts a macOS notification, only while
 *   Lotus is not the front window. Clicking a notification only focuses the app, so a window that
 *   gains focus soon after opens the item it named — the same bargain Automation's Ask makes.
 */
import { useEffect, useRef } from "react";
import { getSettings } from "@/lib/tauri-api";
import { isTauri } from "@/lib/tauri/runtime";
import { LOTUS_SETTINGS_CHANGED_EVENT, readLotusSettingsChangedDetail } from "@/modules/settings/services/settings-events";
import type { JumpItem, JumpTarget } from "../services/jump-items";

/** A focus later than this after the notification is the user doing something else. */
const FOLLOW_WINDOW_MS = 10 * 60_000;

export interface NeedsYouAlertSettings {
  needsInput: boolean;
  done: boolean;
}

export function readNeedsYouAlertSettings(settings: unknown): NeedsYouAlertSettings {
  const raw = (settings as { codespace?: { needsYouAlerts?: Partial<NeedsYouAlertSettings> } } | null)?.codespace?.needsYouAlerts;
  return { needsInput: raw?.needsInput !== false, done: raw?.done === true };
}

/** The items that just joined Needs you and should be announced; pure, for the test. */
export function newNeedsYouAlerts(
  before: ReadonlySet<string>,
  items: readonly JumpItem[],
  settings: NeedsYouAlertSettings,
): JumpItem[] {
  return items.filter(
    (item) => !before.has(item.id) && ((item.status === "waiting" && settings.needsInput) || (item.status === "done" && settings.done)),
  );
}

export function useNeedsYouAlerts({
  waiting,
  signature,
  readItems,
  onOpen,
}: {
  /** The Waiting count, for the Dock. */
  waiting: number;
  /** Changes whenever Needs you may have changed; the items are read only then. */
  signature: string;
  readItems: () => JumpItem[];
  onOpen: (target: JumpTarget) => void;
}) {
  const settings = useRef<NeedsYouAlertSettings>({ needsInput: true, done: false });
  const known = useRef<Set<string> | null>(null);
  const pending = useRef<{ target: JumpTarget; at: number } | null>(null);
  const latest = useRef({ readItems, onOpen });
  useEffect(() => {
    latest.current = { readItems, onOpen };
  });

  useEffect(() => {
    if (!isTauri()) return;
    void getSettings().then((s) => (settings.current = readNeedsYouAlertSettings(s))).catch(() => undefined);
    const onChange = (event: Event) => {
      const detail = readLotusSettingsChangedDetail(event);
      if (detail) settings.current = readNeedsYouAlertSettings(detail.settings);
    };
    const onFocus = () => {
      const follow = pending.current;
      pending.current = null;
      if (follow && Date.now() - follow.at < FOLLOW_WINDOW_MS) latest.current.onOpen(follow.target);
    };
    window.addEventListener(LOTUS_SETTINGS_CHANGED_EVENT, onChange);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener(LOTUS_SETTINGS_CHANGED_EVENT, onChange);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setBadgeCount(waiting > 0 ? waiting : undefined))
      .catch(() => undefined);
  }, [waiting]);

  useEffect(() => {
    if (!isTauri()) return;
    const items = latest.current.readItems().filter((item) => item.status === "waiting" || item.status === "done");
    const before = known.current;
    known.current = new Set(items.map((item) => item.id));
    // The first read is what was already there when the window opened: nothing new to announce.
    if (!before || document.hasFocus()) return;
    const fresh = newNeedsYouAlerts(before, items, settings.current);
    if (fresh.length === 0) return;
    const first = fresh[0]!;
    const title = fresh.length > 1 ? `${fresh.length} agents need you` : `${first.title} ${first.status === "done" ? "finished" : "needs you"}`;
    const body = first.detail ?? first.location;
    pending.current = { target: first.target, at: Date.now() };
    void import("@tauri-apps/plugin-notification")
      .then(async ({ isPermissionGranted, requestPermission, sendNotification }) => {
        if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return;
        sendNotification({ title, body });
      })
      .catch(() => undefined);
  }, [signature]);
}
