"use client";

import { useEffect, useRef } from "react";

import type { AutomationClient } from "../services/automation-api";
import { subscribeToPaneRequests } from "../services/automation-api";
import { openRunPane, type RunPaneWorkspace } from "../services/run-pane";

export type RunPaneSpawner = {
  addPane: (workspaceId: string, command: string, cwd?: string) => string | null;
  workspace?: (id: string) => RunPaneWorkspace | null;
  workspaces?: () => ({ id: string } & RunPaneWorkspace)[];
};

/** How often the rail's workspaces are compared with what Rust last heard. */
const WORKSPACE_SYNC_MS = 5_000;

/**
 * Opens automation runs' panes for as long as the window lives, whether or not the Automation panel
 * is open, and keeps Rust told which local workspaces the rail holds, so a run in a project works in
 * its folder without a pane. Mounted once, by the shell that holds the grid's spawner.
 */
export function useAutomationPanes(client: AutomationClient, spawner: RunPaneSpawner | null): void {
  // Read at request time, so a spawner that arrives (or changes) later is used without re-subscribing.
  const spawnerRef = useRef(spawner);
  useEffect(() => {
    spawnerRef.current = spawner;
  }, [spawner]);
  useEffect(() => {
    let sent = "";
    const sync = () => {
      // Only local workspaces: a run's folder must be on this machine. The name is for the agent writing one.
      const local = (spawnerRef.current?.workspaces?.() ?? [])
        .filter((w) => !w.remote)
        .map(({ id, cwd, name }) => ({ id, cwd, name }));
      const signature = JSON.stringify(local);
      if (signature === sent) return;
      sent = signature;
      client.setWorkspaces(local).catch(() => {
        sent = ""; // try again next time
      });
    };
    sync();
    const timer = setInterval(sync, WORKSPACE_SYNC_MS);
    return () => clearInterval(timer);
  }, [client, spawner]);
  useEffect(
    () =>
      subscribeToPaneRequests((request) => {
        const current = spawnerRef.current;
        const grid = current?.workspace
          ? { workspace: current.workspace, workspaces: current.workspaces, addPane: current.addPane }
          : null;
        const report = { opened: client.paneOpened, failed: client.paneFailed, findCheckout: client.findCheckout };
        void openRunPane(request, grid, report).catch((error: unknown) => console.warn("[automation] could not answer a pane request", error));
      }),
    [client],
  );
}
