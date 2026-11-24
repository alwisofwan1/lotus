/**
 * What each speech-to-text provider kind can do — the one place a kind name means anything.
 * The provider registry (`~/.lotus/stt-providers.json`) stores the kind of each provider; code reads
 * capabilities from here instead of comparing kind names, so a new provider is one row (story 56).
 */
export interface SttKindCapabilities {
  /** Audio leaves the machine for a cloud API (BYOK). */
  cloud: boolean;
  /** The backend can stream this kind with live partials (`stt.stream*` on the Tauri Voice Port). */
  streaming: boolean;
}

const STT_KINDS: Record<string, SttKindCapabilities> = {
  browser: { cloud: false, streaming: false },
  openai: { cloud: true, streaming: false },
  deepgram: { cloud: true, streaming: true },
  custom: { cloud: true, streaming: false },
};

/** Capabilities of a registry kind; an unknown kind can do nothing (it falls back to Browser). */
export function sttKindCapabilities(kind: string): SttKindCapabilities {
  return STT_KINDS[kind] ?? { cloud: false, streaming: false };
}
