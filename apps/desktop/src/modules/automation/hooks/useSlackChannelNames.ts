"use client";

import { useEffect, useState } from "react";

import type { AutomationClient } from "../services/automation-api";

/**
 * Slack channel id → name, read once when `enabled`. Empty until it arrives, and on any failure:
 * callers fall back to the id, so a name is a nicety, never a requirement.
 */
export function useSlackChannelNames(client: AutomationClient, enabled: boolean): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void client
      .slackChannels()
      .then((list) => alive && setNames(new Map(list.map((c) => [c.id, c.name]))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, enabled]);
  return names;
}
