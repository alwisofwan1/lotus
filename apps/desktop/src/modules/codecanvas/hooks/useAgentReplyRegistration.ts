"use client";
import { useEffect, useRef } from "react";
import { agentReplyRegistry, type AgentReplyRegistry } from "../services/agent-reply-registry";

/** Registers a node's live reply capability so the team composer can resume it. */
export function useAgentReplyRegistration(
  nodeId: string,
  canReply: boolean,
  sendReply: (text: string) => Promise<void> | void,
  registry: AgentReplyRegistry = agentReplyRegistry,
  insert?: (text: string) => void,
  /** Whether the node can accept a (possibly-queued) message even before it's ready. Defaults to
   *  `canReply` — so handles that don't pass it behave exactly as before (no queueing). */
  accepts?: boolean,
): void {
  const latest = useRef({ canReply, sendReply, insert, accepts });
  const supportsInsert = insert !== undefined;
  useEffect(() => { latest.current = { canReply, sendReply, insert, accepts }; });

  useEffect(() => registry.register(nodeId, {
    canReply: () => latest.current.canReply,
    accepts: () => latest.current.accepts ?? latest.current.canReply,
    sendReply: (text) => latest.current.sendReply(text),
    ...(supportsInsert ? { insert: (text: string) => latest.current.insert?.(text) } : {}),
  }), [nodeId, registry, supportsInsert]);
}
