"use client";
/**
 * The app-wide Name Pool setting (plans/agent-naming, ADR-0068). One store for Canvas, Code and
 * Chat: which pool new Agent Handles are drawn from, plus the user's own pools. The pools themselves
 * and the drawing logic stay in the pure `@/lib/agent-catalog/name-pool` leaf.
 */
import { useSyncExternalStore } from "react";
import { resolveNamePool, validateAgentName } from "@/lib/agent-catalog/name-pool";

/** Built-in pools, in menu order. "auto" follows the device language. */
export const BUILT_IN_NAME_POOLS = [
  { id: "en", label: "Neutral / modern" },
  { id: "ja", label: "日本語 (Japanese)" },
  { id: "id", label: "Bahasa Indonesia" },
] as const;

export type CustomNamePool = { id: string; label: string; names: string[] };
export type AgentNamingSettings = {
  /** "auto", a built-in pool id, or a {@link CustomNamePool} id. */
  active: string;
  customPools: CustomNamePool[];
};

const STORAGE_KEY = "agent-naming-v1";
/** Where "Naming language" lived before this module; read once to carry the choice over. */
const LEGACY_CANVAS_KEY = "canvas-behavior-settings-v1";
/** A user pool needs this many names before it can be used (PLAN decision 3). */
export const MIN_POOL_NAMES = 5;
const DEFAULT_SETTINGS: AgentNamingSettings = { active: "auto", customPools: [] };

let state: AgentNamingSettings = DEFAULT_SETTINGS;
let hydrated = false;
const listeners = new Set<() => void>();

function isBuiltIn(id: string): boolean {
  return BUILT_IN_NAME_POOLS.some((p) => p.id === id);
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function sanitizePools(value: unknown): CustomNamePool[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((p) =>
    p && typeof p.id === "string" && typeof p.label === "string" && Array.isArray(p.names)
      ? [{ id: p.id, label: p.label, names: p.names.filter((n: unknown): n is string => typeof n === "string") }]
      : [],
  );
}

/** An active id that no longer names a pool (deleted, tampered) falls back to "auto". */
function sanitize(value: Partial<AgentNamingSettings> | null): AgentNamingSettings {
  const customPools = sanitizePools(value?.customPools);
  const active = typeof value?.active === "string" ? value.active : "auto";
  const known = active === "auto" || isBuiltIn(active) || customPools.some((p) => p.id === active);
  return { active: known ? active : "auto", customPools };
}

function load(): AgentNamingSettings {
  const stored = readJson(STORAGE_KEY);
  if (stored && typeof stored === "object") return sanitize(stored as Partial<AgentNamingSettings>);
  const legacy = (readJson(LEGACY_CANVAS_KEY) as { agentNameLocale?: unknown } | null)?.agentNameLocale;
  const migrated = sanitize({ active: typeof legacy === "string" ? legacy : "auto" });
  persist(migrated);
  return migrated;
}

function persist(next: AgentNamingSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
}

function hydrateOnce() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  state = load();
}

// Hydrate (and migrate) at import: the Canvas store drops the legacy `agentNameLocale` on its next
// write, so waiting for the first spawn could lose the user's old choice.
hydrateOnce();

export function getAgentNamingSettings(): AgentNamingSettings {
  hydrateOnce();
  return state;
}

export function setAgentNamingSettings(next: AgentNamingSettings) {
  hydrateOnce();
  state = sanitize(next);
  persist(state);
  listeners.forEach((l) => l());
}

export function setActiveNamePool(id: string) {
  setAgentNamingSettings({ ...getAgentNamingSettings(), active: id });
}

/** Adds or replaces a user pool (matched by id). */
export function saveCustomPool(pool: CustomNamePool) {
  const { active, customPools } = getAgentNamingSettings();
  const exists = customPools.some((p) => p.id === pool.id);
  setAgentNamingSettings({
    active,
    customPools: exists ? customPools.map((p) => (p.id === pool.id ? pool : p)) : [...customPools, pool],
  });
}

/** Removes a user pool; if it was active, the active pool falls back to "auto" (via sanitize). */
export function deleteCustomPool(id: string) {
  const { active, customPools } = getAgentNamingSettings();
  setAgentNamingSettings({ active, customPools: customPools.filter((p) => p.id !== id) });
}

export type NameRejection = { name: string; reason: "invalid-char" | "too-long" };

/**
 * Adds pasted or typed names (split on new lines and commas) to `names`. Each name must pass
 * {@link validateAgentName}; a duplicate is dropped quietly, any other failure is reported (the last
 * one wins, the rest are still added).
 */
export function addPoolNames(names: readonly string[], raw: string): { names: string[]; rejected: NameRejection | null } {
  const out = [...names];
  let rejected: NameRejection | null = null;
  for (const part of raw.split(/[\n,]/)) {
    const name = part.trim();
    if (!name) continue;
    const check = validateAgentName(name, out);
    if (check.ok) out.push(name);
    else if (check.reason === "invalid-char" || check.reason === "too-long") rejected = { name, reason: check.reason };
  }
  return { names: out, rejected };
}

/**
 * Changes the name at `index`. An empty value removes it; a duplicate or bad value keeps the old
 * name (a bad value is reported, a duplicate is dropped quietly, like {@link addPoolNames}).
 */
export function replacePoolName(
  names: readonly string[],
  index: number,
  raw: string,
): { names: string[]; rejected: NameRejection | null } {
  const name = raw.trim();
  if (!name) return { names: names.filter((_, i) => i !== index), rejected: null };
  const check = validateAgentName(name, names.filter((_, i) => i !== index));
  if (check.ok) return { names: names.map((n, i) => (i === index ? name : n)), rejected: null };
  const rejected = check.reason === "invalid-char" || check.reason === "too-long" ? { name, reason: check.reason } : null;
  return { names: [...names], rejected };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAgentNamingSettings(): AgentNamingSettings {
  return useSyncExternalStore(subscribe, getAgentNamingSettings, () => DEFAULT_SETTINGS);
}

/**
 * The names behind a pool id ("auto" → device language). A user pool under {@link MIN_POOL_NAMES}
 * names (mid-edit) stays selected but draws from "auto" until it is full again.
 */
export function namesForPool(id: string, settings: AgentNamingSettings = getAgentNamingSettings()): readonly string[] {
  const custom = settings.customPools.find((p) => p.id === id);
  if (custom && custom.names.length >= MIN_POOL_NAMES) return custom.names;
  if (custom || id === "auto") return resolveNamePool(typeof navigator !== "undefined" ? navigator.language : "");
  return resolveNamePool(id);
}

/**
 * The pool every spawn path in every mode draws a new Agent Handle from. Callers shuffle it
 * themselves (see `shuffled`); this stays deterministic.
 */
export function currentNamePool(): readonly string[] {
  const settings = getAgentNamingSettings();
  return namesForPool(settings.active, settings);
}

/** Test-only: forget the hydrated store so suites don't leak into each other. */
export function resetAgentNamingStoreForTests() {
  state = DEFAULT_SETTINGS;
  hydrated = false;
  listeners.clear();
}
