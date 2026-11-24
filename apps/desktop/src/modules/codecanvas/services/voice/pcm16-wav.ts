/**
 * Pure PCM16 → WAV container encoding for the voice-to-voice playback path.
 *
 * WHY THIS EXISTS: macOS WKWebView (the Tauri webview) has a long-standing Web Audio limitation where
 * `AudioContext.destination` output is silently dropped even though `HTMLAudioElement` playback works
 * (see the S2S GA migration notes / WebKit bug 231105 and Apple dev-forum threads). The turn-based TTS
 * path already plays reliably via `new Audio(blobUrl)`; S2S must use the SAME sink. Realtime providers
 * stream raw PCM16 (no container), so to feed it to an `<audio>` element we wrap each buffered segment
 * in a minimal WAV header here. WAV/PCM has NO encoder priming or padding, so consecutive segments
 * decoded from separate blobs play back-to-back with no click or gap — the property that makes
 * segmented streaming through discrete media elements sound continuous.
 */

/** Standard 44-byte canonical WAV header size for PCM. */
export const WAV_HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Encode mono 16-bit PCM samples as a little-endian WAV byte buffer. `sampleRate` must match the
 * stream's rate (24 kHz for OpenAI-Realtime-compatible providers) or playback pitch/speed is wrong.
 */
export function encodeWavPcm16(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  // RIFF chunk descriptor.
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // ChunkSize = 4 + (8 + Subchunk1Size) + (8 + Subchunk2Size)
  writeAscii(view, 8, "WAVE");

  // "fmt " sub-chunk (PCM).
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, 1, true); // NumChannels = 1 (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate = SampleRate * NumChannels * BitsPerSample/8
  view.setUint16(32, 2, true); // BlockAlign = NumChannels * BitsPerSample/8
  view.setUint16(34, 16, true); // BitsPerSample

  // "data" sub-chunk.
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(WAV_HEADER_BYTES + i * 2, samples[i], true);
  }
  return buffer;
}

/** Concatenate a list of Int16 sample chunks into one contiguous buffer (gapless join). */
export function concatInt16(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
