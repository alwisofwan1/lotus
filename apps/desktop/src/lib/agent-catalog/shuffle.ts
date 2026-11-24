/**
 * Fisher–Yates shuffle (slice 03 of `plans/codespace-agent-naming/`).
 *
 * `name-pool.ts` is a deterministic leaf on purpose — its own docstring calls that out as a
 * deliberate contract ("no `Math.random()` / `Date.now()`"), and `name-pool.test.ts` locks
 * `nextAgentName([])` to always return `DEFAULT_AGENT_NAME_POOL[0]`. Shuffling therefore does
 * NOT belong inside that leaf. It belongs at the call sites that draw a pool: `nextAgentName`
 * and `uniqueAgentName` already accept `pool` as a parameter for exactly this, so a caller
 * passes in a pre-shuffled array instead.
 */

/**
 * Returns a new array containing every element of `pool` in a random order. Never mutates
 * `pool`. `rng` is injectable (defaults to `Math.random`) so callers — tests included — can get
 * a deterministic permutation.
 */
export function shuffled<T>(pool: readonly T[], rng: () => number = Math.random): T[] {
  const out = pool.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
