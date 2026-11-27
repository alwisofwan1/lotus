import type { TranscriptEntry } from "../../../types/transcript.js";
import { readUserQuestions } from "../questions.js";

/**
 * Reads the CLI's own `.jsonl` (`transcript_path`, slice 3.1), not a store of ours: the desktop's
 * in-memory ring evicts and resets on restart. Port of the Claude column of
 * `agent_hooks/transcript_source.rs`; Codex/Cursor are a gap (`plans/pocket-without-laptop/PLAN.md`).
 */

/** Keys tried, in order, for the argument that says what a tool touched. */
const TARGET_KEYS = ["command", "file_path", "path", "pattern", "url", "prompt"] as const;

/**
 * Every conversation entry in the file, oldest first.
 *
 * Unreadable lines are skipped: the last line of a live file can be half-written.
 */
export function readClaudeTranscript(contents: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    pushLine(value as Record<string, unknown>, entries);
  }
  return entries;
}

function pushLine(line: Record<string, unknown>, out: TranscriptEntry[]): void {
  const at = isoToMs(typeof line["timestamp"] === "string" ? line["timestamp"] : "");
  const message = line["message"];
  if (message === null || typeof message !== "object" || Array.isArray(message)) return;
  const content = (message as Record<string, unknown>)["content"];

  switch (line["type"]) {
    case "user":
      // A plain string is the operator typing; a list is tool results being fed back. Claude
      // sends both as `user`, so the **content shape** decides the meaning, not `type`.
      if (typeof content === "string") {
        if (content.trim().length > 0) out.push(promptEntry(content, at));
        return;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          // A `text` block in a user message is either the operator typing while a tool ran, or
          // the CLI's own note that they pressed Esc. The second ends the turn, and it is the
          // **only** record of that: no `stop` follows an interrupted call.
          if (isBlock(block) && block["type"] === "text") {
            const text = typeof block["text"] === "string" ? block["text"] : "";
            if (text.trim().length === 0) continue;
            out.push(INTERRUPTED.test(text) ? interruptedEntry(at) : promptEntry(text, at));
            continue;
          }
          if (!isBlock(block) || block["type"] !== "tool_result") continue;
          // `is_error` is what Esc leaves behind on a question, and what a refused tool leaves
          // on any other call — one word for both, and the one Chat already draws.
          const failed = block["is_error"] === true;
          const entry = toolEntry(failed ? "tool-post-failed" : "tool-post", "", "", at);
          const id = block["tool_use_id"];
          if (typeof id === "string" && id !== "") entry.toolCallId = id;
          const answers = failed ? undefined : answersFromResult(block["content"]);
          out.push(answers === undefined ? entry : { ...entry, answers });
        }
      }
      return;

    case "assistant":
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!isBlock(block)) continue;
        // `thinking` is skipped on purpose: it is not what Chat renders, and it is the largest
        // thing in these files by volume.
        if (block["type"] === "text") {
          const text = typeof block["text"] === "string" ? block["text"] : "";
          if (text.trim().length > 0) out.push(proseEntry(text, at));
        } else if (block["type"] === "tool_use") {
          const name = typeof block["name"] === "string" ? block["name"] : "";
          // **A question arrives here whole, and used to be dropped one line later.**
          // `AskUserQuestion` carries its questions, options and descriptions in the tool's own
          // input, and the CLI writes all of it to this file — but none of `TARGET_KEYS` is in
          // it, so the step reached the phone bare and Chat fell back to scraping the terminal
          // for words that were already on disk. Reported from a device 2026-09-09.
          const questions = name === "AskUserQuestion" ? readUserQuestions(block["input"]) : undefined;
          const entry = toolEntry("tool-pre", name, questions?.[0]?.question ?? toolTarget(block["input"]), at);
          const id = block["id"];
          if (typeof id === "string" && id !== "") entry.toolCallId = id;
          out.push(questions === undefined ? entry : { ...entry, questions });
        }
      }
      return;

    default:
      return;
  }
}

function isBlock(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The salient argument of a tool call, chosen the same way `payload-extractors.mjs` chooses it —
 * so a step read from the file and the same step read from a hook do not describe themselves
 * differently.
 */
function toolTarget(input: unknown): string {
  if (!isBlock(input)) return "";
  for (const key of TARGET_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return oneLine(value);
  }
  return "";
}

function promptEntry(text: string, at: number): TranscriptEntry {
  return {
    event: "prompt-submit",
    status: "running",
    title: "You",
    body: text,
    userPrompt: text,
    toolTarget: "",
    timestamp: at,
  };
}

function proseEntry(text: string, at: number): TranscriptEntry {
  return {
    event: "stop",
    status: "idle",
    title: "Finished working",
    body: text,
    userPrompt: "",
    toolTarget: "",
    timestamp: at,
  };
}

function toolEntry(event: string, name: string, target: string, at: number): TranscriptEntry {
  return {
    event,
    status: "running",
    title: name.length === 0 ? "Tool" : name,
    body: "",
    userPrompt: "",
    toolTarget: target,
    timestamp: at,
  };
}

/**
 * The `"Q"="A"` pairs in a question's result; the CLI writes two different openings, so the
 * pairs are read. `undefined` when none: an empty map would make every result look answered.
 */
function answersFromResult(content: unknown): Record<string, string[]> | undefined {
  const text = typeof content === "string" ? content : undefined;
  if (text === undefined) return undefined;
  const answers: Record<string, string[]> = {};
  for (const [, question, answer] of text.matchAll(/"([^"]+)"="([^"]*)"/g)) {
    if (question !== undefined && answer !== undefined) answers[question] = [answer];
  }
  return Object.keys(answers).length === 0 ? undefined : answers;
}

/** The CLI's own words for Esc, in both the shapes it writes them. */
const INTERRUPTED = /^\[Request interrupted by user/;

/** The same shape a Codex `turn_aborted` takes, so one rule closes the turn for both. */
function interruptedEntry(at: number): TranscriptEntry {
  const entry = toolEntry("error", "Interrupted", "interrupted", at);
  entry.status = "error";
  return entry;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]/g, " ").split(/\s+/).filter((part) => part.length > 0).join(" ");
}

/**
 * `2026-09-06T15:10:43.508Z` → epoch milliseconds, and **0** on anything unexpected.
 *
 * Zero, not a dropped entry: order comes from the file, not from this number.
 */
function isoToMs(text: string): number {
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * What this cell is *for*: `ai-title` (the CLI's rewritten summary) wins; `last-prompt` (the
 * operator's words, as the bridge uses for `headline`) is the fallback.
 */
export function claudeSessionHeadline(contents: string): string | undefined {
  let aiTitle: string | undefined;
  let lastPrompt: string | undefined;
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a half-written last line, as ever
    }
    if (record === null || typeof record !== "object") continue;
    const row = record as Record<string, unknown>;
    // Last one wins: the CLI rewrites both as the conversation moves on.
    if (row["type"] === "ai-title" && typeof row["aiTitle"] === "string") aiTitle = row["aiTitle"];
    if (row["type"] === "last-prompt" && typeof row["lastPrompt"] === "string") lastPrompt = row["lastPrompt"];
  }
  return firstLine(aiTitle) ?? firstLine(lastPrompt);
}

/** One line, trimmed. A pasted paragraph is a headline only as far as its first newline. */
function firstLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const line = value.split("\n")[0]?.trim() ?? "";
  return line === "" ? undefined : line;
}
