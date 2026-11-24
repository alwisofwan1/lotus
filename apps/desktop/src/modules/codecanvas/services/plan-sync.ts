import type { PlanStep } from "./plan-md-parser";

/** Outcome of a Plan node Sync — surfaced so an empty or missing plan.md never fails silently. */
export type PlanSyncStatus =
  | { kind: "loaded"; count: number; message: string }
  | { kind: "empty"; message: string }
  | { kind: "missing"; message: string };

export function classifyPlanSync(input: { found: boolean; steps: PlanStep[] }): PlanSyncStatus {
  if (!input.found) {
    return { kind: "missing", message: "plan.md not found — run the Lead agent first." };
  }
  if (input.steps.length === 0) {
    return { kind: "empty", message: 'plan.md has no checklist steps — use "- [ ] task (owner: Name)".' };
  }
  const count = input.steps.length;
  return { kind: "loaded", count, message: `Loaded ${count} step${count === 1 ? "" : "s"}.` };
}
