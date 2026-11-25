import type { RealtimeTool } from "./s2s-concierge-bridge";

/**
 * Model-driven session end for Live Voice.
 *
 * The realtime model is the best multilingual intent detector we have, but until now it had no way to
 * end the session itself — it could only mutate the canvas, and ending relied on a hardcoded phrase
 * matcher. This tool lets the model close the session on ANY natural
 * sign-off ("bye", "that's all", "udah cukup", ...) after speaking a one-line farewell, so the user
 * can stop hands-free without touching the keyboard.
 *
 * The tool is advertised via the realtime `session.update` and intercepted by the session hook
 * (`use-s2s-session.ts`): the hook lets the farewell audio play, then tears the session down.
 */

export const S2S_END_CONVERSATION_TOOL_NAME = "end_conversation";

/** The one instruction line every Live Voice surface gives the model about ending. */
export const S2S_END_CONVERSATION_INSTRUCTION =
  "Call end_conversation only when the user's own words say they are done with live voice — 'bye', 'Lotus, sleep', 'tidur dulu', 'udah cukup ya', in any language — with a short farewell. Never end because the user paused, thanked you mid-task, or began a request with 'that's all' or 'itu aja'. If the app refuses, keep helping. Never just say goodbye: saying it does not close the session, only the tool does.";

export const S2S_DEFAULT_FAREWELL = "Okay — ending live voice.";

export const S2S_END_CONVERSATION_TOOL: RealtimeTool = {
  type: "function",
  name: S2S_END_CONVERSATION_TOOL_NAME,
  description:
    "End the live voice session when the user clearly signals they are done (e.g. 'bye', 'that's all', 'stop listening', 'udah cukup', 'dadah') in any language. Speak a short farewell, then the session closes. Do not call this just because the user paused or thanked you mid-task.",
  parameters: {
    type: "object",
    properties: {
      farewell: {
        type: "string",
        description: "A short spoken sign-off in the user's language, e.g. 'Sure — closing now. Bye!'.",
      },
    },
    required: [],
  },
};

export function isS2sEndConversationCall(name: string): boolean {
  return name === S2S_END_CONVERSATION_TOOL_NAME;
}

/** The farewell the model wants spoken, or a safe default when it omits or blanks the arg. */
export function resolveS2sEndFarewell(args: Record<string, unknown>): string {
  const raw = args.farewell;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return S2S_DEFAULT_FAREWELL;
}

/** A sign-off is short ("go to sleep", "tidur dulu"); a work request that merely starts with "itu aja" is
 *  not. Counted on the LAST sentence only, because people thank first: "Oke, thank you so much. Go to sleep." */
export const S2S_END_MAX_WORDS = 5;

/**
 * The app's veto over the model's `end_conversation` call. The model judges intent in any language;
 * this checks the evidence: the user's own last words for this turn are a short sign-off, and no task
 * is still running. Returns why the session must stay open, or null to end it.
 */
export function s2sEndRefusal(lastUserWords: string | null, taskRunning: boolean): string | null {
  if (taskRunning) return "Not ended: a task is still running. Keep helping.";
  const lastSentence = (lastUserWords ?? "").split(/[.!?。]+/).map((part) => part.trim()).filter(Boolean).at(-1) ?? "";
  const words = lastSentence.split(/\s+/).filter(Boolean).length;
  if (words === 0) return "Not ended: the user has not said anything this turn. Keep listening.";
  if (words > S2S_END_MAX_WORDS) return "Not ended: the user's last words were a request, not a sign-off. Keep helping.";
  return null;
}
