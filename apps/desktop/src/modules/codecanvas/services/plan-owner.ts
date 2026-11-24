const norm = (s: string) => s.trim().toLowerCase();

/** A durable manual binding from a plan owner label to the agent node id that owns it. */
export type OwnerBindings = Record<string, string>;

/** Minimal shape of a live agent on the canvas, for owner resolution. */
export interface AgentRef {
  id: string;
  name: string;
}

/**
 * Resolves a plan step's owner string to the canvas agent name it refers to. Agents are placed by
 * full name ("Backend Engineer") but a Lead often writes a short owner ("Backend"), so exact lookup
 * misses. Matches exact first, then a unique word-prefix match in either direction; ambiguous or
 * absent → undefined (never guess and misattribute a step). Returns the canonical candidate name.
 */
export function resolveOwnerName(owner: string | undefined, candidates: Iterable<string>): string | undefined {
  if (!owner || !owner.trim()) return undefined;
  const o = norm(owner);
  const list = [...candidates];

  const exact = list.find((c) => norm(c) === o);
  if (exact) return exact;

  const prefix = list.filter((c) => {
    const cn = norm(c);
    return cn.startsWith(`${o} `) || o.startsWith(`${cn} `);
  });
  return prefix.length === 1 ? prefix[0] : undefined;
}

/**
 * Resolves a plan step's owner label to a live agent node id, layered for robustness:
 *  1) an explicit manual binding, when the bound agent still exists (survives renames — keyed by id);
 *  2) else fuzzy name resolution against the live roster.
 * Returns undefined when nothing resolves (the step stays unowned rather than misattributed).
 */
export function resolveStepAgentId(
  ownerLabel: string | undefined,
  roster: readonly AgentRef[],
  bindings?: OwnerBindings,
): string | undefined {
  if (!ownerLabel) return undefined;
  const bound = bindings?.[ownerLabel];
  if (bound && roster.some((r) => r.id === bound)) return bound;
  const name = resolveOwnerName(ownerLabel, roster.map((r) => r.name));
  return name ? roster.find((r) => r.name === name)?.id : undefined;
}
