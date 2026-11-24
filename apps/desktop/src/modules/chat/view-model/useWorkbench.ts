"use client";

import { useCallback, useState } from "react";

import {
  parseWorkbenches,
  patchWorkbench,
  showTab,
  workbenchOf,
  WORKBENCH_STORAGE_KEY,
  type WorkbenchState,
  type WorkbenchTab,
  type Workbenches,
} from "../domain/workbench";

function load(): Workbenches {
  try {
    return parseWorkbenches(localStorage.getItem(WORKBENCH_STORAGE_KEY), Date.now());
  } catch {
    return {};
  }
}

function save(all: Workbenches): void {
  try {
    localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked: the panel still works for this session.
  }
}

/** The active thread's Workbench, and the ways to change it; every change is remembered. */
export function useWorkbench(threadId: string | null) {
  const [all, setAll] = useState(load);
  const update = useCallback((next: (all: Workbenches, id: string, now: number) => Workbenches) => {
    if (!threadId) return;
    setAll((current) => {
      const changed = next(current, threadId, Date.now());
      save(changed);
      return changed;
    });
  }, [threadId]);
  const patch = useCallback((p: Partial<WorkbenchState>) => update((a, id, now) => patchWorkbench(a, id, p, now)), [update]);
  const show = useCallback((tab: WorkbenchTab) => update((a, id, now) => showTab(a, id, tab, now)), [update]);
  return { state: workbenchOf(all, threadId), patch, show };
}
