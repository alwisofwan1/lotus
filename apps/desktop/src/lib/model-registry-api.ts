// Tauri IPC wrappers for the model registry commands.
// Non-Tauri (browser dev mode) falls back to in-memory mock data.

import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";
import { DEFAULT_REGISTRY, MODEL_REGISTRY_CHANGED_EVENT } from "@/lib/model-registry-defaults";
import type { ActiveModel, ProviderConfig } from "@/lib/model-registry-types";

export type { ActiveModel, ModelEntry, ModelRegistry, ProviderConfig, ProviderType } from "@/lib/model-registry-types";

// ─── Mock store for non-Tauri dev mode ────────────────────────────────────────

const _mockRegistry = structuredClone(DEFAULT_REGISTRY);

function dispatchChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MODEL_REGISTRY_CHANGED_EVENT));
  }
}

// ─── API wrappers ─────────────────────────────────────────────────────────────

/** Returns all providers with API keys redacted to "***". */
export async function registryListProviders(): Promise<ProviderConfig[]> {
  if (!isTauri()) return structuredClone(_mockRegistry.providers);
  return tauriInvoke<ProviderConfig[]>("registry_list_providers");
}

/** Returns a single provider by id, or null if not found. */
export async function registryGetProvider(id: string): Promise<ProviderConfig | null> {
  if (!isTauri()) {
    return structuredClone(_mockRegistry.providers.find((p) => p.id === id) ?? null);
  }
  return tauriInvoke<ProviderConfig | null>("registry_get_provider", { id });
}

/**
 * Add or update a provider. Pass `apiKey: "***"` to preserve the existing key.
 * Dispatches `MODEL_REGISTRY_CHANGED_EVENT` on success.
 */
export async function registryUpsertProvider(provider: ProviderConfig): Promise<void> {
  if (!isTauri()) {
    const idx = _mockRegistry.providers.findIndex((p) => p.id === provider.id);
    if (idx >= 0) {
      _mockRegistry.providers[idx] = { ..._mockRegistry.providers[idx], ...provider };
    } else {
      _mockRegistry.providers.push(structuredClone(provider));
    }
    dispatchChanged();
    return;
  }
  await tauriInvoke<void>("registry_upsert_provider", { provider });
  dispatchChanged();
}

/**
 * Delete a non-builtin provider by id.
 * Throws if the provider is built-in or not found.
 */
export async function registryDeleteProvider(id: string): Promise<void> {
  if (!isTauri()) {
    const idx = _mockRegistry.providers.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`provider '${id}' not found`);
    if (_mockRegistry.providers[idx].builtin) {
      throw new Error(`provider '${id}' is built-in and cannot be deleted`);
    }
    _mockRegistry.providers.splice(idx, 1);
    dispatchChanged();
    return;
  }
  await tauriInvoke<void>("registry_delete_provider", { id });
  dispatchChanged();
}

/** Returns the currently active provider + model. */
export async function registryGetActiveModel(): Promise<ActiveModel> {
  if (!isTauri()) {
    return { provider: _mockRegistry.activeProvider, model: _mockRegistry.activeModel };
  }
  return tauriInvoke<ActiveModel>("registry_get_active_model");
}

/**
 * Set the globally-active provider + model.
 * Dispatches `MODEL_REGISTRY_CHANGED_EVENT` on success.
 */
export async function registrySetActiveModel(provider: string, model: string): Promise<void> {
  if (!isTauri()) {
    _mockRegistry.activeProvider = provider;
    _mockRegistry.activeModel = model;
    dispatchChanged();
    return;
  }
  await tauriInvoke<void>("registry_set_active_model", { provider, model });
  dispatchChanged();
}
