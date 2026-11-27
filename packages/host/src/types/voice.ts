/** ADR-11: The host transcribes audio so Pocket never holds an API key. */

export interface TranscribeRequest {
  /** Base64 audio. Bounded by the route, not by this type. */
  audioBase64: string;
  mime: string;
  /** Optional bias text — repo vocabulary, so `SSHTransport.swift` survives. */
  prompt?: string;
}

export interface TranscribeResult {
  text: string;
  /** Provider id that produced the text — never its key. */
  provider: string;
}

/** What the façade answers a phone: `text: null` means "not here, use the device". */
export interface MobileTranscribeResponse {
  text: string | null;
  provider?: string;
  /** False when this host has no server-side provider active. Absent when it does. */
  hostSupports?: boolean;
}
