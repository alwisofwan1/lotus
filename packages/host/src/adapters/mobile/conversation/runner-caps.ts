import type { CapLevel, RunnerTranscriptCaps } from "../../../types/conversation.js";

/**
 * What each runner's transcript can carry **through this host's pipeline today**.
 *
 * Not what the CLI could do in some other mode: Codex has streaming deltas and first-class
 * approvals in `app-server`, and none of that reaches Lotus while a cell is a PTY with a
 * hook installed. The table says what the phone will actually receive, so the honest
 * sentence per section ("Codex does not report reasoning here") can be written from it —
 * one level per part kind where `transcriptOutlook` had one bit for the whole pane.
 *
 * Levels follow the matrix in `plans/pocket-chat-conversation-model/RESEARCH.md` §5.2,
 * narrowed to the pipeline that exists: hooks + the runner's own file, reshaped by
 * `parts-from-entries.ts`. Every `partial` below has a reason in the comment beside it.
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
 * Cursor CLI, through the Claude-format hooks it loads from `~/.claude/settings.json` and
 * the transcript file they report (`~/.cursor/projects/<slug>/agent-transcripts/`). Probe
 * 2026-08-27: tool hooks fire, `UserPromptSubmit`/`Stop` do not, and `~/.cursor/hooks.json`
 * entries never run — so prompts and prose come from the file, live steps from the hooks.
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
 * Capabilities for a fleet `agentType` (`FleetMember.agentType`, the desktop's collapsed
 * provider: every Claude-family runner arrives as `claude`).
 *
 * Unknown runners get `never` across the board — understating is the error worth making,
 * since a `never` the phone can see is fixable and an `expected` that never arrives is the
 * empty screen this whole shape exists to end. Frozen so a caller cannot edit the table.
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
