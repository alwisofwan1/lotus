import { isClaudeFamilyRunner, type AgentRunnerType } from "@/lib/agent-runtime";
import {
  KITTY_SHIFT_ENTER_SEQUENCE,
  META_ENTER_SEQUENCE,
} from "@/modules/codespace/services/terminal-keybindings";

/**
 * Runners whose CLI is Claude Code underneath, spelled the way a CodeSpace pane records them in
 * `agentCommand` (the launch command, not a registry entry). `ccs`/`csp` are `claude --profile …`.
 */
const CLAUDE_FAMILY_COMMAND_HEADS: ReadonlySet<AgentRunnerType> = new Set<AgentRunnerType>(["claude", "ccs", "csp"]);

function runnerFromAgentCommand(agentCommand: string | undefined): AgentRunnerType | null {
  const head = agentCommand?.trim().toLowerCase().split(/\s+/)[0];
  if (!head) return null;
  return CLAUDE_FAMILY_COMMAND_HEADS.has(head as AgentRunnerType) ? head as AgentRunnerType : "custom";
}

/**
 * Which bytes Shift+Enter should send so the pane inserts a newline instead of submitting.
 *
 * Claude-family CLIs accept the kitty CSI-u encoding raw, with no protocol negotiation. Everything
 * else — other agent TUIs and plain shells — gets Meta+Enter, which zsh treats as newline-insert
 * and bash's emacs keymap ignores. A pane with no agent command is a shell, so it must not inherit
 * the "assume claude" default that agent-runner helpers use.
 */
export function resolveTerminalShiftEnterSequence(agentCommand: string | undefined): string {
  const runner = runnerFromAgentCommand(agentCommand);
  return runner && isClaudeFamilyRunner(runner)
    ? KITTY_SHIFT_ENTER_SEQUENCE
    : META_ENTER_SEQUENCE;
}
