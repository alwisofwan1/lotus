import { useCallback, useEffect, useState } from "react";
import { listS2sProviders, S2S_PROVIDERS_CHANGED_EVENT, type S2sProviderRegistry } from "@/lib/tauri-api";

export interface UseS2sProviderRegistryResult {
  registry: S2sProviderRegistry | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Loads the voice-to-voice (S2S) provider registry (~/.lotus/s2s-providers.json via
 * {@link listS2sProviders}). Mirrors {@link useSttProviderRegistry}. Outside the desktop app it
 * resolves to an empty registry (duplex voice is desktop-only).
 * `load` lets the Voice Core read the registry through its Tauri Voice Port; keep it referentially stable.
 */
export function useS2sProviderRegistry(
  load: () => Promise<S2sProviderRegistry> = listS2sProviders,
): UseS2sProviderRegistryResult {
  const [registry, setRegistry] = useState<S2sProviderRegistry | null>(null);
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
    const onChange = () => void refresh();
    window.addEventListener(S2S_PROVIDERS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(S2S_PROVIDERS_CHANGED_EVENT, onChange);
  }, [refresh]);

  return { registry, loading, error, refresh };
}
