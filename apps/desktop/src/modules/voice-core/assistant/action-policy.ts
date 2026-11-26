/**
 * Which of the assistant brain's actions run without asking (mockups/live-voice-assistant.html,
 * decision 4). The brain runs in the "default" permission mode, so every action its CLI would ask
 * about reaches the app as a `toolPermission` interaction; this decides it. Enforced here, in the
 * app, never in the prompt: a misheard sentence must not be able to push, send or delete.
 *
 * Claude and Codex name actions the same way by the time they reach the app (Codex's translator
 * maps a command to "Bash", a patch to "Edit"/"Write", an MCP call to `mcp__<server>__<tool>`).
 */

import { riskyAsk, type ConfirmMode } from "@/modules/voice-core/risky-ask";

export type BrainActionVerdict = "allow" | "ask";

/** Built-in tools that only read or plan. */
const READ_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
  "TodoWrite",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

/** Lotus MCP tools that only look. A write, a send or a close is not here, so it asks. */
const LOTUS_READ_TOOLS = new Set([
  "lotus_list_fleet",
  "lotus_read_cell_output",
  "lotus_wait_cell_idle",
  "lotus_gather_results",
  "lotus_list_tasks",
  "lotus_get_task",
  "lotus_github_read",
  "lotus_notion_read",
  "lotus_notes_read",
  "lotus_chat_list",
  "lotus_chat_read",
  "lotus_chat_wait",
  "lotus_automation_list",
  "lotus_automation_options",
  "lotus_canvas_read_shapes",
  "lotus_canvas_list_participants",
  "lotus_canvas_read_assignment",
  "lotus_canvas_memory_list",
  "lotus_canvas_memory_search",
  "lotus_canvas_browser_snapshot",
  "lotus_canvas_browser_logs",
  "lotus_canvas_browser_annotation_latest",
]);

/** Read-only commands, by their first word (and git subcommand). */
const READ_COMMANDS = new Set(["ls", "cat", "head", "tail", "pwd", "wc", "grep", "rg", "find", "which", "echo", "date", "tree", "stat", "file"]);
const READ_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "blame", "ls-files", "describe", "shortlog"]);

/**
 * Anything that chains, redirects or substitutes is not one plain command, so it asks.
 * `find -exec/-delete` and `git branch -d` and friends write, so they ask too.
 */
const SHELL_META = /[;&|<>`$(){}\n\\]/;
const WRITING_FLAGS = /(^|\s)(-exec|-execdir|-delete|-ok|-fprint|-d|-D|-m|-M|--delete|--move|--set-upstream-to|--unset-upstream|-u|--output|--pre|--ext-diff)(\s|=|$)/;

export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim();
  if (!text || SHELL_META.test(text) || WRITING_FLAGS.test(text)) return false;
  const [first, second, ...rest] = text.split(/\s+/);
  if (first !== "git") return READ_COMMANDS.has(first);
  // `git branch x` and `git remote add …` create things; only their listing forms (flags only) read.
  if (second === "branch" || second === "remote") return rest.every((arg) => arg.startsWith("-"));
  return READ_GIT.has(second ?? "");
}

function mcpTool(toolName: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match ? { server: match[1], tool: match[2] } : null;
}

function field(input: unknown, key: string): unknown {
  return input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

/** Whether the brain may run this action now, or must ask the user first, under the confirm setting. */
export function classifyBrainAction(toolName: string, input: unknown, mode: ConfirmMode = "always"): BrainActionVerdict {
  if (mode === "off") return "allow";
  const strict = strictVerdict(toolName, input);
  if (strict === "allow" || mode === "always") return strict;
  // "auto": local, undoable work goes ahead; a command still asks when it is hard to undo or leaves
  // this machine, and so does every MCP write (sending, posting, closing reach other people).
  if (toolName === "Bash") {
    const command = field(input, "command");
    return typeof command === "string" && !riskyAsk(command, "none", "auto") ? "allow" : "ask";
  }
  if (EDIT_TOOLS.has(toolName)) return "allow";
  const mcp = mcpTool(toolName);
  if (mcp && /^lotus/.test(mcp.server) && mcp.tool === "lotus_chat_delegate") return "allow";
  return "ask";
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function strictVerdict(toolName: string, input: unknown): BrainActionVerdict {
  if (READ_TOOLS.has(toolName)) return "allow";
  if (toolName === "Bash") {
    const command = field(input, "command");
    return typeof command === "string" && isReadOnlyCommand(command) ? "allow" : "ask";
  }
  const mcp = mcpTool(toolName);
  // Only the Lotus server is known; another MCP server's tools could do anything.
  if (mcp && /^lotus/.test(mcp.server)) {
    if (LOTUS_READ_TOOLS.has(mcp.tool)) return "allow";
    // Delegating into a NEW worktree touches nothing the user has open; the work lands on its own branch.
    if (mcp.tool === "lotus_chat_delegate" && field(input, "worktree") === true) return "allow";
  }
  return "ask";
}

const MAX_SPOKEN_DETAIL = 120;

function short(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SPOKEN_DETAIL ? `${flat.slice(0, MAX_SPOKEN_DETAIL - 1)}…` : flat;
}

/** Plain words for the common risky git and gh commands; anything else, a chain too, is read out as written. */
function describeCommand(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  if (!/[;&|]/.test(flat)) {
    const [tool, verb, ...rest] = flat.split(" ").filter((word) => !word.startsWith("-"));
    const target = short(rest.join(" "));
    if (tool === "git" && verb === "push") {
      const force = /\s(--force(-with-lease)?|-f)(\s|$)/.test(flat) ? "force " : "";
      return target ? `${force}push to ${target}` : `${force}push your commits`;
    }
    if (tool === "git" && verb === "commit") return "commit the staged changes";
    if (tool === "git" && verb === "merge" && target) return `merge ${target}`;
    if (tool === "gh" && verb === "pr" && rest[0] === "create") return "open a pull request";
    if (tool === "gh" && verb === "pr" && rest[0] === "merge") return rest[1] ? `merge pull request ${rest[1]}` : "merge the pull request";
  }
  return `run the command ${short(flat)}`;
}

/** The action in a few words, for the spoken "may I?" question. */
export function describeBrainAction(toolName: string, input: unknown): string {
  const command = field(input, "command");
  if (toolName === "Bash" && typeof command === "string") return describeCommand(command);
  const path = field(input, "file_path") ?? field(input, "path");
  if ((toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") && typeof path === "string") {
    return `${toolName === "Write" ? "write" : "edit"} ${path.split("/").pop()}`;
  }
  const mcp = mcpTool(toolName);
  if (mcp) {
    const title = field(input, "title") ?? field(input, "text") ?? field(input, "prompt");
    const what = mcp.tool.replace(/^lotus_/, "").replace(/_/g, " ");
    return typeof title === "string" && title.trim() ? `${what}: ${short(title)}` : what;
  }
  return `use ${toolName}`;
}
