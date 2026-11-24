"use client";

import { useEffect, useState } from "react";
import type { FactoryCatalog } from "@/lib/tauri/graph-run";
import type { FactoryAgentsSource } from "../services/factory-agents";

type CatalogState =
  | { kind: "loading"; catalog: null }
  | { kind: "ready"; catalog: FactoryCatalog }
  | { kind: "error"; catalog: null; message: string };

/** Rescan only integrations: keep the settings pane and its unsaved draft mounted. */
export function useFactoryCatalog(
  source: FactoryAgentsSource,
  checkout: string | null,
  base: string | null,
  repo: string | null,
  generation: number,
) {
  const [refresh, setRefresh] = useState(0);
  const key = JSON.stringify([checkout, base, repo, generation, refresh]);
  const [result, setResult] = useState<{ key: string; state: CatalogState } | null>(null);
  const state: CatalogState = result?.key === key ? result.state : { kind: "loading", catalog: null };

  useEffect(() => {
    if (!checkout || !repo) return;
    let live = true;
    source.catalog(checkout, base, repo).then(
      (catalog) => { if (live) setResult({ key, state: { kind: "ready", catalog } }); },
      (cause) => {
        if (live) setResult({ key, state: { kind: "error", catalog: null, message: cause instanceof Error ? cause.message : String(cause) } });
      },
    );
    return () => { live = false; };
  }, [source, checkout, base, repo, key]);

  return { state, rescan: () => setRefresh((n) => n + 1) };
}
