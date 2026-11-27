import type { BridgeProvider } from "../../../../../types/api.js";

/**
 * ACP agents as `{command, args}`; only entries whose `agentType` is in `BridgeProvider`
 * register. Cursor **never asks**, so only a read-only mode (`readOnlyModeId`) holds it back
 * and gating is always `skipped`.
 */
export interface AcpAgentDefinition {
  agentType: BridgeProvider;
  runnerLabel: string;
  command: string;
  args: string[];
  /** Preferred `authMethods` ids, most specific first. Empty: this agent needs no `authenticate`. */
  authMethodIds: string[];
  /** The mode to switch into when the caller asked for `read-only`, when the agent has one. */
  readOnlyModeId?: string;
  /** What the operator runs to sign in, quoted back when the agent refuses to authenticate. */
  signInCommand: string;
}

export const KNOWN_ACP_AGENTS: readonly AcpAgentDefinition[] = [
  {
    agentType: "cursor",
    runnerLabel: "Cursor",
    command: "cursor-agent",
    args: ["acp"],
    // Probed 2026-09-06 against cursor-agent: `initialize` advertises exactly one method,
    // `cursor_login`, which reuses the CLI's own session — not `cached_token`, and not a key.
    authMethodIds: ["cursor_login", "cached_token"],
    readOnlyModeId: "plan",
    signInCommand: "cursor-agent login",
  },
];

export function acpAgent(agentType: string): AcpAgentDefinition | undefined {
  return KNOWN_ACP_AGENTS.find((a) => a.agentType === agentType);
}
