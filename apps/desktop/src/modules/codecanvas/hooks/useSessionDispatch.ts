"use client";
import { useCallback } from "react";
import {
  agentSessionControlRegistry,
  type AgentSessionControlRegistry,
} from "../services/session-control-registry";
import { planSessionDispatch } from "../services/session-dispatch";
import { verdictNotice, type SessionNotice } from "../services/session-verdict-copy";
import type { CanvasSessionRecord } from "../services/session-record";

/**
 * The one implementation of "what happens when a session row is pressed"
 * (`plans/codecanvas-session-refactor/issues/03`).
 *
 * The decision is pure and lives in `services/session-dispatch.ts`; the effects live here, once, so
 * the corner popover, the ⌘K rows and the cycle hotkeys cannot drift apart again. Every path ends
 * in either a running CLI or a sentence — there is deliberately no third outcome.
 */

export interface SessionDispatchDeps {
  projectId: string | null | undefined;
  /** Take the user to a node that is already running this conversation. */
  focusNode: (nodeId: string) => void;
  /** Make a node for a session no node on this board owns. Resolves to its id, or null on failure. */
  adoptSession: (session: CanvasSessionRecord) => Promise<string | null>;
  /** Show a sentence. A refusal that says nothing is the bug this whole plan is about. */
  notify: (notice: SessionNotice) => void;
  /** Ask, about the row that was pressed, before throwing away a turn that is waiting on a human. */
  confirmNeedsYou: (session: CanvasSessionRecord) => Promise<boolean>;
  registry?: AgentSessionControlRegistry;
  /** How long a freshly made node has to publish its controls. */
  waitTimeoutMs?: number;
}

const DEFAULT_WAIT_MS = 5000;

export function useSessionDispatch(deps: SessionDispatchDeps) {
  const {
    projectId,
    focusNode,
    adoptSession,
    notify,
    confirmNeedsYou,
    registry = agentSessionControlRegistry,
    waitTimeoutMs = DEFAULT_WAIT_MS,
  } = deps;

  const dispatch = useCallback(
    async (session: CanvasSessionRecord): Promise<void> => {
      const plan = planSessionDispatch(session, {
        projectId,
        isRegistered: (nodeId) => Boolean(registry.get(nodeId)),
        isDormant: (nodeId) => registry.get(nodeId)?.isDormant() ?? false,
        activeSessionId: (nodeId) => registry.get(nodeId)?.activeSessionId() ?? null,
      });

      if (plan.kind === "blocked") {
        const notice = verdictNotice({ allowed: false, reason: plan.reason });
        if (notice) notify(notice);
        return;
      }

      if (plan.kind === "focus") {
        focusNode(plan.nodeId);
        return;
      }

      if (plan.kind === "adopt") {
        const nodeId = await adoptSession(session);
        if (!nodeId) {
          notify({ kind: "error", text: "Could not make a node for this conversation." });
          return;
        }
        // Waiting for the handle is what makes "make a node, then run its session" one gesture.
        const handle = await registry.waitFor(nodeId, waitTimeoutMs);
        if (!handle) {
          notify({ kind: "error", text: "The node was not ready in time — try again." });
          return;
        }
        // It already carries this session's pointer: waking is the whole job.
        handle.wake();
        return;
      }

      const handle = registry.get(plan.nodeId);
      if (!handle) {
        notify({ kind: "error", text: "That node is not on the open board." });
        return;
      }

      if (plan.kind === "wake") {
        handle.wake();
        return;
      }

      const intent = { kind: "resume" as const, session };
      const verdict = handle.request(intent);
      const notice = verdictNotice(verdict);
      if (!verdict.allowed) {
        if (notice) notify(notice);
        return;
      }
      if ("confirm" in verdict) {
        // Nothing has been touched yet — that is the point of `request`.
        if (await confirmNeedsYou(session)) handle.commit(intent);
      }
    },
    [projectId, focusNode, adoptSession, notify, confirmNeedsYou, registry, waitTimeoutMs],
  );

  return { dispatch };
}
