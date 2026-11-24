import { useEffect, useState } from "react";
import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

/**
 * The models an agent CLI itself reports — names, order and reasoning levels straight from the
 * CLI (`src-tauri/src/agent_models.rs`), the way bb lists them. `null` = the CLI did not say, and
 * the caller falls back to `config/models/catalog.ts`.
 */
export interface LiveAgentModel {
  /** What `--model` takes. */
  value: string;
  label: string;
  description?: string;
  efforts: string[];
  defaultEffort?: string;
  /** The model a moving alias runs today (`opus` → `claude-opus-5-5`). */
  resolvesTo?: string;
}

/** bb keeps a provider's list for 10 minutes before it asks again; same here. */
const FRESH_MS = 10 * 60_000;

const cache = new Map<string, { at: number; models: LiveAgentModel[] | null }>();
const inflight = new Map<string, Promise<LiveAgentModel[] | null>>();
const listeners = new Set<() => void>();

/** ccs and csp are Claude profiles: same CLI, same list. */
function listKey(agentId: string): string {
  return agentId === "ccs" || agentId === "csp" ? "claude" : agentId;
}

export function cachedAgentModels(agentId: string): LiveAgentModel[] | null {
  return cache.get(listKey(agentId))?.models ?? null;
}

export function listAgentModels(agentId: string): Promise<LiveAgentModel[] | null> {
  const key = listKey(agentId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit.models);
  const pending = inflight.get(key);
  if (pending) return pending;
  if (!isTauri()) return Promise.resolve(null);

  const request = tauriInvoke<LiveAgentModel[] | null>("list_agent_models", { agentId: key })
    .catch(() => null)
    .then((models) => {
      // A failed ask keeps the last good list rather than wiping it.
      if (models?.length || !hit) cache.set(key, { at: Date.now(), models: models?.length ? models : null });
      inflight.delete(key);
      for (const listener of listeners) listener();
      return cachedAgentModels(key);
    });
  inflight.set(key, request);
  return request;
}

/** The label the CLI gives a model value, for list rows that show a preset without opening it. */
export function useAgentModelLabels(agentIds: readonly string[]): (agentId: string, value: string) => string | undefined {
  const [, rerender] = useState(0);
  const wanted = [...new Set(agentIds.map(listKey))].sort().join(",");
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    for (const id of wanted.split(",").filter(Boolean)) void listAgentModels(id);
    return () => {
      listeners.delete(listener);
    };
  }, [wanted]);
  return (agentId, value) => cachedAgentModels(agentId)?.find((model) => model.value === value)?.label;
}
