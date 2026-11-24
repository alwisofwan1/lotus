import { useEffect, useRef, useState } from "react";
import type { FactoryCheckPreview, FactoryCheckTrial } from "@/lib/tauri/graph-run";
import type { FactoryCheckTrialSource } from "../services/factory-check-trial";

/** Poll bounded native receipts, never treat renderer submission as successful execution. */
export function useFactoryCheckTrial(source: FactoryCheckTrialSource, checkout: string, repo: string, base: string | null, command: string, shell: boolean) {
  const [preview, setPreview] = useState<FactoryCheckPreview | null>(null);
  const [trial, setTrial] = useState<FactoryCheckTrial | null>(null);
  const [flight, setFlight] = useState<"preview" | "start" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(false);
  const draft = useRef(0);
  const receipt = useRef(0);
  const running = trial?.status === "running";
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { draft.current += 1; setPreview(null); }, [command, base, shell, source, checkout, repo]);
  useEffect(() => {
    let obsolete = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const version = receipt.current;
      try {
        const next = await source.status(checkout, repo, base ?? "");
        if (obsolete || version !== receipt.current) return;
        if (next && next.repo !== repo) throw new Error("Check result does not match the selected repository");
        setTrial(next);
        setStatusError(null);
        if (next?.status !== "running") setCancelling(false);
      } catch {
        if (!obsolete && version === receipt.current) setStatusError("Status unavailable. Checks may still be running. Keep this view open to retry, or cancel the known trial.");
      } finally {
        if (!obsolete) timer = setTimeout(() => void poll(), running ? 1000 : 5000);
      }
    };
    void poll();
    return () => { obsolete = true; clearTimeout(timer); };
  }, [source, checkout, repo, base, running]);

  const act = async (kind: "preview" | "start" | "cancel", action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setFlight(kind); setError(null);
    try { await action(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; if (mounted.current) setFlight(null); }
  };
  return {
    preview, trial, flight, error, statusError, cancelling,
    review: () => act("preview", async () => {
      const version = draft.current;
      const next = await source.preview(checkout, repo, base ?? "", command);
      if (mounted.current && version === draft.current) {
        if (next.repo !== repo || next.command !== command || next.base !== base || next.shell !== shell) throw new Error("Factory configuration changed. Refresh Settings and review a new check preview.");
        setPreview(next);
      }
    }),
    dismiss: () => setPreview(null),
    start: () => act("start", async () => {
      if (!preview || preview.command !== command || preview.base !== base || preview.shell !== shell) return;
      receipt.current += 1;
      const next = await source.start(preview.id);
      receipt.current += 1;
      if (mounted.current) { setTrial(next); setPreview(null); setCancelling(false); }
    }),
    cancel: () => act("cancel", async () => {
      if (!trial) return;
      await source.cancel(repo, trial.id);
      if (mounted.current) setCancelling(true);
    }),
  };
}
