"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createModifierOnlyHotkeyTracker,
  isHotkeyRecordingActive,
  modifierOnlyChordForEvent,
  normalizeChord,
} from "@/lib/hotkeys/chord";
import {
  getVoiceHotkeyBindings,
  planVoiceHotkeyPress,
  PUSH_TO_TALK_HOLD_MS,
  resolveVoiceHotkey,
  type VoiceHotkeyHandlers,
} from "./voice-hotkeys";

const HINT_MS = 3_000;


type HandlersRef = { readonly current: VoiceHotkeyHandlers };

interface VoiceHotkeyClaims {
  claim: (handlers: HandlersRef) => () => void;
}

const VoiceHotkeyContext = createContext<VoiceHotkeyClaims | null>(null);

/**
 * Listen for the app voice hotkeys on `window`. They are global like ⌘⇧V / ⌘⇧D: they fire even with
 * an editor or a terminal focused, because the user bound them on purpose. A press with no handler
 * is not taken: it still reaches the page (Monaco keeps ⌘⇧L "select all occurrences" in Code mode),
 * and `onHint` says why voice did not start.
 */
function listenForVoiceHotkeys(getHandlers: () => VoiceHotkeyHandlers | null, onHint?: (text: string) => void): () => void {
  const tracker = createModifierOnlyHotkeyTracker();
  /*
    Hold-to-talk. The Push-to-Talk key that went down, and when: letting go of THAT key after
    PUSH_TO_TALK_HOLD_MS stops the turn, so holding the key reads as "talk while held" while a quick
    tap still toggles. Matched by `code`, because the modifier may be let go first and the key's
    `key` changes with it (⌥Space reports U+00A0 until ⌥ is up). A modifier-only binding fires on
    keyup already, so it has nothing to hold.
  */
  let held: { code: string; at: number } | null = null;
  const press = (chord: string, event: KeyboardEvent) => {
    const id = resolveVoiceHotkey(chord, getVoiceHotkeyBindings());
    if (!id) return;
    const plan = planVoiceHotkeyPress(id, getHandlers());
    if (plan.kind === "hint") {
      onHint?.(plan.text);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // A modifier-only binding fires on keyup: there is no key left to hold.
    const holding = id === "push-to-talk" && event.type === "keydown";
    if (holding) held = { code: event.code, at: event.timeStamp };
    plan.run({ holding });
  };
  const releaseHeld = (event: KeyboardEvent) => {
    if (!held || event.code !== held.code) return;
    const heldFor = event.timeStamp - held.at;
    held = null;
    if (heldFor < PUSH_TO_TALK_HOLD_MS) {
      getHandlers()?.pushToTalkTap?.();
      return;
    }
    const release = getHandlers()?.pushToTalkRelease;
    if (!release) return;
    event.preventDefault();
    event.stopPropagation();
    release();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (isHotkeyRecordingActive()) {
      tracker.reset();
      return;
    }
    tracker.keyDown(event);
    // A held key repeats keydown; one press is one toggle.
    if (event.repeat || modifierOnlyChordForEvent(event)) return;
    press(normalizeChord(event), event);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (isHotkeyRecordingActive()) {
      tracker.reset();
      return;
    }
    releaseHeld(event);
    const chord = tracker.keyUp(event);
    if (chord) press(chord, event);
  };
  const onBlur = () => {
    tracker.reset();
    // The key's release will never arrive here: the turn goes on as a tapped one.
    if (held) getHandlers()?.pushToTalkTap?.();
    held = null;
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  window.addEventListener("keyup", onKeyUp, { capture: true });
  window.addEventListener("blur", onBlur);
  return () => {
    tracker.reset();
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    window.removeEventListener("keyup", onKeyUp, { capture: true });
    window.removeEventListener("blur", onBlur);
  };
}

/**
 * The one app-wide listener for the voice hotkeys. The mode on screen claims them with
 * {@link useVoiceHotkeyHandlers}; the latest claim wins. A press the mode cannot handle shows a short
 * hint, so the key is never silently dead.
 */
export function VoiceHotkeyProvider({ children }: { children: ReactNode }) {
  const claimsRef = useRef<HandlersRef[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = useCallback((text: string) => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    setHint(text);
    hintTimerRef.current = setTimeout(() => setHint(null), HINT_MS);
  }, []);

  useEffect(() => {
    const stop = listenForVoiceHotkeys(() => claimsRef.current.at(-1)?.current ?? null, showHint);
    return () => {
      stop();
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    };
  }, [showHint]);

  const claims = useMemo<VoiceHotkeyClaims>(
    () => ({
      claim: (handlers) => {
        claimsRef.current = [...claimsRef.current, handlers];
        return () => {
          claimsRef.current = claimsRef.current.filter((entry) => entry !== handlers);
        };
      },
    }),
    [],
  );

  return (
    <VoiceHotkeyContext.Provider value={claims}>
      {children}
      {hint ? (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-[1000] -translate-x-1/2 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--fg)] shadow-lg"
        >
          {hint}
        </div>
      ) : null}
    </VoiceHotkeyContext.Provider>
  );
}

/**
 * Claim the voice hotkeys for a mode while it is on screen. Pass only the actions the mode has: a
 * missing `liveVoice` makes the Live Voice key show a hint. Without a {@link VoiceHotkeyProvider}
 * (a mode rendered alone, as in tests) the hook listens by itself and shows no hint.
 */
export function useVoiceHotkeyHandlers(handlers: VoiceHotkeyHandlers): void {
  const claims = useContext(VoiceHotkeyContext);
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });
  useEffect(() => {
    if (claims) return claims.claim(handlersRef);
    return listenForVoiceHotkeys(() => handlersRef.current);
  }, [claims]);
}
