import { GitPullRequest, Hammer, Layers, ListChecks, FileText, ScanSearch, type LucideIcon } from "lucide-react";
import type { FactoryRole } from "@/lib/tauri/graph-run";

const ICONS: Record<FactoryRole, LucideIcon> = {
  triage: ListChecks,
  spec: FileText,
  implement: Hammer,
  review: ScanSearch,
  handoff: GitPullRequest,
};

/** The role's glyph, or the shared set's. One place, so the pipeline card and the map's hub agree. */
export function FactoryRoleIcon({ role, size = 16 }: { role: FactoryRole | "shared"; size?: number }) {
  const Icon = role === "shared" ? Layers : ICONS[role];
  return <Icon size={size} strokeWidth={1.75} aria-hidden />;
}
