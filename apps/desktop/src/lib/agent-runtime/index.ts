/**
 * Agent Runtime Kernel (ADR-0023).
 *
 * The module-neutral home for how Lotus launches an agent CLI and tracks its readiness.
 * Depended on by BOTH the Swarm Terminal Surface and CodeCanvas live agents, so a Live
 * Agent Session and a Swarm Agent Panel spawn an agent the same way. Neither surface owns it.
 *
 * Invariant: this kernel must NOT import from `@/modules/swarm/**` or `@/modules/codecanvas/**`.
 * It is a shared primitive, not a surface — keep it dependency-free of either UI module.
 */
export {
  type AgentRunnerType,
  type AgentPermissionMode,
  type RunnerSessionMode,
  isUngatedMode,
  resolveRunnerCommand,
  runnerSupportsResume,
  runnerSupportsPreMintedSession,
  runnerCanResume,
  applyRunnerSessionTemplate,
  isClaudeFamilyRunner,
} from "./agent-runner";

export {
  type AgentRunnerReadinessSignal,
  type AgentRunnerReadinessAdapter,
  type AgentRunnerReadinessTracker,
  getAgentRunnerReadinessAdapter,
  createAgentRunnerReadinessTracker,
} from "./agent-runner-readiness";

export { tokenizeForDirectSpawn, buildSpawnArgv } from "./spawn-argv";
