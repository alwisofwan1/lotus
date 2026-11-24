export type AgentPermissionMode = "full" | "safe";
export type AgentEffort = "minimal" | "low" | "medium" | "high" | "max";

export const AGENT_EFFORTS: AgentEffort[] = ["minimal", "low", "medium", "high", "max"];

export interface AgentGovernance {
  effort: AgentEffort;
  /** full = skip permissions (YOLO, can write); safe = keep permissions (effectively read-only headless). */
  permissionMode: AgentPermissionMode;
}

export const DEFAULT_GOVERNANCE: AgentGovernance = { effort: "medium", permissionMode: "full" };

/** Resolves a definition's governance (with defaults) into concrete run parameters. */
export function resolveGovernance(input?: Partial<AgentGovernance>): { effort: AgentEffort; skipPermissions: boolean } {
  return {
    effort: input?.effort ?? DEFAULT_GOVERNANCE.effort,
    skipPermissions: (input?.permissionMode ?? DEFAULT_GOVERNANCE.permissionMode) === "full",
  };
}
