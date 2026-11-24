"use client";

import { useCallback, useEffect, useState } from "react";
import {
  registryDeleteProvider,
  registryGetActiveModel,
  registryListProviders,
  registrySetActiveModel,
  registryUpsertProvider,
} from "@/lib/model-registry-api";
import { MODEL_REGISTRY_CHANGED_EVENT } from "@/lib/model-registry-defaults";
import { DEFAULT_REGISTRY } from "@/lib/model-registry-defaults";
import type { ProviderConfig } from "@/lib/model-registry-types";
import { isTauri } from "@/lib/tauri/runtime";

export interface ModelRegistryState {
  providers: ProviderConfig[];
  activeProvider: string;
  activeModel: string;
  loading: boolean;
  error: string | null;
}

export interface ModelRegistryActions {
  setActiveModel: (provider: string, model: string) => Promise<void>;
  upsertProvider: (provider: ProviderConfig) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  reload: () => Promise<void>;
}

export type UseModelRegistryReturn = ModelRegistryState & ModelRegistryActions;

/**
 * Loads the model registry from disk (via Tauri), reloads on the global
 * `lotus:model-registry-changed` event, and exposes mutation helpers that
 * dispatch that event after each change.
 *
 * Safe to call outside Tauri: returns the default registry immediately and
 * mutations update an in-memory store.
 */
export function useModelRegistry(): UseModelRegistryReturn {
  const [state, setState] = useState<ModelRegistryState>(() => ({
    providers: DEFAULT_REGISTRY.providers,
    activeProvider: DEFAULT_REGISTRY.activeProvider,
    activeModel: DEFAULT_REGISTRY.activeModel,
    loading: isTauri(),
    error: null,
  }));

  const loadRegistry = useCallback(async () => {
    try {
      const [providers, active] = await Promise.all([
        registryListProviders(),
        registryGetActiveModel(),
      ]);
      setState({
        providers,
        activeProvider: active.provider,
        activeModel: active.model,
        loading: false,
        error: null,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  // Initial load
  useEffect(() => {
    if (!isTauri()) return;
    loadRegistry();
  }, [loadRegistry]);

  // Reactive reload on registry mutations
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => loadRegistry();
    window.addEventListener(MODEL_REGISTRY_CHANGED_EVENT, handler);
    return () => window.removeEventListener(MODEL_REGISTRY_CHANGED_EVENT, handler);
  }, [loadRegistry]);

  const setActiveModel = useCallback(
    async (provider: string, model: string) => {
      await registrySetActiveModel(provider, model);
      // Optimistic update — the event dispatch in registrySetActiveModel also
      // triggers a full reload, but this keeps the UI snappy.
      setState((prev) => ({ ...prev, activeProvider: provider, activeModel: model }));
    },
    [],
  );

  const upsertProvider = useCallback(async (provider: ProviderConfig) => {
    await registryUpsertProvider(provider);
  }, []);

  const deleteProvider = useCallback(async (id: string) => {
    await registryDeleteProvider(id);
  }, []);

  return {
    ...state,
    setActiveModel,
    upsertProvider,
    deleteProvider,
    reload: loadRegistry,
  };
}
