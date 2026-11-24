import type { AgentRunnerType } from "@/lib/agent-runtime";
import { NL_RUNNERS } from "./canvas-nl-command";
import { fuzzyMatchName, resolveRunnerAlias } from "./runner-fuzzy";

/**
 * Resolve an MCP `lotus_spawn_cell` request (`provider` + optional `runnerId` override) into a canvas
 * runner spec.
 *
 * `provider` is enum-constrained by the sidecar (claude/codex/…); `runnerId` is a free override.
 * Resolution order, `runnerId` first then `provider`:
 *   1. a native runner token (claude/codex/cursor/ccs/csp), spoken alias or fuzzy match → that runner.
 *   2. otherwise → claude (lenient default, mirrors the NL path).
 */
export interface McpSpawnRunnerSpec {
  runner: AgentRunnerType;
  /** Display label for feedback (the native runner id). */
  label: string;
}

const NL_RUNNER_SET = new Set<string>(NL_RUNNERS);

/**
 * Resolve ONE token through the full strategy ladder: exact native → spoken alias → fuzzy native. Returns null when nothing is close enough.
 */
function resolveOneToken(token: string): McpSpawnRunnerSpec | null {
  const lower = token.trim().toLowerCase();
  if (NL_RUNNER_SET.has(lower)) return { runner: lower as AgentRunnerType, label: lower };

  const aliased = resolveRunnerAlias(token);
  if (aliased && NL_RUNNER_SET.has(aliased)) return { runner: aliased as AgentRunnerType, label: aliased };

  const fuzzyNative = fuzzyMatchName(token, [...NL_RUNNERS]);
  if (fuzzyNative) return { runner: fuzzyNative as AgentRunnerType, label: fuzzyNative };

  return null;
}

export function resolveMcpSpawnRunner(
  provider: string | null | undefined,
  runnerId: string | null | undefined,
): McpSpawnRunnerSpec {
  // runnerId is the intent-bearing override — resolve it FULLY before considering the (enum-required,
  // often-default) provider, so a fuzzy match on runnerId wins over an exact-but-generic provider.
  for (const token of [runnerId, provider]) {
    const trimmed = token?.trim();
    if (!trimmed) continue;
    const spec = resolveOneToken(trimmed);
    if (spec) return spec;
  }
  return { runner: "claude", label: "claude" };
}
