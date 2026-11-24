"use client";

// Canvas Browser Annotation → Live Agent Routing
//
// Delivers a captured Browser Node annotation directly into a live-agent's
// session (LiveAgentNode/HeadlessAgentNode) via the SAME reply mechanism the
// team composer and NL command bar already use (`agentReplyRegistry` +
// `sendReply`, which resumes the agent's CLI session), instead of a raw PTY
// write. This is the correct delivery path for `--resume`-based CLI agents —
// `canvas-browser-annotation-routing.ts` only knows about classic Terminal-node
// PTY sessions tracked in `terminal-session-registry`, which a live-agent's PTY
// (tracked in `src/lib/pty-session-pool.ts`) never registers into.

import { agentReplyRegistry, type AgentReplyHandle } from "./agent-reply-registry";
import { parseCanvasBrowserAnnotationContext } from "./canvas-browser-annotation-context";
import { extractAnnotationTraceId, formatAnnotationTrace, logAnnotationTrace } from "./canvas-browser-annotation-trace";
import type { CanvasBrowserAnnotationRouteResult } from "./canvas-browser-annotation-routing";

const TRACE_PATH = "frontend-agent-route";

export interface RouteCanvasBrowserAnnotationToAgentInput {
  /** The live-agent node's React Flow id — the same id `useAgentReplyRegistration` registers. */
  agentNodeId: string | null | undefined;
  payload: string;
  getHandle?: (nodeId: string) => AgentReplyHandle | undefined;
  /** Verify-first instrumentation (Slice 0): see `canvas-browser-annotation-routing.ts`. */
  log?: (line: string) => void;
}

/** Route a captured annotation to a live-agent's session. Mirrors `sendAgentMessage`'s
 *  tri-state dispatch (ready → immediate, starting → buffered, offline → skipped) so
 *  an annotation follows the exact same delivery contract as any other agent message. */
export function routeCanvasBrowserAnnotationToAgent({
  agentNodeId,
  payload,
  getHandle = (nodeId) => agentReplyRegistry.get(nodeId),
  log = logAnnotationTrace,
}: RouteCanvasBrowserAnnotationToAgentInput): CanvasBrowserAnnotationRouteResult {
  if (!agentNodeId) {
    log(formatAnnotationTrace(TRACE_PATH, "-", extractAnnotationTraceId(payload), "failed:missing-terminal"));
    return { ok: false, reason: "missing-terminal" };
  }

  const parsed = parseCanvasBrowserAnnotationContext(payload);
  if (!parsed.ok) return parsed;

  const { annotationId, context, cropRect } = parsed;
  const handle = getHandle(agentNodeId);

  if (handle?.canReply()) {
    void handle.sendReply(context);
    log(formatAnnotationTrace(TRACE_PATH, agentNodeId, annotationId, "sent"));
    return { ok: true, delivery: "sent", annotationId, context, cropRect };
  }

  if (handle?.accepts?.()) {
    void handle.sendReply(context);
    log(formatAnnotationTrace(TRACE_PATH, agentNodeId, annotationId, "queued"));
    return { ok: true, delivery: "queued", annotationId, context, cropRect };
  }

  log(formatAnnotationTrace(TRACE_PATH, agentNodeId, annotationId, "failed:no-live-session"));
  return { ok: true, delivery: "failed", annotationId, context, cropRect };
}
