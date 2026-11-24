import type { SttProvider } from "./stt-provider";

// Minimal shapes for the Web Speech API (not in the default TS DOM lib).
interface SpeechRecognitionAlt {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: SpeechRecognitionAlt;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionErrorLike {
  readonly error?: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
}

/** Map a Web Speech error code to a user-facing message (empty = benign / no message). */
function describeError(code?: string): string {
  switch (code) {
    case "no-speech":
      return ""; // benign — handled as "nothing heard"
    case "audio-capture":
      return "No microphone was found.";
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone blocked or the speech service is unavailable here — add a cloud provider in Settings → Voice.";
    case "network":
      return "Speech service unreachable — add a cloud provider in Settings → Voice.";
    default:
      return "Voice input isn't working in this window — add a cloud provider in Settings → Voice.";
  }
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Options for the browser STT adapter. */
export interface BrowserSttOptions {
  /** BCP-47 language hint (e.g. "en-US", "id-ID"). Defaults to "en-US". */
  lang?: string;
  /**
   * Called with the live (final + interim) transcript as speech is recognized, so the UI can show
   * partial text while the user is still talking. When omitted, interim results are disabled.
   */
  onInterim?: (text: string) => void;
  /**
   * Called when recognition fails (permission denied, or — common in the Tauri webview — the speech
   * service is unavailable). Lets the UI surface a clear message and leave the recording state.
   */
  onError?: (message: string) => void;
}

/**
 * Browser STT adapter — Web Speech `SpeechRecognition`. Zero key, but frequently unavailable inside
 * the Tauri webview (WKWebView / WebKitGTK), so treat it as best-effort; the cloud BYOK providers are
 * the reliable path. `start()` begins recognition; `stop()` resolves with the final transcript.
 */
export function createBrowserSttProvider(id = "browser", opts: BrowserSttOptions = {}): SttProvider {
  let recognition: SpeechRecognitionLike | null = null;
  let transcript = "";
  /** Browser recognition may auto-end after silence before the user clicks Stop. Preserve that turn's
   *  final text until stop() consumes it instead of returning an empty transcript. */
  let endedTranscript: string | null = null;
  let resolveStop: ((t: string) => void) | null = null;
  let stopWatchdog: number | null = null;
  let generation = 0;

  const teardown = () => {
    if (stopWatchdog !== null) {
      window.clearTimeout(stopWatchdog);
      stopWatchdog = null;
    }
    recognition = null;
  };

  // Resolve a pending stop() (if any) with whatever was captured, and release the engine. Idempotent.
  const settle = () => {
    const resolve = resolveStop;
    resolveStop = null;
    teardown();
    resolve?.(transcript.trim());
  };

  return {
    id,
    kind: "browser",
    isAvailable: () => getCtor() !== null,
    start: () =>
      new Promise<void>((resolve, reject) => {
        const Ctor = getCtor();
        if (!Ctor) return reject(new Error("Browser speech recognition is unavailable."));
        const ownerGeneration = ++generation;
        transcript = "";
        endedTranscript = null;
        const rec = new Ctor();
        recognition = rec;
        rec.lang = opts.lang || "en-US";
        rec.continuous = true;
        rec.interimResults = !!opts.onInterim;
        rec.onresult = (e) => {
          if (generation !== ownerGeneration) return;
          let interim = "";
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const result = e.results[i];
            if (result.isFinal) transcript += result[0].transcript;
            else interim += result[0].transcript;
          }
          opts.onInterim?.((transcript + interim).trim());
        };
        rec.onerror = (e) => {
          if (generation !== ownerGeneration) return;
          // Never hang: resolve a pending stop, and tear down an in-flight session. Then report so
          // the UI can leave the recording state with a clear message.
          if (resolveStop) settle();
          else teardown();
          const msg = describeError(e?.error);
          if (msg) opts.onError?.(msg);
        };
        rec.onend = () => {
          if (generation !== ownerGeneration) return;
          if (resolveStop) settle();
          else {
            endedTranscript = transcript.trim();
            teardown();
          }
        };
        try {
          rec.start();
          resolve();
        } catch (err) {
          teardown();
          reject(err instanceof Error ? err : new Error("Could not start speech recognition."));
        }
      }),
    stop: () =>
      new Promise<string>((resolve) => {
        const rec = recognition;
        if (!rec) {
          const captured = endedTranscript ?? "";
          endedTranscript = null;
          return resolve(captured);
        }
        resolveStop = resolve;
        // Watchdog: some webviews never fire onend/onerror after stop(). Force-resolve + abort so the
        // caller is guaranteed to unblock and the recording state can always be cleared.
        stopWatchdog = window.setTimeout(() => {
          try {
            rec.abort();
          } catch {
            /* already stopped */
          }
          settle();
        }, 1200);
        try {
          rec.stop();
        } catch {
          try {
            rec.abort();
          } catch {
            /* already stopped */
          }
          settle();
        }
      }),
    cancel: () => {
      generation += 1;
      const resolve = resolveStop;
      resolveStop = null;
      endedTranscript = null;
      const rec = recognition;
      teardown();
      resolve?.("");
      try {
        rec?.abort();
      } catch {
        /* already stopped */
      }
    },
  };
}
