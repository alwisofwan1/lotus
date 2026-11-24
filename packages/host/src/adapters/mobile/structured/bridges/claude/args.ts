import { APPROVAL_PROMPT_TOOL } from "./approval-script.js";
import type { ClaudeSessionOptions } from "./session.js";

/**
 * The flags a headless Claude cell is started with.
 *
 * `--include-partial-messages` is on because streaming text is the point of this mode; the
 * whole `assistant` message still follows and settles it, so a client that ignores deltas
 * loses nothing. `--verbose` is required by the CLI alongside `--print` + `stream-json`.
 */
export function buildArgs(opts: ClaudeSessionOptions, mcpConfig?: string): string[] {
  return [
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    ...(opts.permissionMode === undefined ? [] : ["--permission-mode", opts.permissionMode]),
    ...(opts.model === undefined ? [] : ["--model", opts.model]),
    ...(opts.effort === undefined ? [] : ["--effort", opts.effort]),
    ...(opts.resumeSessionId === undefined ? [] : ["--resume", opts.resumeSessionId]),
    ...(opts.readableDir === undefined ? [] : ["--allowedTools", `Read(/${opts.readableDir.replace(/\/+$/, "")}/**)`]),
    // The approval route. Without it the runner still runs, and `--permission-mode` alone
    // decides — which means anything that would have asked is refused instead.
    ...(mcpConfig === undefined
      ? []
      : ["--permission-prompt-tool", APPROVAL_PROMPT_TOOL, "--mcp-config", mcpConfig]),
  ];
}
