import type { TtsProvider, TtsProviderKind, TtsSpeakOptions } from "./tts-provider";

/** Audio returned by the Rust `tts_synthesize` seam: base64 bytes + a MIME type to play. */
export interface TtsSynthesisResult {
  audioBase64: string;
  mime: string;
}

export interface CloudTtsDeps {
  /**
   * Routes to the Rust `tts_synthesize` command (OpenAI / ElevenLabs, fully implemented in
   * `tts_providers.rs`). The API key stays in Rust (read from `~/.lotus/tts-providers.json`)
   * and is never passed here.
   */
  synthesize: (text: string, opts?: TtsSpeakOptions) => Promise<TtsSynthesisResult>;
  /** Plays synthesized audio. Injectable for tests; defaults to an HTMLAudioElement. */
  play?: (result: TtsSynthesisResult, signal?: AbortSignal) => Promise<void>;
  /** Maximum playback lifecycle wait. Injectable for deterministic watchdog tests. */
  playbackWatchdogMs?: number;
}

const DEFAULT_PLAYBACK_WATCHDOG_MS = 120_000;

/**
 * Decodes base64 audio bytes into a Blob. Playing from a Blob object URL lets the media element load
 * and decode the clip lazily/off the main thread — a multi-hundred-KB `data:` URI, by contrast, is
 * parsed and decoded synchronously on the main thread when `play()` is called, which janks the frame
 * (visibly freezing concurrent animations like the dispatch comet's landing).
 */
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function canUseObjectUrl(): boolean {
  return (
    typeof Blob !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

/**
 * Turn synthesized audio into a playable src. Prefers decoding the base64 OFF the main thread via
 * `fetch(data:…)` (the platform parses it, no synchronous `atob` + per-byte loop janking the frame
 * during the "waiting for voice feedback" moment). Falls back to the synchronous {@link base64ToBlob}
 * if `fetch(data:)` is unavailable/blocked, then to a raw data URI where Blob/URL don't exist (jsdom).
 */
async function resolveAudioSrc(
  result: TtsSynthesisResult,
  signal?: AbortSignal,
): Promise<{ src: string; objectUrl: string | null }> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const dataUri = `data:${result.mime};base64,${result.audioBase64}`;
  if (canUseObjectUrl()) {
    if (typeof fetch === "function") {
      try {
        const blob = await fetch(dataUri, signal ? { signal } : undefined).then((r) => r.blob());
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const url = URL.createObjectURL(blob);
        return { src: url, objectUrl: url };
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
        /* fetch(data:) blocked → fall back to the synchronous decode below */
      }
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const url = URL.createObjectURL(base64ToBlob(result.audioBase64, result.mime));
      return { src: url, objectUrl: url };
    } catch {
      /* fall through to data URI */
    }
  }
  return { src: dataUri, objectUrl: null };
}

export async function playCloudTtsAudio(
  result: TtsSynthesisResult,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof Audio === "undefined") throw new Error("Audio playback is unavailable.");
  if (signal?.aborted) return;
  let src: string;
  let objectUrl: string | null;
  try {
    ({ src, objectUrl } = await resolveAudioSrc(result, signal));
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
    throw error;
  }
  if (signal?.aborted) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return;
  }
  return new Promise<void>((resolve, reject) => {
    let revoked = false;
    let settled = false;
    const audio = new Audio(src);
    const dispose = () => {
      if (settled) return;
      settled = true;
      audio.onended = null;
      audio.onerror = null;
      signal?.removeEventListener("abort", onAbort);
      if (objectUrl && !revoked) {
        URL.revokeObjectURL(objectUrl);
        revoked = true;
      }
      // Unload, or the element keeps its media player and WebKit media session until GC.
      try {
        audio.removeAttribute("src");
        audio.load();
      } catch {
        /* ignore */
      }
    };
    const onAbort = () => {
      try {
        audio.pause();
      } catch {
        /* ignore */
      }
      dispose();
      resolve();
    };
    audio.onended = () => {
      dispose();
      resolve();
    };
    audio.onerror = () => {
      dispose();
      reject(new Error("Audio playback failed."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void audio.play().catch((error) => {
      dispose();
      reject(error);
    });
  });
}

/**
 * BYOK cloud TTS adapter (OpenAI / ElevenLabs / custom). The network call lives in Rust
 * (`tts_synthesize`, fully implemented in `src-tauri/src/tts_providers.rs` — including tone
 * `instructions` for steerable OpenAI models and `voice_settings` for ElevenLabs) so the API key
 * never enters the renderer; this adapter only requests the audio bytes and plays them.
 */
export function createCloudTtsProvider(
  id: string,
  kind: Exclude<TtsProviderKind, "browser">,
  deps: CloudTtsDeps,
): TtsProvider {
  const play = deps.play ?? playCloudTtsAudio;
  const playbackWatchdogMs = deps.playbackWatchdogMs ?? DEFAULT_PLAYBACK_WATCHDOG_MS;
  interface SpeechRequest {
    text: string;
    opts?: TtsSpeakOptions;
    controller: AbortController;
    cancelled: boolean;
    settle: (error?: unknown) => void;
  }

  let active: SpeechRequest | null = null;
  let pending: SpeechRequest | null = null;

  const cancel = (request: SpeechRequest | null) => {
    if (!request || request.cancelled) return;
    request.cancelled = true;
    request.controller.abort();
    request.settle();
    if (pending === request) pending = null;
  };

  const pump = () => {
    if (active || !pending) return;
    const request = pending;
    pending = null;
    active = request;

    void (async () => {
      try {
        const result = await deps.synthesize(request.text, {
          ...request.opts,
          signal: request.controller.signal,
        });
        if (!request.cancelled) {
          const aborted = new Promise<void>((resolve) => {
            if (request.controller.signal.aborted) {
              resolve();
              return;
            }
            request.controller.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          let watchdog: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<never>((_resolve, reject) => {
            watchdog = setTimeout(
              () => reject(new Error("Cloud speech playback timed out.")),
              playbackWatchdogMs,
            );
          });
          try {
            await Promise.race([play(result, request.controller.signal), aborted, timedOut]);
          } finally {
            if (watchdog !== undefined) clearTimeout(watchdog);
          }
        }
        if (!request.cancelled) request.settle();
      } catch (error) {
        if (!request.cancelled) request.controller.abort();
        request.settle(request.cancelled ? undefined : error);
      } finally {
        if (active === request) active = null;
        pump();
      }
    })();
  };

  return {
    id,
    kind,
    isAvailable: () => true, // real availability (key present) is enforced by the Rust synth call
    stop: () => {
      cancel(active);
      cancel(pending);
      pending = null;
    },
    speak: (text, opts) => {
      const clean = text.trim();
      if (!clean || opts?.signal?.aborted) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        const controller = new AbortController();
        let settled = false;
        let request: SpeechRequest | null = null;
        const onExternalAbort = () => cancel(request);
        request = {
          text: clean,
          opts,
          controller,
          cancelled: false,
          settle: (error) => {
            if (settled) return;
            settled = true;
            opts?.signal?.removeEventListener("abort", onExternalAbort);
            if (error) reject(error);
            else resolve();
          },
        };
        opts?.signal?.addEventListener("abort", onExternalAbort, { once: true });

        // Native cloud synthesis cannot yet be interrupted once its blocking provider request starts.
        // Keep exactly one such request active and retain only the newest replacement behind it, so a
        // burst cannot occupy an unbounded number of Tauri blocking workers with audio nobody will hear.
        cancel(active);
        cancel(pending);
        pending = request;
        pump();
      });
    },
  };
}
