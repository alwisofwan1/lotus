import type { RealtimeTool } from "./s2s-concierge-bridge";

/**
 * Model-driven session end for Live Voice.
 *
 * The realtime model is the best multilingual intent detector we have, but until now it had no way to
 * end the session itself — it could only mutate the canvas, and ending relied on a hardcoded phrase
 * matcher (`s2s-end-voice-intent.ts`). This tool lets the model close the session on ANY natural
 * sign-off ("bye", "that's all", "udah cukup", ...) after speaking a one-line farewell, so the user
 * can stop hands-free without touching the keyboard.
 *
 * The tool is advertised via the realtime `session.update` and intercepted by the session hook
 * (`use-s2s-session.ts`): the hook lets the farewell audio play, then tears the session down.
 */

export const S2S_END_CONVERSATION_TOOL_NAME = "end_conversation";

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
