// Pure helper for the Voice settings panel (plans/voice-settings-revamp).
//
// Resolves the ACTIVE provider from a voice registry (STT / TTS / S2S all share this shape) and
// reports whether it is ready to use — powering the per-capability "engine pill" ("Whisper · Key
// set") and the Loop hero status chips. Kept UI-free and capability-agnostic so it can be unit
// tested and reused across all three tabs.

/** Minimal provider shape shared by SttProviderConfig / TtsProviderConfig / S2sProviderConfig. */
interface ProviderLike {
  id: string;
  name: string;
  /** "browser" | "openai" | "deepgram" | "elevenlabs" | "grok" | "openai-realtime" | "custom" */
  kind: string;
  enabled: boolean;
  /** Redacted to "***" when read over IPC; a stored key still counts as present. */
  apiKey?: string;
}

/** Minimal registry shape shared by the three voice registries. */
interface RegistryLike {
  activeProvider: string;
  providers: ProviderLike[];
}

export interface EngineSummary {
  id: string;
  name: string;
  kind: string;
  /** Cloud engines need a BYOK key; the built-in "browser" engine does not. */
  needsKey: boolean;
  /** A key is stored (any non-blank value, including the "***" redaction sentinel). */
  hasKey: boolean;
  /** Enabled AND, if it needs a key, has one — i.e. usable right now. */
  ready: boolean;
}

/** True when a key value is actually present (non-blank). "***" is the IPC redaction sentinel and
 *  means a real key IS stored server-side, so it counts as present. */
function keyPresent(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

/**
 * Summarize the active provider of a voice registry, or `null` when there is no resolvable active
 * provider (registry unloaded, or the active id is not among the configured providers — e.g. a
 * registry that names an active id before that provider is added).
 */
export function summarizeActiveEngine(registry: RegistryLike | null | undefined): EngineSummary | null {
  if (!registry) return null;
  const active = registry.providers.find((p) => p.id === registry.activeProvider);
  if (!active) return null;

  const needsKey = active.kind !== "browser";
  const hasKey = keyPresent(active.apiKey);
  const ready = active.enabled && (needsKey ? hasKey : true);

  return { id: active.id, name: active.name, kind: active.kind, needsKey, hasKey, ready };
}
