// Spike (#276): can Lotus answer Claude's AskUserQuestion through canUseTool?
// The bridge today only allows or denies; this checks the answer path before the banner is built.
//
//   bun run scripts/chat-bridge/question-spike.ts
//
// Claude asks Red or Blue; the script answers Blue by allowing the call with `answers` added to the
// input. If Claude replies BLUE, the answer reached it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";

import { resolveClaudeExecutable } from "./resolve-claude";

const ANSWER = process.env.SPIKE_ANSWER ?? "Blue";
const t0 = Date.now();
const note = (line: string) => console.log(`+${String(Date.now() - t0).padStart(6)}ms  ${line}`);

const canUseTool: CanUseTool = async (toolName, input) => {
  note(`canUseTool ${toolName} ${JSON.stringify(input).slice(0, 300)}`);
  if (toolName !== "AskUserQuestion") return { behavior: "deny", message: "only AskUserQuestion in this spike" };
  const questions = (input.questions ?? []) as Array<{ question: string }>;
  const answers = Object.fromEntries(questions.map((q) => [q.question, ANSWER]));
  return { behavior: "allow", updatedInput: { ...input, answers } };
};

const q = query({
  prompt:
    `Use the AskUserQuestion tool to ask me one question: which colour I prefer, with exactly two options, Red and Blue${process.env.SPIKE_MULTI ? ", and let me pick more than one (multiSelect)" : ""}. ` +
    "After I answer, reply with only the colour I chose, in uppercase, and nothing else.",
  options: {
    cwd: mkdtempSync(join(tmpdir(), "lotus-question-spike-")),
    model: "haiku",
    permissionMode: "default",
    pathToClaudeCodeExecutable: resolveClaudeExecutable({ env: process.env }) ?? undefined,
    canUseTool,
  },
});

let result = "";
for await (const m of q) {
  if (m.type === "user" && Array.isArray(m.message.content)) {
    for (const c of m.message.content) if (c.type === "tool_result") note(`tool_result ${JSON.stringify(c.content).slice(0, 300)}`);
  }
  if (m.type === "result") {
    result = m.subtype === "success" ? m.result : m.subtype;
    note(`result ${JSON.stringify(result)}`);
  }
}
console.log(`verdict: ${result.toUpperCase().includes(ANSWER.split(",")[0].trim().toUpperCase()) ? "ANSWER REACHED CLAUDE" : "ANSWER LOST"}`);
