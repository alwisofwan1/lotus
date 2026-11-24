"use client";

import { useCallback, useEffect, useState } from "react";

import { LOTUS_SETTINGS_CHANGED_EVENT } from "@/modules/settings/services/settings-events";

import type {
  AgentPreset,
  Automation,
  AutomationClient,
  AutomationDraft,
  AutomationRun,
  GhAccount,
  SlackStatus,
  Subscribe,
} from "../services/automation-api";

export type AutomationState = {
  loaded: boolean;
  error: string | null;
  automations: Automation[];
  drafts: AutomationDraft[];
  runs: AutomationRun[];
  presets: AgentPreset[];
  ghAccounts: GhAccount[];
  slack: SlackStatus | null;
  results: AutomationDraft[];
  /** PR reviews already sent, newest first. */
  sent: AutomationDraft[];
  /** Answered Asks, newest first. */
  answered: AutomationDraft[];
  refresh: () => Promise<void>;
};

/** Everything the Automation panel shows, re-read whenever Rust says something changed. */
export function useAutomation(client: AutomationClient, subscribe: Subscribe): AutomationState {
  const [state, setState] = useState<Omit<AutomationState, "refresh">>({
    loaded: false,
    error: null,
    automations: [],
    drafts: [],
    runs: [],
    presets: [],
    ghAccounts: [],
    slack: null,
    results: [],
    sent: [],
    answered: [],
  });

  const refresh = useCallback(async () => {
    try {
      const [automations, drafts, runs, presets, ghAccounts, slack, results, sent, answered] = await Promise.all([
        client.list(),
        client.drafts(),
        client.runs(50),
        client.presets(),
        client.ghAccounts(),
        client.slackStatus().catch(() => null),
        client.results(30).catch(() => []),
        client.sentReviews(20).catch(() => []),
        client.answeredAsks(20).catch(() => []),
      ]);
      setState({ loaded: true, error: null, automations, drafts, runs, presets, ghAccounts, slack, results, sent, answered });
    } catch (error) {
      setState((prev) => ({ ...prev, loaded: true, error: String(error) }));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    return subscribe(() => void refresh());
  }, [refresh, subscribe]);

  // A preset saved here or in Tasks lands in settings.json; re-read so the Agent row sees it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => void refresh();
    window.addEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
  }, [refresh]);

  return { ...state, refresh };
}
