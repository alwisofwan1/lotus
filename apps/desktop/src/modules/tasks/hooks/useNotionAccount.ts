"use client";

import { useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri/runtime";
import {
  createTauriConnectorsClient,
  subscribeToConnectorChanges,
  type NotionStatus,
} from "@/modules/connectors/services/connectors-api";

/**
 * Who Notion is connected as, for Tasks: "Add a Notion database" needs an account first (the
 * account lives in Connectors, the source in Tasks — PLAN S16). Follows Connect and Disconnect.
 * Reads a plain file on the Rust side, never the keychain.
 */
export function useNotionAccount(): NotionStatus | null {
  const [status, setStatus] = useState<NotionStatus | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    const client = createTauriConnectorsClient();
    let alive = true;
    const load = () =>
      void client
        .notionStatus()
        .then((next) => {
          if (alive) setStatus(next);
        })
        .catch(() => {
          if (alive) setStatus(null);
        });
    load();
    const off = subscribeToConnectorChanges(load);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return status;
}
