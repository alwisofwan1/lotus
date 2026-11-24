import type { BridgeProvider } from "../../../../../types/api.js";

/**
 * Every ACP agent this host knows how to start, as `{command, args}` and nothing more.
 *
 * The point of the ACP bridge is that this table — not a new parser, a new format sniff, or
 * a new set of hooks — is what a runner costs. Only entries whose `agentType` is already in
 * `BridgeProvider` can be registered, so widening that union is the first step of adding one.
 *
 * Modes are the runner's permission scale. Cursor over ACP **never asks** (probed 2026-09-06:
 * it ran `rm -f` and a network call without a single `session/request_permission`), so the
 * only way to hold it back is to start it in a read-only mode. That is why `readOnlyModeId`
 * exists and why gating for these agents is always `skipped`: a cell that claimed it would
 * ask would be lying.
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
