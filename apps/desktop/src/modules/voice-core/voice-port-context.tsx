"use client";
import { createContext, useContext, type ReactNode } from "react";
import { tauriVoicePort, type TauriVoicePort } from "./tauri-voice-port";

const VoicePortContext = createContext<TauriVoicePort>(tauriVoicePort);

/** Swap the Tauri Voice Port for a subtree. The app needs none: the default is the real port.
 *  Pass a port created once (not built inline per render): the registry hooks reload when it changes. */
export function VoicePortProvider({ port, children }: { port: TauriVoicePort; children: ReactNode }) {
  return <VoicePortContext.Provider value={port}>{children}</VoicePortContext.Provider>;
}

/** The Tauri Voice Port in scope — the real one unless a {@link VoicePortProvider} overrides it. */
export function useTauriVoicePort(): TauriVoicePort {
  return useContext(VoicePortContext);
}
