/** Per-node reply capability, so the team composer can resume any agent's session. */
export interface AgentReplyHandle {
  /** True when the node has a live session and is idle enough to accept a reply right now. */
  canReply: () => boolean;
  /**
   * True when the node can accept a message to deliver now OR once it finishes starting up. When this
   * is true but {@link canReply} is false, {@link sendReply} buffers the message and flushes it on
   * ready (dispatch queueing). Defaults to {@link canReply} for handles that don't implement it.
   */
  accepts?: () => boolean;
  /** Resume the node's session with a follow-up message (pasted, then submitted). For a ready PTY,
   *  the returned promise resolves only after the submit/Enter write; buffered startup paths may
   *  return once the message is accepted into their readiness queue. */
  sendReply: (text: string) => Promise<void> | void;
  /** Type text into the agent's prompt WITHOUT submitting (e.g. inserting /skill so the user can
   *  add context then press Enter). Optional — only live PTY agents provide it. */
  insert?: (text: string) => void;
}

export interface AgentReplyRegistry {
  register(nodeId: string, handle: AgentReplyHandle): () => void;
  get(nodeId: string): AgentReplyHandle | undefined;
}

/**
 * Decouples the team composer from individual AgentNode hooks: nodes register a
 * reply handle; the composer looks it up by node id and resumes the session.
 * Mirrors agent-run-registry.
 */
export function createAgentReplyRegistry(): AgentReplyRegistry {
  const handles = new Map<string, AgentReplyHandle>();
  return {
    register(nodeId, handle) {
      handles.set(nodeId, handle);
      return () => { if (handles.get(nodeId) === handle) handles.delete(nodeId); };
    },
    get(nodeId) {
      return handles.get(nodeId);
    },
  };
}

/** Process-wide registry shared by AgentNodes and the team composer. */
export const agentReplyRegistry: AgentReplyRegistry = createAgentReplyRegistry();
