"use client";

import { useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri/runtime";
import {
  createTauriConnectorsClient,
  subscribeToConnectorChanges,
  type GhAccount,
} from "@/modules/connectors/services/connectors-api";

/**
 * The `gh` logins, for "Add a GitHub repo": a source reads as one of them (ADR-0048). The logins
 * are gh's own — added with `gh auth login`, shown in Connectors — so this only reads them, and
 * reads again when Connectors says something changed. Null until the first read answers.
 */
export function useGhAccounts(): GhAccount[] | null {
  const [accounts, setAccounts] = useState<GhAccount[] | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    const client = createTauriConnectorsClient();
    let alive = true;
    const load = () =>
      void client
        .ghAccounts()
        .then((next) => {
          if (alive) setAccounts(next);
        })
        .catch(() => {
          if (alive) setAccounts([]);
        });
    load();
    const off = subscribeToConnectorChanges(load);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return accounts;
}
