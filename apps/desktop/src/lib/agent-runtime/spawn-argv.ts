/**
 * Turns a runner's launch command into argv for the direct (shell-less) spawn path, where the CLI
 * becomes the PTY child itself.
 *
 * Why this exists at all: a command typed into a login shell is written before the shell has handed
 * the terminal over, and those bytes are consumed by a terminal about to be reconfigured — measured
 * in `packages/host/src/server/agent/tui-prompt.ts` on 2026-09-07. Spawning the CLI directly removes
 * the window rather than making it smaller.
 *
 * Extracted from `modules/codecanvas/services/live-agent-spawn.ts` (2026-09-09) so the Swarm launch
 * path shares the one tokenizer instead of growing a second, slowly diverging copy. ADR-0025 puts
 * runtime primitives used by more than one surface here.
 */

/**
 * Conservative tokenizer: the base command (runner + permission + session + extra flags) must be
 * plain whitespace-separated tokens. Any shell syntax — quotes, escapes, env prefixes, operators —
 * means we cannot reproduce the shell's parsing, so the caller stays on the shell path (argv null)
 * rather than guessing.
 */
export function tokenizeForDirectSpawn(base: string): string[] | null {
  if (/['"\\$&|;<>`(){}*?~#]/.test(base)) return null;
  const tokens = base.split(/\s+/).filter(Boolean);
  return tokens.length > 0 ? tokens : null;
}

/**
 * The base command's tokens followed by already-tokenized flag groups. Each group's elements ride
 * verbatim — `portable_pty` passes tokens through with no shell involved, so a system prompt or a
 * TOML effort value is ONE element and needs no quoting.
 */
export function buildSpawnArgv(
  baseCommand: string,
  ...argvGroups: readonly (readonly string[])[]
): string[] | null {
  const baseTokens = tokenizeForDirectSpawn(baseCommand);
  if (!baseTokens) return null;
  return [...baseTokens, ...argvGroups.flat()];
}
