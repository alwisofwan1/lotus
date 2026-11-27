import { readFileSync } from "node:fs";

/** Offer only models listed in the current account's CLI cache to avoid unsupported launches. */
export interface ModelOption {
  slug: string;
  displayName: string;
}

interface CacheEntry {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

/**
 * Parses a `models_cache.json` payload into the selectable models: only those
 * codex itself lists (`visibility === "list"`, mirroring its own picker),
 * ordered best-first by `priority`. Returns `[]` on any malformed input.
 */
export function parseCodexModelsCache(raw: string): ModelOption[] {
  let models: unknown;
  try {
    models = (JSON.parse(raw) as { models?: unknown }).models;
  } catch {
    return [];
  }
  if (!Array.isArray(models)) return [];

  return models
    .filter((m): m is CacheEntry => typeof m === "object" && m !== null)
    .filter((m) => m.visibility === "list" && typeof m.slug === "string")
    .sort((a, b) => priorityOf(a) - priorityOf(b))
    .map((m) => ({
      slug: m.slug as string,
      displayName: typeof m.display_name === "string" ? m.display_name : (m.slug as string),
    }));
}

function priorityOf(m: CacheEntry): number {
  return typeof m.priority === "number" ? m.priority : Number.MAX_SAFE_INTEGER;
}

/**
 * Picks the model to send for a codex turn: the user's selection when still
 * offered, else the top (best) model, else `undefined` so codex falls back to
 * its own default (only when the catalog is unavailable).
 */
export function resolveCodexModel(models: ModelOption[], selected: string | undefined): string | undefined {
  if (selected && models.some((m) => m.slug === selected)) return selected;
  return models[0]?.slug;
}

/** File-backed catalog. Reads the codex model cache lazily on each `list()`. */
export class CodexModelCatalog {
  constructor(private readonly cachePath: string) {}

  list(): ModelOption[] {
    try {
      return parseCodexModelsCache(readFileSync(this.cachePath, "utf8"));
    } catch {
      return [];
    }
  }
}
