"use client";

import { useEffect, useState } from "react";

import type { AutomationClient } from "../services/automation-api";

/**
 * Slack user id → display name for `ids`, read when the set of ids changes. Empty until it
 * arrives, and on any failure: callers fall back ("Someone"), so a name is a nicety.
 */
export function useSlackUserNames(client: AutomationClient, ids: string[]): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let alive = true;
    // A host without the command (older fakes) throws before any promise exists.
    void Promise.resolve()
      .then(() => client.slackUserNames(key.split(",")))
      .then((found) => alive && setNames(new Map(Object.entries(found))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, key]);
  return names;
}
