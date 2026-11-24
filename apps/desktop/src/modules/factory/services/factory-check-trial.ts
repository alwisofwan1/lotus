import type { FactoryCheckPreview, FactoryCheckTrial } from "@/lib/tauri/graph-run";
export interface FactoryCheckTrialSource {
  preview(checkout: string, repo: string, base: string, command: string): Promise<FactoryCheckPreview>;
  start(previewId: string): Promise<FactoryCheckTrial>;
  status(checkout: string, repo: string, base: string): Promise<FactoryCheckTrial | null>;
  cancel(repo: string, id: string): Promise<void>;
}

export const checkTrialLabels = { running: "Running", passed: "Passed", failed: "Failed", cancelled: "Cancelled", "timed-out": "Timed out" } as const;
/** Historical success is not evidence for another command, mode, branch or revision. */
export function checkTrialLabel(trial: FactoryCheckTrial | null, command: string, base: string | null, shell: boolean): string {
  if (!trial) return "Not verified";
  if (trial.status === "running") return "Running";
  if (trial.command !== command || trial.base !== base || trial.shell !== shell || (trial.currentRevision !== null && trial.currentRevision !== trial.revision)) return "Outdated";
  if (trial.status === "passed" && trial.currentRevision === null) return "Revision unknown";
  return checkTrialLabels[trial.status];
}
