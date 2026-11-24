"use client";
import { useEffect, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import { ptyWritesForHeldPrompt, ptyWritesToClearHeldPrompt } from "@/modules/workspace-shell/services/composer-routing";
import { agentStatusRegistry, type AgentStatusRegistry } from "../agent-status-registry";

/** A spoken message waiting, unsent, in an Agent Node's own prompt (ADR-0064). */
export interface CanvasHeldPrompt {
  agentId: string;
  name: string;
  text: string;
}

export type CanvasHeldPromptOutcome = { ok: true } | { ok: false; reason: string };

export function canvasHeldPromptBusyReason(name: string): string {
  return `${name} still has unsent text in its prompt — Enter sends it, Esc clears it.`;
}

export function canvasHeldPromptUnreachableReason(name: string): string {
  return `Couldn't reach ${name}.`;
}

/**
 * The Canvas **Held Prompt**: the command bar's side of a dictation placed in an Agent Node's prompt.
 * Enter in the empty bar sends it, Escape clears it. Forgotten when its node leaves the board and
 * when the agent starts working — the prompt was sent, from the node itself or by a typed message.
 * One at a time: a second agent's would leave the first in its prompt with nothing in the bar to
 * send or clear it.
 */
export function useCanvasHeldPrompt({
  nodes,
  writeAgentPrompt,
  registry = agentStatusRegistry,
}: {
  nodes: Node[];
  /** Raw input for an agent's prompt. False when it has no prompt that can take input now. */
  writeAgentPrompt?: (agentId: string, data: string) => boolean;
  registry?: AgentStatusRegistry;
}) {
  const [held, setHeld] = useState<CanvasHeldPrompt | null>(null);
  const heldRef = useRef(held);
  useEffect(() => {
    heldRef.current = held;
  });
  if (held && !nodes.some((node) => node.id === held.agentId)) setHeld(null);

  // A turn STARTING is the prompt being sent. Only a change counts: an agent can take unsent text
  // while it is still running, and that alone must not forget what was just placed.
  const heldAgentId = held?.agentId;
  useEffect(() => {
    if (!heldAgentId) return;
    const working = (status: string | undefined) => status === "running" || status === "connecting";
    let wasWorking = working(registry.list().find((snapshot) => snapshot.id === heldAgentId)?.status);
    return registry.subscribe((snapshots) => {
      const agent = snapshots.find((snapshot) => snapshot.id === heldAgentId);
      const isWorking = working(agent?.status);
      if (!agent || (isWorking && !wasWorking)) setHeld(null);
      wasWorking = isWorking;
    });
  }, [heldAgentId, registry]);

  /** Put a spoken message, unsent, in the agent's prompt. No reason = its prompt cannot take text now. */
  function place(agentId: string, name: string, text: string): { ok: true } | { ok: false; reason?: string } {
    const previous = heldRef.current;
    const continues = previous?.agentId === agentId;
    if (previous && !continues) return { ok: false, reason: canvasHeldPromptBusyReason(previous.name) };
    const [line] = ptyWritesForHeldPrompt(text, continues);
    if (!line || !writeAgentPrompt?.(agentId, line)) return { ok: false };
    const next: CanvasHeldPrompt = {
      agentId,
      name,
      text: (continues && previous ? `${previous.text}${line}` : line).trim(),
    };
    heldRef.current = next;
    setHeld(next);
    return { ok: true };
  }

  /** Enter in the empty bar: a lone carriage return submits what the prompt holds. Kept when the
   * prompt cannot take it now, so Enter can try again. */
  function send(): CanvasHeldPromptOutcome {
    const current = heldRef.current;
    if (!current) return { ok: true };
    if (!writeAgentPrompt?.(current.agentId, "\r")) return { ok: false, reason: canvasHeldPromptUnreachableReason(current.name) };
    heldRef.current = null;
    setHeld(null);
    return { ok: true };
  }

  /**
   * A typed message about to be sent to this agent goes after the Held Prompt, as one message: the
   * space that keeps the two apart goes first. Returns the agent's name when it joined.
   */
  function join(agentId: string): string | null {
    const current = heldRef.current;
    if (current?.agentId !== agentId || !writeAgentPrompt?.(agentId, " ")) return null;
    heldRef.current = null;
    setHeld(null);
    return current.name;
  }

  /** Escape in the bar: a line-kill per line the prompt may take. */
  function clear(): CanvasHeldPromptOutcome {
    const current = heldRef.current;
    if (!current) return { ok: true };
    heldRef.current = null;
    setHeld(null);
    const [kill] = ptyWritesToClearHeldPrompt(current.text);
    return writeAgentPrompt?.(current.agentId, kill) ? { ok: true } : { ok: false, reason: canvasHeldPromptUnreachableReason(current.name) };
  }

  return { held, place, send, clear, join };
}
