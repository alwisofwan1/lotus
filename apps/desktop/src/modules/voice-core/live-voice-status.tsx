"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * **Live Voice status** (ADR-0053, plans/voice-core story 53) — whether a Live Voice session is open,
 * shared through React context instead of a module-global flag.
 *
 * The owner of the session (a mode's Live Voice control) reports it with {@link useReportLiveVoiceActive};
 * a surface that must go quiet meanwhile (narration, the Speaker Queue hold) reads it. The provider
 * sits above both: its owner keeps the state with {@link useLiveVoiceStatusState}.
 */
export interface LiveVoiceStatus {
  active: boolean;
  report: (active: boolean) => void;
}

const QUIET: LiveVoiceStatus = { active: false, report: () => {} };

const LiveVoiceStatusContext = createContext<LiveVoiceStatus>(QUIET);

/** The state behind a {@link LiveVoiceStatusProvider}. `active` is for the owner itself, which sits
 *  above its own provider and so cannot read the context. */
export function useLiveVoiceStatusState(): { active: boolean; value: LiveVoiceStatus } {
  const [active, setActive] = useState(false);
  const value = useMemo(() => ({ active, report: setActive }), [active]);
  return { active, value };
}

export function LiveVoiceStatusProvider({ value, children }: { value: LiveVoiceStatus; children: ReactNode }) {
  return <LiveVoiceStatusContext.Provider value={value}>{children}</LiveVoiceStatusContext.Provider>;
}

/** True while a Live Voice session is open. False with no provider. */
export function useLiveVoiceActive(): boolean {
  return useContext(LiveVoiceStatusContext).active;
}

/** Report the session's state from its owner. Unmounting reports quiet. */
export function useReportLiveVoiceActive(active: boolean): void {
  const { report } = useContext(LiveVoiceStatusContext);
  useEffect(() => {
    report(active);
    return () => report(false);
  }, [active, report]);
}
