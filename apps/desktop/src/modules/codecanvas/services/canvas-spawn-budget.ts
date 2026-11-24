/**
 * Session budget for agent-driven spawns on the canvas.
 *
 * `lotus_spawn_cell` lets a running agent create another agent, and that agent can do the same.
 * Nothing in the spawn path carries the caller's identity, so the chain cannot be bounded by
 * *depth* here — a total ceiling is what can be enforced, and it is enough to stop a delegation
 * loop from opening agent processes until the machine gives out.
 *
 * Human spawns (toolbar, palette, NL command) do not consume the budget: the ceiling exists to
 * bound what runs unattended, not what the user asks for while watching.
 *
 * Pure and injectable so the policy is unit-testable; the shared instance is the one the MCP
 * spawn bridge draws from.
 */

/** Agent-driven spawns allowed before the canvas refuses more without a reset. */
export const DEFAULT_MCP_SPAWN_BUDGET = 50;

export interface SpawnBudget {
  /** Claims one spawn. Returns false when the budget is spent — the caller must refuse the spawn. */
  tryConsume(): boolean;
  spent(): number;
  remaining(): number;
  limit(): number;
  /** Restores the full budget (project switch, or an explicit user reset). */
  reset(): void;
}

export function createSpawnBudget(limit: number = DEFAULT_MCP_SPAWN_BUDGET): SpawnBudget {
  const max = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_MCP_SPAWN_BUDGET;
  let used = 0;
  return {
    tryConsume() {
      if (used >= max) return false;
      used += 1;
      return true;
    },
    spent: () => used,
    remaining: () => Math.max(0, max - used),
    limit: () => max,
    reset() { used = 0; },
  };
}

/** Process-wide budget shared by the MCP spawn bridge. */
export const mcpSpawnBudget: SpawnBudget = createSpawnBudget();

/** Message shown to the agent whose spawn was refused, so it stops retrying and reports instead. */
export function spawnBudgetExhaustedMessage(budget: SpawnBudget): string {
  return `Canvas spawn budget exhausted (${budget.limit()} agent-driven spawns this session). `
    + "Reuse an existing agent, or ask the user to reset the budget.";
}
