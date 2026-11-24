import type { ThreadItem } from "./thread-event";

// A step that deletes or overwrites for good gets a danger tone, so "deleted 11 threads" does not
// read like "read a file". A hint, not a gate: it never blocks or asks.
// shortcut: token heuristics, not a shell parser; quoted or aliased commands can slip through.

const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "trash", "srm"]);
const VERBS = new Set(["delete", "destroy", "purge", "drop", "rm", "remove", "prune", "uninstall", "wipe"]);
const GIT = /^(reset\s+--hard|clean\s+-\S*f|push\b.*\s(--force(-with-lease)?|-f)\b|branch\s+-D\b|stash\s+(drop|clear)\b)/;

function segmentDestroys(segment: string): boolean {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  while (words.length > 0 && (/^\w+=/.test(words[0]) || words[0] === "sudo" || words[0] === "command")) words.shift();
  if (words.length === 0) return false;
  const program = words[0].split("/").pop() ?? "";
  const rest = words.slice(1).join(" ");
  if (DELETERS.has(program)) return true;
  if (program === "git") return GIT.test(rest);
  if (program === "find") return /(^|\s)-delete\b/.test(rest);
  // A subcommand comes before its flags: `gh repo delete x`, `bb thread delete id`, `docker rm -f`.
  // Stopping at the first flag keeps `bun test --grep delete` quiet.
  for (const word of words.slice(1, 4)) {
    if (word.startsWith("-") || /["']/.test(word)) break;
    if (VERBS.has(word.toLowerCase())) return true;
  }
  return false;
}

/** True when a command line has a part that deletes or force-overwrites. */
export function commandDestroys(command: string): boolean {
  return command.split(/&&|\|\||[;|\n]/).some(segmentDestroys);
}

const TOOL_VERB = /(^|[_\-.])(delete|remove|trash|destroy|purge|drop)([_\-.]|$)/i;
const INPUT_VERB = /"(action|operation|op|mode)"\s*:\s*"(delete|remove|trash|destroy|purge)"/i;

export function itemDestroys(item: ThreadItem): boolean {
  if (item.kind === "command") return commandDestroys(item.command);
  if (item.kind === "tool") {
    if (TOOL_VERB.test(item.name)) return true;
    try {
      return INPUT_VERB.test(JSON.stringify(item.input) ?? "");
    } catch {
      return false;
    }
  }
  return false;
}
