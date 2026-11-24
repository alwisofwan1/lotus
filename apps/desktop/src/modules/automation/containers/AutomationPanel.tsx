"use client";

import { useMemo } from "react";

import { AutomationSurface, type AutomationSurfaceProps } from "../components/AutomationSurface";
import { createTauriAutomationClient, subscribeToAutomationChanges, type AutomationClient, type Subscribe } from "../services/automation-api";

/**
 * Automations, ready to mount in any host — Code, Chat, Canvas. A host passes only what it alone
 * knows (how to close it, how to open an agent or a pane, its projects); the app's own client and
 * change feed are wired here. A host with its own stored layout may pass `layout` too; without
 * it the seam widths are kept in this browser's storage.
 *
 * Passing `client` / `subscribe` replaces the app's: tests and previews do that.
 */
export type AutomationPanelProps = Omit<AutomationSurfaceProps, "client" | "subscribe"> & {
  client?: AutomationClient;
  subscribe?: Subscribe;
};

export function AutomationPanel({ client, subscribe, ...host }: AutomationPanelProps) {
  const own = useMemo(() => client ?? createTauriAutomationClient(), [client]);
  return <AutomationSurface client={own} subscribe={subscribe ?? subscribeToAutomationChanges} {...host} />;
}
