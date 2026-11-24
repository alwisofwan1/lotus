import { isClaudeFamilyRunner, type AgentRunnerType } from "@/lib/agent-runtime";
import {
  KITTY_SHIFT_ENTER_SEQUENCE,
  META_ENTER_SEQUENCE,
} from "@/modules/codespace/services/terminal-keybindings";

/**
 * Which bytes a live-agent terminal should send for Shift+Enter so the agent CLI inserts a
 * newline instead of submitting. Claude-family CLIs accept the kitty CSI-u encoding raw; other
 * TUIs get Meta+Enter, the conventional newline-insert chord.
 */
export function resolveLiveAgentShiftEnterSequence(
  runner: AgentRunnerType | undefined,
  claudeFamilyOverride?: boolean,
): string {
  return isClaudeFamilyRunner(runner, claudeFamilyOverride)
    ? KITTY_SHIFT_ENTER_SEQUENCE
    : META_ENTER_SEQUENCE;
}
