"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPushToTalkSession,
  INITIAL_PUSH_TO_TALK_STATE,
  type PushToTalkHandlers,
  type PushToTalkPhase,
  type PushToTalkSession,
} from "./push-to-talk-session";

export interface PushToTalkControls {
  phase: PushToTalkPhase;
  /** The phase right now — fresher than `phase`, which waits for a render. */
  getPhase: () => PushToTalkPhase;
  press: () => void;
  release: () => void;
  cancel: () => void;
  /** Typed submit through the same in-flight guard as voice. False = refused (a turn is in flight). */
  submit: (text: string) => boolean;
  /** Resolves once the session rests: recording, or idle again. */
  settled: () => Promise<void>;
}

/**
 * The thin React owner of a {@link createPushToTalkSession}. Handlers may be fresh closures every
 * render — the session reads the latest through a ref. The session is disposed on unmount (any live
 * turn is aborted and the mic closed) and re-created on the next mount, so StrictMode's double mount
 * is harmless.
 */
export function usePushToTalkSession(handlers: PushToTalkHandlers): PushToTalkControls {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const sessionRef = useRef<PushToTalkSession | null>(null);
  const [phase, setPhase] = useState<PushToTalkPhase>(INITIAL_PUSH_TO_TALK_STATE.phase);

  const session = useCallback((): PushToTalkSession => {
    if (!sessionRef.current) {
      const created = createPushToTalkSession(() => handlersRef.current);
      created.subscribe(() => setPhase(created.getState().phase));
      sessionRef.current = created;
    }
    return sessionRef.current;
  }, []);

  useEffect(() => {
    session();
    return () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, [session]);

  const press = useCallback(() => session().press(), [session]);
  const release = useCallback(() => session().release(), [session]);
  const cancel = useCallback(() => session().cancel(), [session]);
  const submit = useCallback((text: string) => session().submit(text), [session]);
  const settled = useCallback(() => {
    const s = session();
    const resting = () => s.getState().phase === "idle" || s.getState().phase === "recording";
    if (resting()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const unsubscribe = s.subscribe(() => {
        if (!resting()) return;
        unsubscribe();
        resolve();
      });
    });
  }, [session]);

  const getPhase = useCallback(() => session().getState().phase, [session]);

  return useMemo(
    () => ({ phase, getPhase, press, release, cancel, submit, settled }),
    [phase, getPhase, press, release, cancel, submit, settled],
  );
}
