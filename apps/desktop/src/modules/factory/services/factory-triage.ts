import type { FactoryReadinessKey, FactoryReadinessLevel, FactoryTriage, FactoryTriageReport } from "@/lib/tauri/graph-run";

/**
 * What triage found (FI3), worded for the run's page. Pure. The categories mirror `CATEGORIES` in
 * the Rust crate, in the same order.
 */

export const READINESS_CATEGORIES: readonly { key: FactoryReadinessKey; label: string }[] = [
  { key: "scope", label: "Scope" },
  { key: "dataModel", label: "Data model" },
  { key: "uxFlow", label: "UX flow" },
  { key: "nonFunctional", label: "Non-functional" },
  { key: "integrations", label: "Integrations" },
  { key: "edgeCases", label: "Edge cases" },
  { key: "constraints", label: "Constraints" },
  { key: "terminology", label: "Terminology" },
  { key: "completion", label: "Completion" },
];

const LEVEL_LABEL: Record<FactoryReadinessLevel, string> = { clear: "Clear", partial: "Partial", missing: "Missing" };

export const SCORE_LABEL: Record<FactoryTriageReport["score"], string> = {
  green: "🟢 Ready",
  yellow: "🟡 Partly ready",
  red: "🔴 Not ready",
};

export const VERDICT_LABEL: Record<FactoryTriageReport["verdict"], string> = {
  go: "Go",
  brainstorm: "Brainstorm first",
  refuse: "Refuse",
};

export interface ReadinessRow {
  label: string;
  level: FactoryReadinessLevel;
  levelLabel: string;
}

export function readinessRows(report: FactoryTriageReport): ReadinessRow[] {
  return READINESS_CATEGORIES.map(({ key, label }) => {
    const level = report.readiness[key] ?? "missing";
    return { label, level, levelLabel: LEVEL_LABEL[level] };
  });
}

export interface DuplicateRow {
  label: string;
  /** Where it opens: the PR, else the branch on GitHub. */
  url: string;
}

export function duplicateRows(triage: FactoryTriage, repo: string): DuplicateRow[] {
  return triage.duplicates.map((d) =>
    d.kind === "pr"
      ? { label: `PR #${d.number ?? "?"} (${d.branch})`, url: d.url ?? `https://github.com/${repo}/pulls` }
      : { label: `Branch ${d.branch}`, url: `https://github.com/${repo}/tree/${d.branch.split("/").map(encodeURIComponent).join("/")}` },
  );
}
