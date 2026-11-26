"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceLiveTool } from "@/modules/voice-core/voice-adapter";
import {
  createChatThread,
  renameChatThread,
  resolveChatInteraction,
  sendChatMessage,
  setChatStrictPermissions,
  subscribeChatThread,
  warmChatThread,
} from "@/modules/chat/runtime/chat-runtime-client";
import { readVoiceSetting, writeVoiceSetting, type VoiceSettingsSlot } from "@/modules/voice-core/voice-settings-storage";
import { createAssistantBrain, type AssistantBrain, type AssistantChatClient, type AssistantThreadStore } from "./assistant-brain";
import { getAssistantSettings, useAssistantSettings } from "./assistant-settings";
import { executeAssistantTool, isAssistantTool, withAssistantTools, type AssistantToolResult } from "./assistant-tools";

/** Which Chat thread is the brain for each folder, so it lives across Live Voice sessions. */
const ASSISTANT_THREADS_SLOT: VoiceSettingsSlot = { key: "lotus-voice-assistant-threads-v1" };

function readThreads(): Record<string, { threadId: string; config: string }> {
  try {
    const parsed: unknown = JSON.parse(readVoiceSetting(ASSISTANT_THREADS_SLOT) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, { threadId: string; config: string }>) : {};
  } catch {
    return {};
  }
}

const threadStore: AssistantThreadStore = {
  get: (cwd) => {
    const entry = readThreads()[cwd];
    return entry && typeof entry.threadId === "string" && typeof entry.config === "string" ? entry : null;
  },
  set: (cwd, value) => {
    const threads = readThreads();
    if (value) threads[cwd] = value;
    else delete threads[cwd];
    writeVoiceSetting(ASSISTANT_THREADS_SLOT, JSON.stringify(threads));
  },
};

const chatClient: AssistantChatClient = {
  createThread: (input) => createChatThread(input),
  lockPermissions: setChatStrictPermissions,
  rename: renameChatThread,
  warm: warmChatThread,
  send: (threadId, text) => sendChatMessage(threadId, text),
  subscribe: (threadId, onEvent, onReplayed) => subscribeChatThread({ threadId, afterSeq: 0, onEvent, onReplayed }),
  resolve: resolveChatInteraction,
};

export interface VoiceAssistant {
  /** The brain is on and there is a folder to run it in. */
  enabled: boolean;
  /** A request is with the brain and no answer is back yet: the composer says "Working on it…". */
  working: boolean;
  /** Called when a Live Voice session starts: readies the brain's thread before the first request. */
  prepare: () => void;
  /** A surface's instructions and tools, with `work_on` / `confirm_action` added when enabled. */
  decorate: (base: { instructions: string; tools: readonly VoiceLiveTool[] }) => { instructions: string; tools: readonly VoiceLiveTool[] };
  /** Whether this tool call is the assistant's. */
  handles: (name: string) => boolean;
  execute: (call: { name: string; args: Record<string, unknown> }) => Promise<AssistantToolResult>;
}

/**
 * The assistant brain for one Live Voice surface (Code, Canvas or Chat). `cwd` is the folder the
 * brain works in; null turns it off. One brain per mounted surface, closed on unmount.
 */
export function useVoiceAssistant(cwd: string | null | undefined): VoiceAssistant {
  const settings = useAssistantSettings();
  const enabled = settings.brain !== "off" && Boolean(cwd);
  const brainRef = useRef<AssistantBrain | null>(null);
  const cwdRef = useRef(cwd);
  useEffect(() => {
    cwdRef.current = cwd;
  });
  useEffect(
    () => () => {
      brainRef.current?.dispose();
      brainRef.current = null;
    },
    [],
  );

  const [inFlight, setInFlight] = useState(0);
  const brain = () => (brainRef.current ??= createAssistantBrain({ client: chatClient, store: threadStore, settings: getAssistantSettings }));
  const prepare = useCallback(() => {
    if (!enabled || !cwdRef.current) return;
    void brain().prepare(cwdRef.current);
  }, [enabled]);
  const decorate = useCallback<VoiceAssistant["decorate"]>((base) => (enabled ? withAssistantTools(base) : base), [enabled]);
  const handles = useCallback((name: string) => enabled && isAssistantTool(name), [enabled]);
  const execute = useCallback<VoiceAssistant["execute"]>(async (call) => {
    const folder = cwdRef.current;
    if (!folder) return { ok: false, error: "No folder is open.", speak: "Open a folder first." };
    setInFlight((count) => count + 1);
    try {
      return await executeAssistantTool(call, { brain: brain(), cwd: folder, readback: getAssistantSettings().readback });
    } finally {
      setInFlight((count) => count - 1);
    }
  }, []);

  return { enabled, working: inFlight > 0, prepare, decorate, handles, execute };
}
