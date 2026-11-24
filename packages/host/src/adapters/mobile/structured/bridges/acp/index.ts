import type {
  ProviderBridgeFactory,
  ProviderBridgeSession,
  ProviderBridgeSpawn,
} from "../../../../../types/provider-bridge.js";
import { onPath } from "../on-path.js";
import { KNOWN_ACP_AGENTS, type AcpAgentDefinition } from "./known-agents.js";
import { AcpSession, type AcpSessionOptions } from "./session.js";

/** Swappable so a test never spawns a binary. */
export type CreateAcpSession = (opts: AcpSessionOptions) => ProviderBridgeSession;

/**
 * One [`ProviderBridgeFactory`] per known ACP agent.
 *
 * `gating` is `skipped` for all of them, and that is a report rather than a policy: probed
 * 2026-09-06, `cursor-agent acp` ran `rm -f` and a network call without one
 * `session/request_permission`. The lever that does exist is the read-only mode, which
 * `AcpSession` sets from `permissionMode`.
 */
export function acpBridges(createSession?: CreateAcpSession): ProviderBridgeFactory[] {
  return KNOWN_ACP_AGENTS.map((agent) => acpBridge(agent, createSession));
}

export function acpBridge(agent: AcpAgentDefinition, createSession?: CreateAcpSession): ProviderBridgeFactory {
  const create = createSession ?? ((o: AcpSessionOptions) => new AcpSession(o));
  return {
    agentType: agent.agentType,
    runnerLabel: agent.runnerLabel,
    available: (env) => onPath(agent.command, env),
    gating: () => "skipped",
    create: (spawn: ProviderBridgeSpawn) => {
      // shortcut: `session/load` replays the whole chat as updates, doubling saved history; dedupe it to support resume
      if (spawn.resume !== undefined) throw new Error(`${agent.runnerLabel} cannot resume a chat yet`);
      return create({
        paneId: spawn.paneId,
        cwd: spawn.cwd,
        agent,
        ...(spawn.permissionMode === undefined ? {} : { permissionMode: spawn.permissionMode }),
        ...(spawn.model === undefined ? {} : { model: spawn.model }),
      });
    },
  };
}
