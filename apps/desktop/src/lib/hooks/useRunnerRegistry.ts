import { useEffect, useState } from "react";
import { listRunners, type RunnerRegistry } from "@/lib/tauri-api";

export interface UseRunnerRegistryResult {
  registry: RunnerRegistry | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Hook to load and manage the runner registry (ADR-0027 Phase 2).
 * Fetches all installed runners with their saved configurations.
 */
export function useRunnerRegistry(): UseRunnerRegistryResult {
  const [registry, setRegistry] = useState<RunnerRegistry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadRegistry = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listRunners();
      setRegistry(data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRegistry();
  }, []);

  return {
    registry,
    loading,
    error,
    refresh: loadRegistry,
  };
}
