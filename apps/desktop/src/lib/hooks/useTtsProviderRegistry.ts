import { useCallback, useEffect, useState } from "react";
import { listTtsProviders, TTS_PROVIDERS_CHANGED_EVENT, type TtsProviderRegistry } from "@/lib/tauri-api";

export interface UseTtsProviderRegistryResult {
  registry: TtsProviderRegistry | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Loads the TTS provider registry (~/.lotus/tts-providers.json via `listTtsProviders`). Mirrors
 * {@link useRunnerRegistry}. Outside the desktop app it resolves to the browser-only default.
 * `load` lets the Voice Core read the registry through its Tauri Voice Port; keep it referentially stable.
 */
export function useTtsProviderRegistry(
  load: () => Promise<TtsProviderRegistry> = listTtsProviders,
): UseTtsProviderRegistryResult {
  const [registry, setRegistry] = useState<TtsProviderRegistry | null>(null);
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
    window.addEventListener(TTS_PROVIDERS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(TTS_PROVIDERS_CHANGED_EVENT, onChange);
  }, [refresh]);

  return { registry, loading, error, refresh };
}
