"use client";

/*
  The voice parts of a composer, drawn once for both composers that take voice: the shell's
  `UnifiedComposer` and the Canvas command bar (plans/composer-voice-ux, "Shared voice parts"). The
  composers themselves stay separate; what voice looks like and how its slot behaves does not.
  Styles: `@/styles/composer-voice.css`.
*/

import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowRight, ArrowUp, AudioLines, Check, Command, Loader2, Lock, Mic, MicOff, RotateCcw, Square, Wrench, X } from "lucide-react";
import type { PaneActivity, PaneKind } from "@/modules/workspace-shell/types";
import { ActivityBadge } from "@/modules/workspace-shell/components/ActivityBadge";
import { KindIcon } from "@/modules/workspace-shell/components/kind-glyph";
import { SPECTRUM_BAND_COUNT } from "@/modules/voice-core/spectrum-visual";
import { formatVoiceDuration, type LiveVoiceStripState, type LiveVoiceStripTurn } from "@/modules/voice-core/live-voice-strip";
import type { S2sPhase } from "@/modules/voice-core/s2s-session";
import { detectCanvasHotkeyPlatform, formatChord, type CanvasHotkeyPlatform } from "@/modules/codecanvas/services/canvas-hotkeys";
import {
  getVoiceHotkeyBindings,
  subscribeVoiceHotkeys,
  VOICE_HOTKEY_UNBOUND,
  type VoiceHotkeyId,
} from "@/modules/voice-core/voice-hotkeys";

export type ComposerVoicePhase = "idle" | "starting" | "recording" | "transcribing" | "delivering";

/** Push-to-Talk as a composer sees it. */
export interface ComposerVoice {
  phase: ComposerVoicePhase;
  /** Live partial transcript while recording. */
  interim: string;
  onToggle: () => void;
  /** Drops the turn. Without it the listening row has no ✕ (Escape may still cancel). */
  onCancel?: () => void;
  /** Receives the root element; the caller writes the live mic level to it as `--voice-level`. */
  levelTarget?: (element: HTMLElement | null) => void;
  /** The Push-to-Talk key as printed ("⌥⇧Space"), named in the tooltip and the stop hint. */
  hotkey?: string | null;
  /** False = no voice provider is set. The mic still shows, looking unavailable; a click says why. */
  available?: boolean;
  /** This turn started with the key held down: letting go finishes it. Otherwise it was tapped. */
  held?: boolean;
}

/** Live Voice, offered in the slot while the field is empty. */
export interface ComposerLiveVoice {
  /** The Live Voice key as printed ("⌘⇧L"). */
  hotkey?: string | null;
  onStart: () => void;
}

/** A running Live Voice session as a composer sees it: the composer becomes its state. */
export interface ComposerLiveSession {
  /** Connecting through speaking, or showing an error. */
  active: boolean;
  phase: S2sPhase;
  agentSpeaking: boolean;
  error?: string;
  providerName: string | null;
  strip: LiveVoiceStripState;
  onEnd: () => void;
  onRetry?: () => void;
  micMuted?: boolean;
  onToggleMic?: () => void;
}

function voiceKeyLabel(id: VoiceHotkeyId): string | null {
  const chord = getVoiceHotkeyBindings()[id];
  if (chord === VOICE_HOTKEY_UNBOUND) return null;
  const platform = detectCanvasHotkeyPlatform();
  return formatChord(chord, platform).join(platform === "mac" ? "" : "+");
}

/** A voice key as the slot's tooltips and the stop hint print it ("⌥⇧Space"); null when unbound. */
export function useVoiceKeyLabel(id: VoiceHotkeyId): string | null {
  return useSyncExternalStore(subscribeVoiceHotkeys, () => voiceKeyLabel(id), () => null);
}

/**
 * The listening row's state: while the mic is open or the words are transcribed, what was heard so
 * far replaces the field as REAL text — not a placeholder, which only shows while the field is
 * empty, so with anything typed the live transcript used to be invisible for the whole turn. The
 * last words heard stay, dimmed, while transcribing. `typed` is what the field holds.
 */
export function useListeningRow(phase: ComposerVoicePhase, interim: string, typed: string) {
  const listening = phase === "starting" || phase === "recording";
  const settling = phase === "transcribing" || phase === "delivering";
  const [lastHeard, setLastHeard] = useState("");
  const words = interim.trim();
  if (listening && words && words !== lastHeard) setLastHeard(words);
  if (phase === "idle" && lastHeard) setLastHeard("");
  const heard = listening ? words : settling ? lastHeard : "";
  // The waveform takes the empty row while nothing has been said, then steps aside for the words.
  const waveInline = phase === "recording" && !heard && !typed.trim();
  return {
    listening,
    settling,
    voiceRow: listening || settling,
    heard,
    waveInline,
    waveTrailing: (listening || settling) && phase !== "starting" && !waveInline,
  };
}

/** How this turn stops, then the two keys every turn takes (ADR-0064). */
export function voiceStopHint(
  voice: Pick<ComposerVoice, "held" | "hotkey">,
  platform: CanvasHotkeyPlatform = detectCanvasHotkeyPlatform(),
): string {
  const finish =
    voice.held && voice.hotkey
      ? `Release ${voice.hotkey} to finish`
      : voice.hotkey
        ? `Press ${voice.hotkey} again or ✓ to finish`
        : "Press ✓ to finish";
  // Spelled out, as the mockup has it: the ↵ glyph reads as noise in a sentence.
  const sendKey = platform === "mac" ? "⌘Enter" : "Ctrl+Enter";
  return `${finish} · ${sendKey} finishes and sends · Esc cancels`;
}

/**
 * Where Enter goes. `locked` = the text was spoken for this target and focus has moved since: Enter
 * still sends it there. `command` = the field is a command line (⌘K), not a message.
 */
export function ComposerTargetLabel({
  target,
  command,
}: {
  target: { kind?: PaneKind; label: string; activity?: PaneActivity; locked?: boolean } | null;
  command?: boolean;
}) {
  if (command) {
    // The field looks the same in both modes, so it has to SAY which one it is in.
    return (
      <span className="ws-composer-target" data-command="true">
        <Command size={12} strokeWidth={2} />
        Command
      </span>
    );
  }
  if (!target) return null;
  return (
    <span
      className="ws-composer-target"
      data-kind={target.kind}
      data-locked={target.locked ? "true" : undefined}
      title={target.locked ? `Kept for ${target.label} — Enter sends there` : target.label}
    >
      {/* "To", then the target's state: where the message goes and whether that agent is busy. */}
      <ArrowRight size={11} strokeWidth={2} className="ws-composer-target-to" aria-hidden />
      {target.locked ? <Lock size={11} strokeWidth={2} data-lock aria-hidden /> : null}
      {target.activity ? <ActivityBadge activity={target.activity} compact /> : null}
      {target.kind ? <KindIcon kind={target.kind} size={13} /> : null}
      <span className="ws-composer-target-label">{target.label}</span>
    </span>
  );
}

/**
 * The right-hand slot. While listening: stop. While transcribing: a spinner. Otherwise the mic is
 * there whenever voice is wired and the command sheet is closed (speaking adds to what is typed),
 * Live Voice only while the field is empty, and Send once there is text.
 */
export function VoiceSlot({
  voice,
  liveVoice,
  empty,
  sheetOpen,
  canSend,
  onSend,
}: {
  voice?: ComposerVoice;
  liveVoice?: ComposerLiveVoice;
  empty: boolean;
  sheetOpen: boolean;
  canSend: boolean;
  onSend: () => void;
}) {
  const phase = voice?.phase ?? "idle";
  if (voice && (phase === "starting" || phase === "recording")) {
    return (
      <span className="ws-composer-ring">
        <button
          type="button"
          className="ws-round-button"
          data-variant="voice"
          data-state={phase}
          aria-label="Stop dictating"
          aria-pressed
          title="Stop and transcribe"
          onClick={voice.onToggle}
        >
          <Check size={16} strokeWidth={2.25} />
        </button>
      </span>
    );
  }
  if (voice && (phase === "transcribing" || phase === "delivering")) {
    return (
      <span className="ws-round-button" data-variant="voice" data-state={phase} aria-label="Transcribing" role="img">
        <Loader2 size={16} strokeWidth={2} className="ws-composer-spin" />
      </span>
    );
  }
  const unavailable = voice?.available === false;
  return (
    <>
      {voice && !sheetOpen ? (
        <button
          type="button"
          className="ws-round-button"
          data-variant="voice"
          data-unavailable={unavailable ? "true" : undefined}
          aria-label="Dictate"
          aria-pressed={false}
          title={
            unavailable
              ? `Dictate${voice.hotkey ? ` (${voice.hotkey})` : ""} — needs a voice provider in Settings › Voice`
              : voice.hotkey
                ? `Dictate — hold ${voice.hotkey}, or click`
                : "Dictate"
          }
          onClick={voice.onToggle}
        >
          <Mic size={16} strokeWidth={1.75} />
        </button>
      ) : null}
      {liveVoice && empty && !sheetOpen ? (
        <button
          type="button"
          className="ws-round-button"
          data-variant="live"
          aria-label="Live Voice"
          title={liveVoice.hotkey ? `Talk with Lotus — ${liveVoice.hotkey}` : "Talk with Lotus"}
          onClick={liveVoice.onStart}
        >
          <AudioLines size={16} strokeWidth={1.75} />
        </button>
      ) : null}
      {/* With voice, an empty field has nothing to send: the voice buttons are the whole slot. */}
      {(voice || liveVoice) && empty && !sheetOpen ? null : (
        <button type="button" className="ws-round-button" data-variant="send" aria-label="Send" disabled={!canSend} onClick={onSend}>
          <ArrowUp size={16} strokeWidth={2} />
        </button>
      )}
    </>
  );
}

/**
 * A **Held Prompt** (ADR-0064): spoken text waiting, unsent, in an agent's own prompt. Inline, so it
 * shares the composer's one note line with whatever else that line says.
 */
export function HeldPromptNote({
  label,
  cleaned,
  empty,
  joinsMessage,
}: {
  label: string;
  cleaned?: boolean;
  /** The field is empty, so Enter sends the Held Prompt. */
  empty: boolean;
  /** A typed message goes to the same agent: Enter sends the two as one message. */
  joinsMessage?: boolean;
}) {
  return (
    <>
      In {label}&apos;s prompt
      {cleaned ? " · Cleaned up by AI" : null}
      {empty ? " · Enter to send" : joinsMessage ? " · Enter sends both" : null} · Esc to clear
    </>
  );
}

/** mm:ss since the mic opened. Mounted only while listening, so it starts at 0:00 every turn. */
export function VoiceTimer() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(id);
  }, []);
  const label = formatVoiceDuration(seconds * 1000);
  return (
    <span className="ws-composer-timer" aria-hidden="true">
      <span className="ws-composer-timer-dot" />
      {label}
    </span>
  );
}

/** Low frequencies in the middle, mirrored outward: speech reads as a symmetric pulse. */
const WAVE_BANDS = [...Array.from({ length: SPECTRUM_BAND_COUNT }, (_, i) => SPECTRUM_BAND_COUNT - 1 - i), ...Array.from({ length: SPECTRUM_BAND_COUNT }, (_, i) => i)];

/**
 * The live waveform: one dithered bar per spectrum band, mirrored. Heights come from the
 * `--voice-band-<n>` variables the voice hook writes on the composer, so a frame never re-renders
 * this. Settled (transcribing), the bars hold their last shape at half strength.
 */
export function VoiceWave({ settled = false, pulse = false }: { settled?: boolean; pulse?: boolean }) {
  return (
    <span
      className="ws-voice-wave"
      data-settled={settled ? "true" : undefined}
      data-pulse={pulse ? "true" : undefined}
      aria-hidden="true"
    >
      {WAVE_BANDS.map((band, index) => (
        <i key={index} style={{ height: `calc(2px + var(--voice-band-${band}, 0) * 16px)` }} />
      ))}
    </span>
  );
}

/** m:ss since a Live Voice session connected. Before it connects there is nothing to time. */
function LiveVoiceTimer({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [startedAt]);
  if (startedAt === null) return null;
  return <span className="ws-live-strip-timer">{formatVoiceDuration(now - startedAt)}</span>;
}

/**
 * The strip attached above the composer while Live Voice runs: the last turns — what you said, what
 * Lotus said, one line per tool it called — then the provider and the session timer. It never
 * scrolls; the turns are already cut to the last three.
 */
export function LiveVoiceStrip({
  turns,
  provider,
  startedAt,
}: {
  turns: LiveVoiceStripTurn[];
  provider: string | null;
  startedAt: number | null;
}) {
  return (
    <div className="ws-live-strip" role="log" aria-label="Live Voice conversation">
      {turns.map((turn) => (
        <div key={turn.turn} className="ws-live-strip-turn">
          {turn.lines.map((line) =>
            line.kind === "tool" ? (
              <p key={line.key} className="ws-live-strip-line" data-kind="tool" data-ok={line.ok ? undefined : "false"}>
                <Wrench size={11} strokeWidth={2} aria-hidden />
                {line.text}
              </p>
            ) : (
              <p key={line.key} className="ws-live-strip-line" data-kind={line.kind}>
                <span className="ws-live-strip-who">{line.kind === "you" ? "You" : "Lotus"}</span>
                {line.text}
              </p>
            ),
          )}
        </div>
      ))}
      <p className="ws-live-strip-meta">
        <span>{provider ? `Live Voice · ${provider}` : "Live Voice"}</span>
        <LiveVoiceTimer startedAt={startedAt} />
      </p>
    </div>
  );
}

/**
 * Live Voice's end of the composer row: the wave while someone is talking, then End. In the error
 * state End reads Close and Retry sits beside it: the error is never a dead end, and a single retrying
 * button once trapped users on a provider that kept failing.
 */
export function LiveVoiceControls({
  phase,
  agentSpeaking,
  onEnd,
  onRetry,
  micMuted = false,
  onToggleMic,
}: {
  phase: S2sPhase;
  agentSpeaking: boolean;
  onEnd: () => void;
  /** Open a fresh session after an error. Only offered in the error state. */
  onRetry?: () => void;
  /** Mute the user's own mic; the agent keeps speaking. Hidden when absent or in the error state. */
  micMuted?: boolean;
  onToggleMic?: () => void;
}) {
  const isError = phase === "error";
  // The wave is a pulse, not a level meter: duplex mode has no spectrum tap to draw from.
  const talking = (!micMuted && (phase === "listening" || phase === "user")) || (phase === "agent" && agentSpeaking);
  return (
    <>
      {talking ? <VoiceWave pulse /> : null}
      {!isError && onToggleMic ? (
        // Worded, not a bare mic glyph: the same glyph starts dictation everywhere else.
        <button
          type="button"
          className="ws-mute-button"
          aria-pressed={micMuted}
          aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
          title={micMuted ? "Unmute microphone" : "Mute microphone"}
          onClick={onToggleMic}
        >
          {micMuted ? <MicOff size={14} strokeWidth={2} aria-hidden /> : <Mic size={14} strokeWidth={2} aria-hidden />}
          {micMuted ? "Muted" : "Mute"}
        </button>
      ) : null}
      {isError && onRetry ? (
        <button type="button" className="ws-round-button" data-variant="live" aria-label="Retry Live Voice" title="Retry" onClick={onRetry}>
          <RotateCcw size={15} strokeWidth={2} />
        </button>
      ) : null}
      <button
        type="button"
        className="ws-round-button"
        data-variant="end"
        aria-label={isError ? "Close Live Voice" : "End Live Voice"}
        title={isError ? "Close Live Voice" : "End Live Voice"}
        onClick={onEnd}
      >
        <Square size={12} strokeWidth={2.5} fill="currentColor" />
      </button>
    </>
  );
}

/** What is left of a session after End: one line, dismissable. */
export function LiveVoiceSummary({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <p className="ws-composer-note ws-live-summary" role="status">
      {text}
      <button type="button" className="ws-live-summary-dismiss" aria-label="Dismiss Live Voice summary" onClick={onDismiss}>
        <X size={12} strokeWidth={2} />
      </button>
    </p>
  );
}
