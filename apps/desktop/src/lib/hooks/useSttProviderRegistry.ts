import { useCallback, useEffect, useState } from "react";
import { listSttProviders, STT_PROVIDERS_CHANGED_EVENT, type SttProviderRegistry } from "@/lib/tauri-api";

export interface UseSttProviderRegistryResult {
  registry: SttProviderRegistry | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Loads the STT provider registry (~/.lotus/stt-providers.json via `listSttProviders`). Mirrors
 * {@link useTtsProviderRegistry}. Outside the desktop app it resolves to the browser-only default.
 * `load` lets the Voice Core read the registry through its Tauri Voice Port; keep it referentially stable.
 */
export function useSttProviderRegistry(
  load: () => Promise<SttProviderRegistry> = listSttProviders,
): UseSttProviderRegistryResult {
  const [registry, setRegistry] = useState<SttProviderRegistry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRegistry(await load());
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
    // Stay in sync when another component (e.g. Settings → Voice) mutates the registry.
    const onChange = () => void refresh();
    window.addEventListener(STT_PROVIDERS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(STT_PROVIDERS_CHANGED_EVENT, onChange);
  }, [refresh]);

  return { registry, loading, error, refresh };
}
