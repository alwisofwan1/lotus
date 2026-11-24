import type { TtsProvider } from "./tts-provider";
import { createBrowserTtsProvider } from "./browser-tts-provider";
import { createCloudTtsProvider, type CloudTtsDeps } from "./cloud-tts-provider";

/** Minimal config the resolver needs — a structural subset of the wire `TtsProviderConfig`. */
export interface ResolvableTtsProvider {
  id: string;
  /** "browser" | "openai" | "elevenlabs" | "custom" */
  kind: string;
  enabled: boolean;
}

export interface ResolveTtsDeps {
  /** Builds the cloud synth deps (routes to Rust `tts_synthesize`) for a given provider id. */
  cloudDepsFor: (providerId: string) => CloudTtsDeps;
}

/**
 * Picks the active TTS provider and instantiates its adapter (factory, mirrors
 * `resolveRunnerCommand` in the Agent Runtime Kernel). Falls back to the browser provider whenever
 * the chosen provider is absent, disabled, or of an unknown kind — so the voice channel always
 * resolves to *something*. The browser provider is the zero-config default.
 */
export function resolveTtsProvider(
  activeId: string | null | undefined,
  providers: ResolvableTtsProvider[],
  deps: ResolveTtsDeps,
): TtsProvider {
  const chosen = providers.find((p) => p.id === activeId && p.enabled);
  if (!chosen || chosen.kind === "browser") return createBrowserTtsProvider(chosen?.id ?? "browser");
  if (chosen.kind === "openai" || chosen.kind === "elevenlabs" || chosen.kind === "custom") {
    return createCloudTtsProvider(chosen.id, chosen.kind, deps.cloudDepsFor(chosen.id));
  }
  return createBrowserTtsProvider();
}
