import { buildAgentIdentityPreamble } from "@/lib/agent-catalog/identity-preamble";
import { buildSpawnArgv } from "@/lib/agent-runtime/spawn-argv";
import { isKnownProvider, resolve } from "@/modules/codespace/services/bridge/agent-registry";
import { detectFleetProvider } from "@/modules/codespace/services/bridge/fleet-naming";

/**
 * Telling a workspace pane's agent the name Lotus gave it.
 *
 * Lotus allocates a handle — `Milo`, `Nara` — before the CLI starts, draws it in the pane header,
 * the rail and `@mentions`, and until now never told the agent. Asked "who are you?", the agent
 * answered "Claude", which is true and is not the answer the operator was looking at.
 *
 * CodeCanvas has closed the same gap since ADR-0027 by appending an identity overlay to the
 * runner's system prompt. This is that mechanism, for the unified shell's panes, reusing both
 * halves rather than restating them: the prose comes from `lib/agent-catalog/identity-preamble`,
 * and whether a runner will even accept a system prompt comes from the agent registry.
 *
 * ── Two limits, stated rather than hidden ──
 *
 * 1. **Only a pane Lotus launches.** A `claude` the operator types into a shell pane by hand never
 *    passes through here, so it will not know its name. Nothing in a running CLI can be told
 *    afterwards without writing into the conversation, which is a different and louder trade.
 * 2. **Only the argv path.** The overlay is ~1.5 KB, and a command TYPED into a tty stalls at
 *    about 2.5 KB — the tty's input queue fills, the line discipline discards the rest, and no CLI
 *    ever starts (measured 2026-09-12, `plans/codecanvas-session-refactor/issues/08`). So the
 *    overlay is attached only when the command tokenizes into argv, where `portable_pty` passes it
 *    through with no shell and no length limit. A command carrying shell syntax keeps today's
 *    behaviour exactly: no overlay, shell path, nothing lost.
 */

/** Whether this runner accepts `--append-system-prompt`, as the registry states it. */
function acceptsSystemPrompt(agentCommand: string): boolean {
  const provider = detectFleetProvider(agentCommand);
  if (provider === "shell" || !isKnownProvider(provider)) return false;
  try {
    return resolve(provider).supportsAppendSystemPrompt === true;
  } catch {
    return false;
  }
}

export interface PaneLaunchInput {
  /** What the pane was asked to run, e.g. `claude --dangerously-skip-permissions`. */
  agentCommand?: string;
  /** The handle Lotus allocated for this pane. Absent = a shell, which gets no name. */
  agentName?: string;
  /** The other agents already open in this folder, as a spawn-time snapshot. */
  roster?: readonly string[];
}

/**
 * The PTY's argv for an agent pane, or `undefined` to keep the shell path.
 *
 * Replaces the inline rule it grew out of — "a single-word command runs directly, anything else
 * goes through a shell" — and preserves it: a command that cannot be tokenized safely still
 * returns `undefined`, and a single-word one still runs directly. What is new is that a runner
 * which accepts a system prompt now carries the identity overlay in its argv.
 */
export function buildPaneLaunchCommand(input: PaneLaunchInput): string[] | undefined {
  const agentCommand = input.agentCommand?.trim();
  if (!agentCommand) return undefined;

  const name = input.agentName?.trim();
  if (!name || !acceptsSystemPrompt(agentCommand)) {
    // Unchanged from before this file existed.
    return agentCommand.includes(" ") ? undefined : [agentCommand];
  }

  const preamble = buildAgentIdentityPreamble({
    name,
    roster: input.roster,
    surface: "workspace",
  });

  const argv = buildSpawnArgv(agentCommand, ["--append-system-prompt", preamble]);
  // `buildSpawnArgv` refuses a command it cannot reproduce (quotes, operators, env prefixes). That
  // refusal is the answer: fall back to exactly what this pane did before, overlay and all.
  if (argv) return argv;
  return agentCommand.includes(" ") ? undefined : [agentCommand];
}
