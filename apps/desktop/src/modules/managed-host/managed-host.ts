/**
 * Managed Host: the Lotus host installed on an SSH machine by the app, kept at the app's version.
 * Decisions: plans/managed-host/PLAN.md. Mockup: mockups/managed-host.html.
 *
 * One store per app window. The machines Lotus has seen, and "Don't ask again", live in
 * `~/.claude/settings.json` under `codespace.managedHosts`; "Not now" lives until the app quits.
 */
import { useSyncExternalStore } from "react";
import { getSettings, saveSettings } from "@/lib/tauri-api";
import { isTauri } from "@/lib/tauri/runtime";
import { managedHostStatus, managedHostStep, type HostTarget, type ManagedHostStatus, type ManagedHostStep } from "@/lib/tauri/managed-host";
import { emitLotusSettingsChanged } from "@/modules/settings/services/settings-events";

export type { HostTarget, ManagedHostStatus };

export const INSTALL_STEPS = ["download", "check", "install", "start", "health"] as const satisfies readonly ManagedHostStep[];
export const STEP_LABELS: Record<(typeof INSTALL_STEPS)[number], string> = {
  download: "Download",
  check: "Check",
  install: "Install",
  start: "Start",
  health: "Health",
};

/** A dev build has no release to install. This key lets a developer name one to test against. */
const DEV_VERSION_KEY = "lotus:managed-host-dev-version";

export interface HostEntry {
  target: HostTarget;
  status: ManagedHostStatus | null;
  probing: boolean;
  /** The step running now, while an install, update or removal is under way. */
  step: ManagedHostStep | null;
  /** Steps finished in the current run, for the progress line. */
  done: ManagedHostStep[];
  /** What went wrong last time, with the machine's log. Cleared by the next run. */
  failure: string | null;
  /** "Not now": no banner for this machine until the app quits. */
  notNow: boolean;
  dontAsk: boolean;
}

interface State {
  appVersion: string | null;
  hosts: Record<string, HostEntry>;
}

let state: State = { appVersion: null, hosts: {} };
const listeners = new Set<() => void>();
let loaded: Promise<void> | null = null;

function set(next: State): void {
  state = next;
  for (const fn of listeners) fn();
}

function patch(key: string, change: Partial<HostEntry>): void {
  const entry = state.hosts[key];
  if (entry) set({ ...state, hosts: { ...state.hosts, [key]: { ...entry, ...change } } });
}

export function hostKey(t: HostTarget): string {
  return `${t.user ? `${t.user}@` : ""}${t.host}${t.port ? `:${t.port}` : ""}`;
}

/** -1, 0 or 1 for two `x.y.z` versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** What the banner offers for a machine, if anything. Never a downgrade, never on a manual host. */
export function offerFor(status: ManagedHostStatus | null, appVersion: string | null): "install" | "update" | null {
  if (!status || !appVersion || !status.arch) return null;
  if (status.kind === "none") return "install";
  if (status.kind === "managed" && status.version && compareVersions(status.version, appVersion) < 0) return "update";
  return null;
}

function devVersion(): string | null {
  try {
    const v = localStorage.getItem(DEV_VERSION_KEY);
    return v && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function managedHostEnabled(): boolean {
  return isTauri() && (process.env.NODE_ENV === "production" || devVersion() !== null);
}

type Saved = Record<string, HostTarget & { dontAsk?: boolean }>;

function readSaved(settings: unknown): Saved {
  const codespace = (settings as { codespace?: { managedHosts?: unknown } } | null)?.codespace;
  const saved = codespace?.managedHosts;
  return saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Saved) : {};
}

async function writeSaved(change: (saved: Saved) => Saved): Promise<void> {
  const current = ((await getSettings()) ?? {}) as Record<string, unknown>;
  const codespace = current.codespace && typeof current.codespace === "object" ? (current.codespace as Record<string, unknown>) : {};
  const next = { ...current, codespace: { ...codespace, managedHosts: change(readSaved(current)) } };
  await saveSettings(next);
  emitLotusSettingsChanged(next);
}

function entryFor(target: HostTarget, dontAsk = false): HostEntry {
  return { target, status: null, probing: false, step: null, done: [], failure: null, notNow: false, dontAsk };
}

/** The app version and the saved machines, once per window. */
export function loadManagedHosts(): Promise<void> {
  loaded ??= (async () => {
    const version = process.env.NODE_ENV === "production"
      ? await import("@tauri-apps/api/app").then((m) => m.getVersion()).catch(() => null)
      : devVersion();
    const saved = readSaved(await getSettings().catch(() => null));
    const hosts = { ...state.hosts };
    for (const [key, s] of Object.entries(saved)) {
      hosts[key] ??= entryFor({ host: s.host, user: s.user, port: s.port }, Boolean(s.dontAsk));
    }
    set({ appVersion: version, hosts });
  })();
  return loaded;
}

/**
 * Ask a machine about its host, at most once per window unless `again`. Remembers the machine for
 * Settings, and starts a Managed Host that is installed but stopped: the user already said yes.
 */
export async function probeHost(target: HostTarget, again = false): Promise<void> {
  if (!managedHostEnabled()) return;
  await loadManagedHosts();
  const key = hostKey(target);
  const entry = state.hosts[key];
  if (entry && (entry.probing || entry.step || (entry.status && !again))) return;
  if (!entry) {
    set({ ...state, hosts: { ...state.hosts, [key]: entryFor(target) } });
    void writeSaved((saved) => ({ ...saved, [key]: { ...target, ...saved[key] } })).catch(() => undefined);
  }
  patch(key, { probing: true });
  try {
    const status = await managedHostStatus(target);
    patch(key, { status, probing: false });
    if (status.kind === "managed" && !status.running && state.appVersion) {
      await managedHostStep(target, "start", state.appVersion).catch(() => undefined);
      patch(key, { status: { ...status, running: true } });
    }
  } catch {
    // An unreachable machine is the terminal's problem to report, not this feature's.
    patch(key, { probing: false });
  }
}

/** Install or update to the app version, step by step; a failed start or health check rolls back. */
export async function installHost(target: HostTarget): Promise<void> {
  const key = hostKey(target);
  const version = state.appVersion;
  if (!version || state.hosts[key]?.step) return;
  patch(key, { step: INSTALL_STEPS[0], done: [], failure: null });
  const done: ManagedHostStep[] = [];
  for (const step of INSTALL_STEPS) {
    patch(key, { step, done: [...done] });
    try {
      await managedHostStep(target, step, version);
      done.push(step);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only once the new binary is in place is there anything to undo.
      if (step === "start" || step === "health") await managedHostStep(target, "restore", version).catch(() => undefined);
      patch(key, { step: null, done: [...done], failure: `${STEP_LABELS[step]} failed. ${message}`.trim() });
      await refresh(target);
      return;
    }
  }
  patch(key, { step: null, done: [] });
  await refresh(target);
}

export async function removeHost(target: HostTarget): Promise<void> {
  const key = hostKey(target);
  if (!state.appVersion || state.hosts[key]?.step) return;
  patch(key, { step: "remove", failure: null });
  try {
    await managedHostStep(target, "remove", state.appVersion);
    patch(key, { step: null });
  } catch (error) {
    patch(key, { step: null, failure: error instanceof Error ? error.message : String(error) });
  }
  await refresh(target);
}

async function refresh(target: HostTarget): Promise<void> {
  const status = await managedHostStatus(target).catch(() => null);
  if (status) patch(hostKey(target), { status });
}

export function notNow(target: HostTarget): void {
  patch(hostKey(target), { notNow: true });
}

export function clearFailure(target: HostTarget): void {
  patch(hostKey(target), { failure: null });
}

export function dontAskAgain(target: HostTarget): void {
  const key = hostKey(target);
  patch(key, { dontAsk: true });
  void writeSaved((saved) => ({ ...saved, [key]: { ...target, ...saved[key], dontAsk: true } })).catch(() => undefined);
}

/** Copied for a host installed by hand: fetch the matching release and run its own installer. */
export function manualUpdateCommand(status: ManagedHostStatus, version: string): string {
  const url = `https://github.com/alwisofwan1/lotus/releases/download/v${version}/lotus-host-linux-${status.arch ?? "x64"}`;
  return `curl -fsSLo /tmp/lotus-host ${url} && bash ~/lotus-deploy/install.sh --binary /tmp/lotus-host`;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function managedHostsSnapshot(): State {
  return state;
}

export function useManagedHosts(): State {
  return useSyncExternalStore(subscribe, managedHostsSnapshot, managedHostsSnapshot);
}

/** Tests only. */
export function resetManagedHostsForTest(): void {
  state = { appVersion: null, hosts: {} };
  loaded = null;
}
