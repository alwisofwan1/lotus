"use client";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import { nlComplete, setOtherAudioMuted } from "@/lib/tauri-api";
import { getVoiceAccuracySettings } from "@/modules/codecanvas/hooks/useVoiceAccuracySettings";
import { getVoiceInputSettings } from "@/modules/codecanvas/hooks/useVoiceInputSettings";
import { useLotusSettings } from "@/modules/lotus-settings/lotus-settings-context";
import type { PushToTalkHandlers, PushToTalkPhase } from "@/modules/voice-core/push-to-talk-session";
import { computeLevel } from "@/modules/voice-core/spectrum-visual";
import { usePushToTalkSession } from "@/modules/voice-core/use-push-to-talk-session";
import { useSpeechToText } from "@/modules/voice-core/use-speech-to-text";
import { CANCELLED_DELIVERY_REASON, EMPTY_DELIVERY_REASON } from "@/modules/voice-core/voice-adapter";
import { useVoiceHotkeyHandlers } from "@/modules/voice-core/voice-hotkey-context";
import type { VoiceHotkeyPressInfo } from "@/modules/voice-core/voice-hotkeys";
import { useVoiceKeyLabel } from "@/modules/workspace-shell/components/composer-voice-parts";
import {
  CODE_VOICE_CLEANUP_FAILED,
  CODE_VOICE_IGNORED,
  CODE_VOICE_NO_PROVIDER,
} from "@/modules/workspace-shell/hooks/useCodeVoice";
import {
  buildCodeVoiceDecoderContext,
  cleanUpCodeVoiceTranscript,
  finalizeCodeVoiceTranscript,
} from "@/modules/workspace-shell/services/code-voice-transcript";

import { CHAT_VOICE_REVIEW_REASON, createChatVoiceAdapter, joinDictation } from "../domain/voice";
import { textBeforeCaret } from "../ui/chat-editor";

/** A cleaned-up turn that can still go back to the exact words: where it sits and what was said. */
interface Polished {
  from: number;
  text: string;
  spoken: string;
}

export interface ChatVoice {
  phase: PushToTalkPhase;
  /** Mic open or the words still being turned into text: the composer shows the voice bar. */
  capturing: boolean;
  /** Live words while recording (final + interim). */
  interim: string;
  /** What voice has to tell the user, or null. */
  notice: string | null;
  /** False = no provider is set; the mic shows, dimmed, and a press says why. */
  available: boolean;
  /** This turn started with the key held down: letting go finishes it. */
  held: boolean;
  /** The Push-to-Talk key as printed ("⌥Space"), or null when unbound. */
  hotkey: string | null;
  /** The last turn went in cleaned up by AI; `undo` puts the spoken words back. */
  polished: boolean;
  /** Live mic level 0–1, written per frame. Read it in an animation loop, never in render. */
  level: MutableRefObject<number>;
  /** Mic button / ✓: start, or finish. `sendNow` = ⌘Enter, finish and send. */
  toggle: (options?: { sendNow?: boolean }) => void;
  cancel: () => void;
  undo: () => void;
  dismiss: () => void;
}

interface UseChatVoiceOptions {
  editor: Editor | null;
  /** The thread this composer writes to, by id and the name a reason would use. */
  thread: { id: string; name: string };
  /** Chat is the mode on screen: it claims the voice hotkeys and Escape / ⌘Enter while capturing. */
  live: boolean;
  /** Send what the editor holds now. False = it could not (a request is open, a send in flight). */
  send: () => boolean;
}

/**
 * Push-to-Talk in a Chat composer: the Voice Core's speech-to-text and turn session, joined to the
 * Chat Voice Adapter. The text goes in at the caret as one transaction (one ⌘Z), unsent.
 */
export function useChatVoice({ editor, thread, live, send }: UseChatVoiceOptions): ChatVoice {
  const [notice, setNotice] = useState<string | null>(null);
  const [held, setHeld] = useState(false);
  const [polished, setPolished] = useState<Polished | null>(null);
  const { openSettings } = useLotusSettings();
  const level = useRef(0);
  const onSpectrum = useCallback((bands: number[]) => {
    level.current = computeLevel(bands);
  }, []);
  const stt = useSpeechToText({ onError: setNotice, onSpectrum });
  const hotkey = useVoiceKeyLabel("push-to-talk");

  // Fresh every render; a turn reads the latest when it delivers.
  const latest = useRef({ editor, thread, send });
  useEffect(() => {
    latest.current = { editor, thread, send };
  });
  const sendNowRef = useRef(false);
  /** The words before AI cleanup, for the turn being delivered. */
  const spokenRef = useRef<{ text: string; spoken: string } | null>(null);
  /** Set while this hook writes to the editor, so its own edit does not drop the Undo. */
  const writing = useRef(false);

  const insert = (text: string, spoken: string | null) => {
    const e = latest.current.editor;
    if (!e || e.isDestroyed) return;
    const before = textBeforeCaret(e);
    const piece = joinDictation(before, text);
    const from = e.state.selection.from;
    writing.current = true;
    // A text node, not a string: a string is parsed as HTML and loses a leading space.
    e.chain().focus().insertContent({ type: "text", text: piece }).run();
    writing.current = false;
    setPolished(spoken && spoken !== text ? { from, text: piece, spoken: joinDictation(before, spoken) } : null);
  };

  const handlers: PushToTalkHandlers = {
    async startMic() {
      setNotice(null);
      setPolished(null);
      sendNowRef.current = false;
      if (!stt.available) {
        setNotice(CODE_VOICE_NO_PROVIDER);
        openSettings({ from: "dictate" });
        return false;
      }
      return stt.start(buildCodeVoiceDecoderContext(getVoiceAccuracySettings(), []));
    },
    async finishMic(turn) {
      spokenRef.current = null;
      const raw = await stt.stop();
      const accuracy = getVoiceAccuracySettings();
      const input = getVoiceInputSettings();
      if (!input.autoCleanup || !raw.trim()) return finalizeCodeVoiceTranscript(raw, accuracy);
      let failed = false;
      const result = await cleanUpCodeVoiceTranscript(raw, {
        accuracy,
        paneNames: [],
        mode: input.dictationMode,
        signal: turn.signal,
        callModel: (prompt, signal) =>
          nlComplete(prompt, undefined, signal).catch((error: unknown) => {
            if (!signal?.aborted) failed = true;
            throw error;
          }),
      });
      if (!turn.isCurrent()) return result.text;
      if (failed) setNotice(CODE_VOICE_CLEANUP_FAILED);
      if (result.text !== result.spoken) spokenRef.current = result;
      return result.text;
    },
    cancelMic: () => stt.cancel(),
    async deliver(text, turn, source) {
      const cleaned = spokenRef.current?.text === text.trim() ? spokenRef.current.spoken : null;
      spokenRef.current = null;
      const adapter = createChatVoiceAdapter({
        thread: latest.current.thread,
        insert: (t) => insert(t, cleaned),
        send: () => latest.current.send(),
        sendRightAway: () => getVoiceInputSettings().sendRightAway,
      });
      const result = await adapter.deliver(text, { source, signal: turn.signal, sendNow: sendNowRef.current });
      if (!turn.isCurrent()) return;
      if (result.status === "failed" && result.reason !== CANCELLED_DELIVERY_REASON) throw new Error(result.reason);
      if (result.status === "held" && result.reason !== CHAT_VOICE_REVIEW_REASON && result.reason !== EMPTY_DELIVERY_REASON) {
        setNotice(result.reason);
      }
    },
    report(kind, message) {
      // The user cancelled on purpose (✕ or Esc): telling them so is noise.
      if (kind === "cancelled") return;
      setNotice(kind === "ignored" ? CODE_VOICE_IGNORED : (message ?? "Voice input failed."));
    },
  };
  const ptt = usePushToTalkSession(handlers);

  const toggle = useCallback(
    (options?: { sendNow?: boolean }) => {
      if (options?.sendNow) sendNowRef.current = true;
      setHeld(false);
      ptt.press();
    },
    [ptt],
  );
  const cancel = useCallback(() => ptt.cancel(), [ptt]);
  const keyPress = useCallback(
    (press?: VoiceHotkeyPressInfo) => {
      const phase = ptt.getPhase();
      if (phase !== "starting" && phase !== "recording") setHeld(Boolean(press?.holding));
      ptt.press();
    },
    [ptt],
  );
  const release = useCallback(() => {
    setHeld(false);
    ptt.release();
  }, [ptt]);
  const tapped = useCallback(() => setHeld(false), []);
  useVoiceHotkeyHandlers(live ? { pushToTalk: keyPress, pushToTalkRelease: release, pushToTalkTap: tapped } : {});

  // Typing moves on from whatever voice last said.
  useEffect(() => {
    if (!editor || !notice) return;
    const drop = () => setNotice(null);
    editor.on("update", drop);
    return () => {
      editor.off("update", drop);
    };
  }, [editor, notice]);

  // Any edit after the insert makes the Undo ambiguous: it goes.
  useEffect(() => {
    if (!editor || !polished) return;
    const drop = () => {
      if (!writing.current) setPolished(null);
    };
    editor.on("update", drop);
    return () => {
      editor.off("update", drop);
    };
  }, [editor, polished]);

  const undo = useCallback(() => {
    const e = latest.current.editor;
    if (!polished || !e || e.isDestroyed) return;
    const to = polished.from + polished.text.length;
    if (e.state.doc.textBetween(polished.from, to, "\n", " ") === polished.text) {
      writing.current = true;
      e.chain().focus().insertContentAt({ from: polished.from, to }, { type: "text", text: polished.spoken }).run();
      writing.current = false;
    }
    setPolished(null);
  }, [polished]);

  const capturing = ptt.phase === "starting" || ptt.phase === "recording" || ptt.phase === "transcribing";
  const recording = ptt.phase === "recording";
  // Escape drops a live turn and ⌘Enter finishes and sends it: only while capturing, so the
  // composer's pickers keep their own Escape the rest of the time.
  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && recording) {
        event.preventDefault();
        event.stopPropagation();
        toggle({ sendNow: true });
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel, capturing, recording, toggle]);

  // Music or a video playing over the user would be heard by the mic: silence it while it is open.
  useEffect(() => {
    if (!stt.recording) return;
    void setOtherAudioMuted(true);
    return () => void setOtherAudioMuted(false);
  }, [stt.recording]);

  // A stale last frame must not leave the bars standing once capture ends.
  useEffect(() => {
    if (!stt.recording) level.current = 0;
  }, [stt.recording]);

  return {
    phase: ptt.phase,
    capturing: capturing || ptt.phase === "delivering",
    interim: stt.interim,
    notice,
    // Not "unavailable" while the provider list is still loading: that would flash on every mount.
    available: stt.available || Boolean(stt.checking),
    held,
    hotkey,
    polished: polished !== null,
    level,
    toggle,
    cancel,
    undo,
    dismiss: useCallback(() => setNotice(null), []),
  };
}
