"use client";

import { useEffect, useState } from "react";

import type { AutomationClient, RunStep } from "../services/automation-api";

/** How many steps a running row keeps; the transcript has the rest. */
const MAX_STEPS = 50;

/**
 * What run `runId`'s agent has done so far, kept current while `active`: the steps Rust already
 * holds, then each new one as it happens. A step that arrives while the first read is in flight is
 * kept once, not twice. The event listener registers asynchronously, so a step emitted in the few
 * milliseconds before it does can be missed; the next one shows.
 */
export function useRunSteps(client: AutomationClient, runId: string, active: boolean): RunStep[] {
  const [steps, setSteps] = useState<RunStep[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const off = client.onRunStep((step) => {
      if (step.runId !== runId) return;
      setSteps((prev) => [...prev, { atMs: step.atMs, text: step.text }].slice(-MAX_STEPS));
    });
    void client
      .runSteps(runId)
      .then((known) => {
        if (!alive) return;
        const same = (a: RunStep, b: RunStep) => a.atMs === b.atMs && a.text === b.text;
        setSteps((prev) => [...known, ...prev.filter((p) => !known.some((k) => same(k, p)))].slice(-MAX_STEPS));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, [client, runId, active]);
  return steps;
}
