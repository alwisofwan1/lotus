import type { CapLevel, RunnerTranscriptCaps } from "../../../types/conversation.js";

/**
 * What each runner's transcript carries **through this host's pipeline today** (not what the
 * CLI could do in another mode), one level per part kind. Levels follow
 * `plans/pocket-chat-conversation-model/RESEARCH.md` §5.2; every `partial` has a reason beside it.
 */
const NONE: RunnerTranscriptCaps = level("never");

/** Claude Code and everything that runs the `claude` binary (`ccs`, `csp`, Claude-family custom). */
const CLAUDE: RunnerTranscriptCaps = {
  ...NONE,
  turns: "expected",
  text: "expected",
  toolCalls: "expected",
  // A call and its result are two hook events paired by name; nothing marks a call that
  // never returned, so `in_progress` at the end of a page is inferred, not reported.
  toolStatus: "partial",
  // `+n −n` from `structuredPatch` hunks, never the patch itself.
  diff: "partial",
  // Read off a terminal-tail scrape plus a `Notification` hook — options are real, the
  // request itself is not an event.
  permission: "partial",
};

/** Codex through `~/.codex/hooks.json` and the rollout file (`transcript_source.rs`). */
const CODEX: RunnerTranscriptCaps = {
  ...NONE,
  turns: "expected",
  text: "expected",
  toolCalls: "expected",
  toolStatus: "partial",
  // Counted from `unified_diff` in `patch_apply_end` / `FileChange` — per file, not the patch.
  diff: "partial",
  // `gating: runner_cannot` — Codex never asks through Lotus.
  permission: "never",
};

/**
 * Cursor CLI, via the Claude-format hooks from `~/.claude/settings.json` and the transcript they
 * report (`~/.cursor/projects/<slug>/agent-transcripts/`). Only tool hooks fire, so prompts and
 * prose come from the file and live steps from the hooks.
 */
const CURSOR: RunnerTranscriptCaps = {
  ...NONE,
  // Turn boundaries come from the file's `turn_ended` lines, never live.
  turns: "partial",
  text: "expected",
  toolCalls: "expected",
  toolStatus: "partial",
  // The file records `tool_use` only — no result, no diff.
  diff: "never",
  // `gating: runner_cannot`.
  permission: "never",
};

function level(l: CapLevel): RunnerTranscriptCaps {
  return {
    turns: l, text: l, streaming: l, reasoning: l, toolCalls: l, toolStatus: l, diff: l,
    output: l, permission: l, plan: l, subagent: l, usage: l, mode: l,
  };
}

/**
 * Capabilities for a fleet `agentType` (every Claude-family runner arrives as `claude`).
 * Unknown runners get `never`: understating is fixable, while an `expected` that never arrives
 * is an empty screen. Frozen.
 */
export function runnerTranscriptCaps(agentType: string | undefined): RunnerTranscriptCaps {
  switch (agentType) {
    case "claude":
      return { ...CLAUDE };
    case "codex":
      return { ...CODEX };
    case "cursor":
      return { ...CURSOR };
    default:
      return { ...NONE };
  }
}
