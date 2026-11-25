"use client";
import type { S2sPhase } from "@/modules/voice-core/s2s-session";
import { liveVoiceStatusText } from "@/modules/voice-core/live-voice-strip";
import { ComposerTargetLabel, LiveVoiceControls } from "@/modules/workspace-shell/components/composer-voice-parts";
import { resolveS2sActivityHint } from "../services/voice/s2s-activity-hint";
import type { S2sHealthSnapshot } from "../services/voice/use-s2s-session";

export interface LiveVoiceComposerRowProps {
  phase: S2sPhase;
  agentSpeaking: boolean;
  health?: S2sHealthSnapshot;
  error?: string;
  /** End the session and give the bar back. Always available, from an error too. */
  onEnd: () => void;
  /** Open a fresh session after an error. Only offered in the error state. */
  onRetry?: () => void;
  micMuted?: boolean;
  onToggleMic?: () => void;
}

/** Sanitized transport health, for the status line's tooltip — never shown as primary copy. */
function describeHealth(health?: S2sHealthSnapshot): string | null {
  if (!health) return null;
  const parts = [
    health.socket !== "idle" ? `Socket ${health.socket}` : null,
    health.mic !== "idle" ? `Mic ${health.mic}` : null,
    health.playback !== "idle" ? `Playback ${health.playback}` : null,
    health.audioDeltas > 0 ? `Audio ${health.audioDeltas}` : null,
    typeof health.nativeQueueUsed === "number" && health.nativeQueueUsed > 0 ? `Queue ${health.nativeQueueUsed}` : null,
    typeof health.nativeDroppedAudioChunks === "number" && health.nativeDroppedAudioChunks > 0 ? `Dropped ${health.nativeDroppedAudioChunks}` : null,
    health.tools !== "idle" ? `Tool ${health.tools}${health.lastTool ? `: ${health.lastTool}` : ""}` : null,
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The command bar's Live Voice state (plans/composer-voice-ux ticket 09). It replaced the separate
 * voice-to-voice "transform" surface: the composer keeps its shape and says who it is talking to
 * ("→ Lotus"), what Live Voice is doing, and offers End. Children of the input row's grid, like the
 * field and the voice slot they stand in for.
 */
export function LiveVoiceComposerRow({ phase, agentSpeaking, health, error, onEnd, onRetry, micMuted, onToggleMic }: LiveVoiceComposerRowProps) {
  const isError = phase === "error";
  const healthText = describeHealth(health);
  const status = liveVoiceStatusText({
    phase,
    agentSpeaking,
    activity: resolveS2sActivityHint({ fallback: "Thinking…", phase, tools: health?.tools, lastTool: health?.lastTool }),
    error: error || health?.lastIssue,
  });
  return (
    <>
      <span className="canvas-nl-target">
        <ComposerTargetLabel target={{ label: "Lotus" }} />
      </span>
      <p
        className="ws-composer-live canvas-nl-live-row canvas-nl-live-voice"
        data-state={isError ? "error" : phase}
        role="status"
        aria-live="polite"
        title={healthText ?? undefined}
      >
        {status}
      </p>
      <span className="canvas-nl-voice-actions">
        <LiveVoiceControls
          phase={phase}
          agentSpeaking={agentSpeaking}
          onEnd={onEnd}
          onRetry={onRetry}
          micMuted={micMuted}
          onToggleMic={onToggleMic}
        />
      </span>
    </>
  );
}
