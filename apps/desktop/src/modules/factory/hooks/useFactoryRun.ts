"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  graphRunAbort,
  graphRunRaiseCap,
  graphRunStart,
  onGraphRunChanged,
  type GraphRunChanged,
  type GraphRunStartInput,
} from "@/lib/tauri/graph-run";
import { codecanvasListGraphRuns } from "@/lib/tauri/codecanvas";
import { createTauriAutomationClient, type FoundCheckout } from "@/modules/automation/services/automation-api";
import { localProjectIdForRoot } from "@/modules/codecanvas/services/codecanvas-project-repository";
import type { GraphRunRecord } from "@/modules/codecanvas/services/graph-run-record";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import {
  DEFAULT_CAP_USD,
  factoryRunView,
  factoryStartInput,
  latestFactoryRun,
  type FactoryRef,
  type FactoryRunView,
} from "@/modules/factory/services/factory-run";

/** What a Factory Run panel needs from Rust; a port, so the hook is testable with no app. */
export interface FactoryRunClient {
  findCheckout(repo: string, workspaces: { id: string; cwd: string }[], preferred: string | null): Promise<FoundCheckout | null>;
  listRuns(projectId: string): Promise<GraphRunRecord[]>;
  start(input: GraphRunStartInput): Promise<string>;
  raiseCap(id: string): Promise<number>;
  abort(id: string): Promise<void>;
  onChanged(handler: (event: GraphRunChanged) => void): Promise<() => void>;
}

export function createTauriFactoryRunClient(): FactoryRunClient {
  const automation = createTauriAutomationClient();
  return {
    findCheckout: (repo, workspaces, preferred) => automation.findCheckout(repo, workspaces, preferred),
    listRuns: codecanvasListGraphRuns,
    start: graphRunStart,
    raiseCap: graphRunRaiseCap,
    abort: graphRunAbort,
    onChanged: onGraphRunChanged,
  };
}

export interface UseFactoryRunInput {
  client: FactoryRunClient;
  repo: string;
  /** `number` is the Notion id (`TKT-123`) of a Notion ticket, which then also has `notion`. */
  issue: { number: FactoryRef; title: string; body: string | null };
  /** The Notion page of a Notion ticket (#168). */
  notion?: { pageId: string; url: string };
  /**
   * Read when the run starts, in place of `issue.body`: a Notion ticket's page and properties as
   * they are at that moment, so the panel does not read them on every open.
   */
  readBody?: () => Promise<string | null>;
  /** The gh account of the Ticket Source. */
  account: string;
  /** The window's workspaces; only local ones can hold the checkout the run reads. */
  workspaces: () => { id: string; cwd: string; remote: boolean }[];
}

export interface FactoryRunHandle {
  view: FactoryRunView;
  /** The user's checkout of the repo, or null when no local workspace holds it. */
  checkout: string | null;
  loading: boolean;
  busy: boolean;
  /** Why the last Start / Raise cap / Abort did not happen. */
  error: string | null;
  canStart: boolean;
  start(implementer: string): Promise<void>;
  raiseCap(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * One GitHub issue's Factory Run (ADR-0049, F2b). The run record is the truth: it is read once the
 * checkout is found, and again on every `graph-run://changed` for the checkout's project.
 *
 * The run is recorded under the Canvas Project of the checkout folder — by id only, so the project
 * is not opened (opening makes it the active one).
 */
export function useFactoryRun({ client, repo, issue, notion, readBody, account, workspaces }: UseFactoryRunInput): FactoryRunHandle {
  const [checkout, setCheckout] = useState<string | null>(null);
  const [record, setRecord] = useState<GraphRunRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspacesRef = useRef(workspaces);
  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  const projectId = checkout ? localProjectIdForRoot(checkout) : null;

  const reload = useCallback(async () => {
    if (!projectId) return;
    const runs = await client.listRuns(projectId);
    setRecord(latestFactoryRun(runs, repo, issue.number));
  }, [client, projectId, repo, issue.number]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const local = workspacesRef.current().filter((w) => !w.remote).map(({ id, cwd }) => ({ id, cwd }));
    void client
      .findCheckout(repo, local, null)
      .catch(() => null)
      .then((found) => {
        if (cancelled) return;
        setCheckout(found?.cwd ?? null);
        if (!found) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, repo]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void reload()
      .catch((cause) => !cancelled && setError(String(cause)))
      .finally(() => !cancelled && setLoading(false));
    let unlisten: (() => void) | null = null;
    void client
      .onChanged((event) => {
        if (event.projectId === projectId) void reload().catch(() => {});
      })
      .then((stop) => {
        if (cancelled) safeTauriUnlisten(stop);
        else unlisten = stop;
      });
    return () => {
      cancelled = true;
      safeTauriUnlisten(unlisten);
    };
  }, [client, projectId, reload]);

  const act = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        await reload();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const view = factoryRunView(record);
  const id = record?.id ?? null;
  return {
    view,
    checkout,
    loading,
    busy,
    error,
    canStart: view.canStart && checkout !== null && !busy && !loading,
    start: (implementer) =>
      act(async () => {
        if (!checkout || !projectId) throw new Error("No local workspace holds a checkout of this repo.");
        const ticket = readBody ? { ...issue, body: await readBody() } : issue;
        return client.start(
          factoryStartInput({ projectId, repo, issue: ticket, notion, account, checkout, implementer, budgetCap: DEFAULT_CAP_USD }),
        );
      }),
    raiseCap: () => act(() => (id ? client.raiseCap(id) : Promise.resolve())),
    abort: () => act(() => (id ? client.abort(id) : Promise.resolve())),
  };
}
