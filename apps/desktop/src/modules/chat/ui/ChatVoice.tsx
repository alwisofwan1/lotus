"use client";

import { Check, Loader2, Mic, Sparkle, X } from "lucide-react";
import { useEffect, useRef, type MutableRefObject } from "react";

import { VoiceTimer } from "@/modules/workspace-shell/components/composer-voice-parts";

import type { ChatVoice } from "../view-model/useChatVoice";

// Mockup: mockups/chat-dictation.html. Styles: chat.css "Dictation".

/** The mic's tooltip: what it does, its key, or why it cannot. */
export function micTitle(voice: ChatVoice): string {
  if (!voice.available) return "Dictate (needs a voice provider in Settings › Voice)";
  return voice.hotkey ? `Dictate: hold ${voice.hotkey}, or click` : "Dictate";
}

/**
 * The mic. `primary` = the field is empty and talking is the action (Chat home). `hidden` keeps it
 * in the layout, invisible and out of the tab order, so the buttons beside it never shift.
 */
export function ChatMicButton({ voice, primary, hidden, disabled }: { voice: ChatVoice; primary?: boolean; hidden?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="chat-voice-mic"
      data-primary={primary || undefined}
      data-hidden={hidden || undefined}
      data-unavailable={!voice.available || undefined}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      aria-label="Dictate"
      aria-pressed={false}
      disabled={disabled}
      title={micTitle(voice)}
      onClick={() => voice.toggle()}
    >
      <Mic size={16} strokeWidth={1.8} aria-hidden />
    </button>
  );
}

/** The composer's foot while the mic is open: cancel, the level history, the time, done. */
export function ChatVoiceBar({ voice }: { voice: ChatVoice }) {
  const settling = voice.phase === "transcribing" || voice.phase === "delivering";
  return (
    <div className="chat-voice-bar" data-settling={settling || undefined}>
      <button type="button" className="chat-voice-cancel" aria-label="Cancel dictation" title="Cancel (Esc)" onClick={voice.cancel}>
        <X size={14} strokeWidth={2.2} aria-hidden />
      </button>
      <VoiceLevel level={voice.level} active={voice.phase === "recording"} />
      {settling ? <span className="chat-voice-clock">Writing…</span> : <span className="chat-voice-clock"><VoiceTimer /></span>}
      <button
        type="button"
        className="chat-voice-done"
        aria-label={settling ? "Writing the text" : "Insert dictation"}
        title={voice.hotkey ? `Insert (${voice.hotkey})` : "Insert"}
        disabled={settling}
        onClick={() => voice.toggle()}
      >
        {settling ? <Loader2 size={16} className="chat-voice-spin" aria-hidden /> : <Check size={16} strokeWidth={2.4} aria-hidden />}
      </button>
    </div>
  );
}

/** What was heard so far, as text: the newest word stays dim until it is settled. */
export function ChatVoiceHeard({ voice }: { voice: ChatVoice }) {
  const words = voice.interim.trim();
  if (!voice.capturing) return null;
  const split = words.lastIndexOf(" ");
  const recording = voice.phase === "recording";
  return (
    <p className="chat-voice-heard" data-settling={!recording || undefined} aria-hidden>
      {!words ? (
        <span className="chat-voice-listening">{voice.phase === "starting" ? "Opening the mic…" : recording ? "Listening…" : "Writing…"}</span>
      ) : recording && split > 0 ? (
        <>
          {words.slice(0, split + 1)}
          <span className="chat-voice-unstable">{words.slice(split + 1)}</span>
        </>
      ) : (
        words
      )}
    </p>
  );
}

/** "Polished · Undo" after an AI-cleaned turn, in the foot's status place. */
export function ChatVoicePolished({ voice }: { voice: ChatVoice }) {
  return (
    <span className="chat-voice-polished">
      <Sparkle size={11} fill="currentColor" aria-hidden />
      Polished
      <button type="button" onClick={voice.undo} title="Put back the exact words">
        Undo
      </button>
    </span>
  );
}

/** One quiet line under the card: how to finish while listening, or what went wrong. */
export function ChatVoiceUnder({ voice }: { voice: ChatVoice }) {
  const send = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘↵" : "Ctrl+↵";
  if (voice.phase === "recording") {
    return (
      <p className="chat-voice-under">
        <span>{voice.held && voice.hotkey ? <>Release <kbd>{voice.hotkey}</kbd> to insert</> : <><kbd>✓</kbd>{voice.hotkey ? <> or <kbd>{voice.hotkey}</kbd></> : null} to insert</>}</span>
        <span><kbd>{send}</kbd> insert and send</span>
        <span><kbd>Esc</kbd> cancel</span>
      </p>
    );
  }
  if (!voice.notice || voice.capturing) return null;
  return (
    <p className="chat-voice-under" data-problem role="status">
      <span>{voice.notice}</span>
      <button type="button" aria-label="Dismiss" onClick={voice.dismiss}>
        <X size={11} aria-hidden />
      </button>
    </p>
  );
}

const BAR = 2.5;
const GAP = 2.5;
const STEP_MS = 45;

/**
 * The mic level as a rolling history, newest at the right: silence shows as a flat line, so it is
 * clear the mic hears. Drawn straight to a canvas from `level`, never through React state.
 */
function VoiceLevel({ level, active }: { level: MutableRefObject<number>; active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const history: number[] = [];
    let shown = 0;
    let last = 0;
    let frame = 0;
    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const target = activeRef.current ? level.current : 0;
      shown += (target - shown) * 0.35;
      const count = Math.max(1, Math.floor(w / (BAR + GAP)));
      if (now - last >= STEP_MS) {
        last = now;
        // Square-rooted: speech rarely fills the range, and a linear bar barely leaves the floor.
        history.push(Math.sqrt(Math.max(0, shown)));
        if (history.length > count) history.splice(0, history.length - count);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = getComputedStyle(canvas).color;
      ctx.globalAlpha = activeRef.current ? 0.85 : 0.35;
      const offset = count - history.length;
      for (let i = 0; i < count; i++) {
        const v = i < offset ? 0 : history[i - offset];
        const bh = Math.max(2, v * h);
        ctx.fillRect(i * (BAR + GAP), (h - bh) / 2, BAR, bh);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [level]);
  return <canvas ref={ref} className="chat-voice-level" aria-hidden />;
}
