/**
 * The realtime tools that connect any Live Voice surface (Code, Canvas, Chat) to the assistant brain:
 * `work_on` hands a request over, `confirm_action` carries the user's spoken yes or no. The names are
 * neutral on purpose: the voice and the brain are one assistant, and the model tends to say a tool's
 * name aloud ("let me ask Lotus").
 * A surface adds these to its own tools with `withAssistantTools`.
 */

import type { VoiceLiveTool } from "@/modules/voice-core/voice-adapter";
import type { AssistantBrain, BrainOutcome } from "./assistant-brain";
import type { AssistantReadback } from "./assistant-settings";

export const WORK_ON_TOOL_NAME = "work_on";
export const CONFIRM_ACTION_TOOL_NAME = "confirm_action";

export const WORK_ON_TOOL: VoiceLiveTool = {
  type: "function",
  name: WORK_ON_TOOL_NAME,
  description:
    "Do the user's request: read the project, git, tasks, GitHub and Notion, or build, fix, check or research something. Use for every question about the code or the work.",
  parameters: {
    type: "object",
    properties: {
      request: { type: "string", description: "The user's request in full, with every detail and constraint they said." },
      new_topic: { type: "boolean", description: "True only when the user says to start fresh ('new topic', 'topik baru')." },
    },
    required: ["request"],
  },
};

export const CONFIRM_ACTION_TOOL: VoiceLiveTool = {
  type: "function",
  name: CONFIRM_ACTION_TOOL_NAME,
  description: "The user's yes or no to the action work_on asked about.",
  parameters: {
    type: "object",
    properties: { approve: { type: "boolean", description: "True only when the user clearly said yes to that action." } },
    required: ["approve"],
  },
};

export const ASSISTANT_INSTRUCTION = [
  "For questions about the code or the work, and for anything to build, fix, check or research, call work_on with the user's full request. First say only a few words, like 'Let me check' or 'On it'. Never make up an answer.",
  "work_on is you doing the work, not someone else: never say you will ask, check with or get permission from anyone, and never name Lotus, an assistant or a tool.",
  "Never promise to ask before doing something; the app asks the user when an action needs a yes.",
  "When work_on returns a question, ask it exactly as given. Then call confirm_action with approve true only when the user clearly says yes; anything else is approve false.",
].join(" ");

/** What a tool call returns to the session; `silent` asks the provider not to speak after it. */
export type AssistantToolResult =
  | { ok: true; summary: string; speak: string; silent?: boolean }
  | { ok: false; error: string; speak?: string; silent?: boolean };

const SHORT_MAX_CHARS = 240;
const FULL_MAX_CHARS = 1_200;
const SUMMARY_MAX_CHARS = 160;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The first two sentences, for the short readback. */
export function firstSentences(text: string, count = 2): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?。]+[.!?。]+(\s|$)|[^.!?。]+$/g) ?? [flat];
  return clip(sentences.slice(0, count).join("").trim(), SHORT_MAX_CHARS);
}

/** A brain outcome as the voice should handle it, under the readback setting. */
export function assistantResult(outcome: BrainOutcome, readback: AssistantReadback): AssistantToolResult {
  switch (outcome.kind) {
    case "answer": {
      const summary = clip(firstSentences(outcome.text, 1), SUMMARY_MAX_CHARS);
      if (readback === "off") return { ok: true, summary, speak: "", silent: true };
      const speak = readback === "short" ? firstSentences(outcome.text) : clip(outcome.text.replace(/\s+/g, " ").trim(), FULL_MAX_CHARS);
      return { ok: true, summary, speak };
    }
    // Always spoken, whatever the readback: nothing risky runs without the user hearing it.
    case "approval":
      return { ok: true, summary: `Asks to ${outcome.action}`, speak: `This will ${outcome.action}. Should I go ahead?` };
    case "pending":
      return { ok: true, summary: "Still working", speak: "This is taking a while. Ask me again in a moment for the result." };
    case "error":
      return { ok: false, error: outcome.message, speak: "I couldn't do that." };
  }
}

export function isAssistantTool(name: string): boolean {
  return name === WORK_ON_TOOL_NAME || name === CONFIRM_ACTION_TOOL_NAME;
}

/** Runs `work_on` / `confirm_action`. Never throws. */
export async function executeAssistantTool(
  call: { name: string; args: Record<string, unknown> },
  deps: { brain: AssistantBrain; cwd: string; readback: AssistantReadback },
): Promise<AssistantToolResult> {
  try {
    if (call.name === CONFIRM_ACTION_TOOL_NAME) {
      return assistantResult(await deps.brain.decide(call.args.approve === true), deps.readback);
    }
    const request = typeof call.args.request === "string" ? call.args.request.trim() : "";
    if (!request) return { ok: false, error: "No request.", speak: "What should I do?" };
    return assistantResult(await deps.brain.ask(deps.cwd, request, { newTopic: call.args.new_topic === true }), deps.readback);
  } catch (error) {
    return assistantResult({ kind: "error", message: error instanceof Error ? error.message : String(error) }, deps.readback);
  }
}

/** A surface's instructions and tools with the assistant added. */
export function withAssistantTools(base: { instructions: string; tools: readonly VoiceLiveTool[] }): { instructions: string; tools: VoiceLiveTool[] } {
  return { instructions: `${base.instructions}\n\n${ASSISTANT_INSTRUCTION}`, tools: [...base.tools, WORK_ON_TOOL, CONFIRM_ACTION_TOOL] };
}
