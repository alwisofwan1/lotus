import type { TtsProvider } from "./tts-provider";

const DEFAULT_WATCHDOG_MS = 60_000;

export interface BrowserTtsProviderOptions {
  watchdogMs?: number;
}

/**
 * Browser TTS adapter — speaks via the Web Speech API (`window.speechSynthesis`). Zero-config, no
 * API key, works offline; this is the default voice provider. Each `speak` cancels any prior
 * utterance so rapid NL confirmations don't queue into a backlog.
 */
export function createBrowserTtsProvider(id = "browser", options: BrowserTtsProviderOptions = {}): TtsProvider {
  const synth = (): SpeechSynthesis | null =>
    typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  let settleActive: (() => void) | null = null;

  return {
    id,
    kind: "browser",
    isAvailable: () => synth() !== null,
    stop: () => {
      settleActive?.();
      synth()?.cancel();
    },
    speak: (text, opts) =>
      new Promise<void>((resolve, reject) => {
        const s = synth();
        if (!s) return reject(new Error("Browser speech synthesis is unavailable."));
        const clean = text.trim();
        if (!clean) return resolve();
        if (opts?.signal?.aborted) return resolve();

        const utterance = new SpeechSynthesisUtterance(clean);
        // Language drives the engine's voice choice. Unset, WebSpeech falls back to the page lang
        // (English here) — Indonesian text read with English phonemes is the "robotic voice" bug.
        if (opts?.language) utterance.lang = opts.language;
        if (opts?.speed) utterance.rate = Math.max(0.5, Math.min(2, opts.speed));
        if (opts?.voice) {
          const match = s.getVoices().find((v) => v.name === opts.voice || v.voiceURI === opts.voice);
          if (match) utterance.voice = match;
        } else if (opts?.language) {
          // No configured voice: pick one matching the text's language (primary-subtag prefix, so
          // "id" matches "id-ID" Damayanti). Local voices first — they start instantly and macOS
          // network voices can stall. No match → leave unset; utterance.lang still steers the engine.
          const primary = opts.language.toLowerCase().split("-")[0];
          const candidates = s.getVoices().filter((v) => v.lang?.toLowerCase().split("-")[0] === primary);
          const match = candidates.find((v) => v.localService) ?? candidates[0];
          if (match) utterance.voice = match;
        }
        let settled = false;
        const lifecycle: { watchdog?: ReturnType<typeof setTimeout> } = {};
        const onAbort = () => {
          settle();
          s.cancel();
        };
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          utterance.onend = null;
          utterance.onerror = null;
          opts?.signal?.removeEventListener("abort", onAbort);
          if (lifecycle.watchdog !== undefined) clearTimeout(lifecycle.watchdog);
          if (settleActive === settle) settleActive = null;
          if (error) reject(error);
          else resolve();
        };

        utterance.onend = () => settle();
        utterance.onerror = (e) => {
          // "canceled" / "interrupted" mean a newer utterance (or stop()) intentionally replaced this
          // one — the `s.cancel()` below fires exactly this on the prior utterance when confirmations
          // arrive back-to-back (e.g. several agents finishing at once). That's expected, not a
          // failure, so resolve quietly instead of surfacing a noisy "Speech failed: canceled".
          if (e.error === "canceled" || e.error === "interrupted") return settle();
          settle(new Error(`Speech failed: ${e.error ?? "unknown"}`));
        };
        opts?.signal?.addEventListener("abort", onAbort, { once: true });

        settleActive?.();
        s.cancel(); // drop any in-flight confirmation before speaking the new one
        settleActive = settle;
        lifecycle.watchdog = setTimeout(
          () => {
            settle(new Error("Browser speech synthesis timed out."));
            s.cancel();
          },
          watchdogMs,
        );
        try {
          s.speak(utterance);
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      }),
  };
}
