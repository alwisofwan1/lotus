"use client";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { LiveVoiceStripState } from "@/modules/voice-core/live-voice-strip";
import type { VoiceLiveTools } from "@/modules/voice-core/voice-adapter";
import { useCanvasBehaviorSettings } from "@/modules/codecanvas/hooks/useCanvasBehaviorSettings";
import { resolveS2sAutoEndPolicy } from "@/modules/codecanvas/services/voice/s2s-auto-end-policy";
import { useCommandBarLiveVoice, type CommandBarLiveVoice } from "@/modules/codecanvas/services/voice/use-command-bar-live-voice";
import { useLiveVoiceStripRecorder } from "@/modules/codecanvas/services/voice/use-live-voice-strip-recorder";
import {
  codeLiveVoiceContextKey,
  createCodeLiveVoiceTools,
  executeCodeLiveVoiceTool,
  type CodeLiveVoiceDeps,
} from "../services/code-live-voice-tools";

export interface CodeLiveVoice {
  live: CommandBarLiveVoice;
  /** The conversation so far, for the strip above the composer. Starts empty with each session. */
  strip: LiveVoiceStripState;
  /** What the session advertises, and the executor it calls — the Code Voice Adapter's `liveTools`. */
  liveTools: VoiceLiveTools;
}

/**
 * Live Voice in Code (plans/composer-voice-ux ticket 10): the Voice Core session, unchanged, with the
 * Code tools acting on the panes. The session reducer, Speaker Queue, reconnect and auto-end are the
 * ones Canvas runs; only the tools and the instructions are Code's.
 */
export function useCodeLiveVoice(input: Omit<CodeLiveVoiceDeps, "pendingClose">): CodeLiveVoice {
  // One "Close …?" at a time, kept across renders until it is answered.
  const pendingClose = useRef<string | null>(null);
  const deps: CodeLiveVoiceDeps = { ...input, pendingClose };
  // Deps are fresh closures every render; a tool call acts on the panes as they are when it runs.
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });
  const { strip, recordTranscript, recordTool, noteTurn, reset } = useLiveVoiceStripRecorder();

  // The provider is told again only when what it is told changes, not on every render. Built from
  // THIS render's deps: the ref is only updated after render, so it would describe the panes as they
  // were one render ago — and the render after has the same key, so a spawned agent was never told.
  const contextKey = codeLiveVoiceContextKey(deps);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt on what the tools say, keyed above
  const advertised = useMemo(() => createCodeLiveVoiceTools(deps), [contextKey]);
  const execute = useCallback(
    (call: { callId: string; name: string; args: Record<string, unknown> }) =>
      recordTool(call, () => executeCodeLiveVoiceTool(call, depsRef.current)),
    [recordTool],
  );
  const onConciergeAction = useCallback((_action: unknown, call: { callId: string; name: string; args: Record<string, unknown> }) => execute(call), [execute]);
  const liveTools = useMemo<VoiceLiveTools>(
    () => ({ instructions: advertised.instructions, tools: advertised.tools, execute }),
    [advertised, execute],
  );

  const advertisedTools = useMemo(() => [...advertised.tools], [advertised]);
  const { voiceAutoCloseAfterCommand } = useCanvasBehaviorSettings();
  const autoEndPolicy = useMemo(
    () => resolveS2sAutoEndPolicy({ autoCloseAfterCommand: voiceAutoCloseAfterCommand }),
    [voiceAutoCloseAfterCommand],
  );
  const session = useCommandBarLiveVoice({
    instructions: liveTools.instructions,
    realtimeTools: advertisedTools,
    onTranscript: recordTranscript,
    onConciergeAction,
    autoEndPolicy,
  });
  useEffect(() => noteTurn(session.turn), [noteTurn, session.turn]);

  // A new session starts with an empty strip; the last one's stays readable until then.
  const live: CommandBarLiveVoice = {
    ...session,
    start: () => {
      reset();
      return session.start();
    },
  };
  return { live, strip, liveTools };
}
