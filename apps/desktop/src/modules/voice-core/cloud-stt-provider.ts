import type { SttProvider, SttProviderKind } from "./stt-provider";
import { createStreamSpectrumTap, type StreamSpectrumTap } from "./spectrum-sampler";

/** A live microphone recording in progress. */
export interface SttRecording {
  /** Stop recording and resolve with the captured audio (base64 + MIME). */
  stop: () => Promise<{ base64: string; mime: string }>;
  /** Abort recording and release the mic without producing audio. */
  cancel: () => void;
  /** The live mic stream, when the recorder exposes it — tapped (read-only) for the listening-border
   *  spectrum. Optional so injected test recorders and exotic capture paths stay valid. */
  stream?: MediaStream;
}

export interface CloudSttDeps {
  /**
   * Routes to the Rust `stt_transcribe` command. The API key stays in Rust and is never passed here.
   * Rejects with the stub's "not implemented (BYOK)" error until a provider call is implemented.
   */
  transcribe: (audioBase64: string, mime: string) => Promise<string>;
  /** Injectable recorder factory for tests; defaults to MediaRecorder via getUserMedia. */
  record?: () => Promise<SttRecording>;
}

/**
 * How long `stop()` waits for `MediaRecorder.onstop` before releasing the mic anyway. Some webviews
 * accept `stop()` and never emit the event; without this the promise never settles and the microphone
 * stays held for the rest of the app's life. Mirrors the browser STT provider's stop watchdog.
 */
const RECORDER_STOP_TIMEOUT_MS = 1_500;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function defaultRecord(): Promise<SttRecording> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices || typeof MediaRecorder === "undefined") {
    return Promise.reject(new Error("Microphone capture is unavailable in this environment."));
  }
  // Raw mic, matching the streaming path: batch capture is half-duplex, so there is no echo to
  // cancel — and asking for cancellation puts the shared macOS device pair into voice-processing mode,
  // muffling every other app using it. See `PcmCaptureOptions.voiceProcessing`.
  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  return navigator.mediaDevices.getUserMedia({ audio }).then((stream) => {
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.start();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      stream.getTracks().forEach((t) => t.stop());
    };
    return {
      stream,
      stop: () =>
        new Promise<{ base64: string; mime: string }>((resolve, reject) => {
          let settled = false;
          let watchdog: ReturnType<typeof setTimeout> | null = null;
          const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            if (watchdog !== null) clearTimeout(watchdog);
            fn();
          };
          // Package whatever chunks arrived. An empty capture yields base64 "" and the caller skips
          // transcription entirely, so a partial/absent recording costs no provider round-trip.
          const deliver = async () => {
            try {
              const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
              const base64 = await blobToBase64(blob);
              settle(() => resolve({ base64, mime: blob.type }));
            } catch (err) {
              settle(() => reject(err instanceof Error ? err : new Error(String(err))));
            }
          };
          rec.onstop = () => {
            release(); // free the device before the (async) base64 encode, not after
            void deliver();
          };
          // The recorder may accept stop() and never report. The mic must come back regardless.
          watchdog = setTimeout(() => {
            release();
            void deliver();
          }, RECORDER_STOP_TIMEOUT_MS);
          try {
            rec.stop();
          } catch {
            // InvalidStateError — the recorder is already inactive, so `onstop` will never fire and
            // nothing else would ever release the stream. Free the mic and resolve with what we have.
            release();
            void deliver();
          }
        }),
      cancel: () => {
        try {
          rec.stop();
        } catch {
          /* already stopped */
        }
        release();
      },
    };
  });
}

export interface CloudSttOptions {
  /** Live frequency-spectrum callback for the listening-border visualizer. The recording's mic stream
   *  is tapped read-only; failures are swallowed so the visualizer can never break capture. */
  onSpectrum?: (bands: number[]) => void;
  /** Injectable tap factory (tests); defaults to {@link createStreamSpectrumTap}. */
  spectrumTap?: (stream: MediaStream, onSpectrum: (bands: number[]) => void) => StreamSpectrumTap | null;
}

/**
 * BYOK cloud STT adapter (OpenAI Whisper / Deepgram / custom). Records mic audio via MediaRecorder,
 * then routes transcription through the Rust `stt_transcribe` seam so the API key never enters the
 * renderer. While recording, the mic stream also feeds the listening-border spectrum — batch is what
 * the streaming fallback lands on, so without this tap the border would sit static for those captures.
 */
export function createCloudSttProvider(
  id: string,
  kind: Exclude<SttProviderKind, "browser">,
  deps: CloudSttDeps,
  opts: CloudSttOptions = {},
): SttProvider {
  const record = deps.record ?? defaultRecord;
  let recording: SttRecording | null = null;
  let tap: StreamSpectrumTap | null = null;

  const releaseTap = () => {
    tap?.stop();
    tap = null;
  };

  return {
    id,
    kind,
    isAvailable: () => typeof navigator !== "undefined" && !!navigator.mediaDevices,
    start: async () => {
      const nextRecording = await record();
      recording = nextRecording;
      if (opts.onSpectrum && nextRecording.stream) {
        tap = (opts.spectrumTap ?? createStreamSpectrumTap)(nextRecording.stream, opts.onSpectrum);
      }
    },
    stop: async () => {
      releaseTap();
      const owner = recording;
      if (!owner) return "";
      const { base64, mime } = await owner.stop();
      if (recording === owner) recording = null;
      if (!base64) return "";
      return deps.transcribe(base64, mime);
    },
    cancel: () => {
      releaseTap();
      const owner = recording;
      recording = null;
      owner?.cancel();
    },
  };
}
