"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSettings, saveSettings } from "@/lib/tauri-api";
import { emitLotusSettingsChanged } from "@/modules/settings/services/settings-events";
import type { ClaudeSettings } from "@/modules/settings/types";

/** Long enough to coalesce a burst of clicks into one write, short enough to feel instant. */
export const SETTINGS_SAVE_DEBOUNCE_MS = 400;
const SAVED_SIGN_MS = 2000;

// One queue for every section: writes run one after another, so each re-reads a file that already
// holds the previous write — two sections saving at once never drop each other's change.
let writeQueue: Promise<void> = Promise.resolve();

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * The one way a Lotus Settings section saves to `~/.claude/settings.json` (ADR-0054): each change
 * is a patch of the fields it touched, written after a short debounce — no Save button.
 *
 * `save_settings` replaces the whole file, and other writers share it (hook installers, the Claude
 * CLI), so the file is re-read right before each write and only the pending
 * fields are laid over it. A section never writes back keys it merely loaded.
 *
 * Only keys whose value actually changed count, because some sections hand over the whole object
 * (`withFeatureFlag(settings, …)`). `{ hold: true }` keeps a change local until `commit()` — how a
 * text field saves on blur instead of per keystroke (see `SettingsFileSection`).
 *
 * A failed write keeps the new value on screen and reports `error`, so the user can retry by
 * changing it again.
 */
export function useSettingsFile() {
  const [settings, setSettings] = useState<ClaudeSettings | null>(null);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  // The values on screen, current within the same event — what a patch is compared against.
  const latest = useRef<ClaudeSettings>({});
  const pending = useRef<Partial<ClaudeSettings>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    getSettings()
      // A change made before the first read lands stays on top of it.
      .then((data) => {
        if (!live) return;
        latest.current = { ...(data as ClaudeSettings), ...latest.current };
        setSettings(latest.current);
      })
      .catch((error) => {
        // No controls without the file: a default shown as the current value would be a lie.
        if (live) setState({ kind: "error", message: `Could not read settings.json: ${errorMessage(error)}` });
      });
    return () => { live = false; };
  }, []);

  const flush = useCallback(() => {
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;
    setState({ kind: "saving" });
    writeQueue = writeQueue.then(async () => {
      try {
        const next = { ...((await getSettings()) as ClaudeSettings), ...patch };
        await saveSettings(next as Record<string, unknown>);
        emitLotusSettingsChanged(next as Record<string, unknown>);
        // A newer change is already on its way: its own write will report. A held one is not
        // being saved yet, so this write's "Saved" stands.
        if (!timer.current) setState({ kind: "saved" });
      } catch (error) {
        // Back in line under anything newer, so the next change retries it.
        pending.current = { ...patch, ...pending.current };
        setState({ kind: "error", message: `Not saved: ${errorMessage(error)}` });
      }
    });
  }, []);

  const update = useCallback((patch: Partial<ClaudeSettings>, options: { hold?: boolean } = {}) => {
    const current = latest.current as Record<string, unknown>;
    const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => current[key] !== value));
    if (Object.keys(changed).length === 0) return;
    latest.current = { ...latest.current, ...changed };
    setSettings(latest.current);
    pending.current = { ...pending.current, ...changed };
    if (timer.current) clearTimeout(timer.current);
    timer.current = options.hold ? null : setTimeout(flush, SETTINGS_SAVE_DEBOUNCE_MS);
  }, [flush]);

  /** Write held or debounced changes now. */
  const commit = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    flush();
  }, [flush]);

  // Closing settings inside the debounce window, or mid-typing, must not drop the change.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    flush();
  }, [flush]);

  useEffect(() => {
    if (state.kind !== "saved") return;
    const id = setTimeout(() => setState({ kind: "idle" }), SAVED_SIGN_MS);
    return () => clearTimeout(id);
  }, [state]);

  return { settings, update, commit, state };
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
