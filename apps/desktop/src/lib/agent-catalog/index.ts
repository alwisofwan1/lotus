/**
 * Shared agent-catalog seam (ADR-0026).
 *
 * The module-neutral home for agent-catalog primitives consumed by CodeCanvas (and, optionally,
 * Swarm). Like `src/lib/agent-runtime/`, this seam must NOT import from `@/modules/swarm/**` or
 * `@/modules/codecanvas/**` — it is a shared primitive, not a UI surface.
 *
 * Currently exports the spawn-first auto-naming core (PLAN §3.5 / NP.2 + NP.5).
 */
export {
  DEFAULT_AGENT_NAME_POOL,
  UNIVERSAL_AGENT_NAME_POOL,
  JA_AGENT_NAME_POOL,
  ID_AGENT_NAME_POOL,
  type NameValidation,
  normalizeName,
  nextAgentName,
  resolveNamePool,
  uniqueAgentName,
  validateAgentName,
} from "./name-pool";
export { shuffled } from "./shuffle";
