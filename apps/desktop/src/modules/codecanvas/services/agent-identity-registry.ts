/**
 * Durable per-pane agent identity — the piece that lets a cross-project finish still be announced.
 *
 * The live {@link agentStatusRegistry} is wiped when a node unmounts, and switching canvas projects
 * unmounts the whole board — so a project-A agent that finishes while you are viewing project B is
 * gone from the roster and its "done" callout would silently drop. This registry retains the minimum
 * the callout needs — the agent's display `name`, node id, and `projectId` — keyed by the hook pane id, and is
 * cleared ONLY when the node is really closed (not on an incidental unmount / project switch). It
 * mirrors the PTY-pool survive-unmount contract, and stays separate from the live roster so the Inbox
 * still shows only mounted agents.
 */
export interface AgentIdentity {
  name: string;
  /** ReactFlow node id, used for viewport visibility even when hook pane ids are project-scoped. */
  nodeId?: string;
  projectId?: string;
}

export interface AgentIdentityRegistry {
  /** Record (or update) a pane's identity — called wherever the live status is published. */
  record(paneId: string, identity: AgentIdentity): void;
  get(paneId: string): AgentIdentity | undefined;
  /** Drop a pane's identity — called only on a real close, never an unmount / project switch. */
  forget(paneId: string): void;
}

export function createAgentIdentityRegistry(): AgentIdentityRegistry {
  const identities = new Map<string, AgentIdentity>();
  return {
    record(paneId, identity) {
      identities.set(paneId, {
        name: identity.name,
        ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
        ...(identity.projectId ? { projectId: identity.projectId } : {}),
      });
    },
    get(paneId) {
      return identities.get(paneId);
    },
    forget(paneId) {
      identities.delete(paneId);
    },
  };
}

/** Process-wide identity store shared by AgentNodes (publishers) and the done-callout channel. */
export const agentIdentityRegistry: AgentIdentityRegistry = createAgentIdentityRegistry();
