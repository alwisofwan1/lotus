import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";

export type TerminalSessionRoutingDecision = "v2" | "legacy";

export type TerminalSessionCreateRoutingInput = {
  location?: CodeSpaceStoredWorkspaceLocation | null;
  canvasTerminalId?: string;
};

export function resolveTerminalSessionCreateRoute({
  canvasTerminalId,
}: TerminalSessionCreateRoutingInput): TerminalSessionRoutingDecision {
  if (canvasTerminalId) return "legacy";
  return "v2";
}
