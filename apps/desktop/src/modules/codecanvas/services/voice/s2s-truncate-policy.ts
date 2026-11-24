/**
 * Barge-in truncation policy for Live Voice (S2S) — pure decision logic over an injected,
 * immutable per-response state.
 *
 * WHY: today a barge-in sends only `response.cancel`. OpenAI's realtime docs are explicit that a
 * client which buffers assistant audio locally (this app does — see `html-audio-pcm16-player.ts`)
 * must also send `conversation.item.truncate` with how much of that audio the user actually heard:
 * "Truncating audio will delete the server-side text transcript to ensure there is not text in the
 * context that hasn't been heard by the user." Without it, the model's context keeps sentences the
 * user never heard and later refers back to things it never actually said.
 *
 * Played-duration model: modeled on `createHtmlAudioPcm16Player` (`html-audio-pcm16-player.ts`), the
 * player actually used in this app — a macOS WKWebView (Tauri) silently drops Web Audio
 * `AudioContext.destination` output, so playback goes through chained `HTMLAudioElement` WAV
 * segments instead (see that file's header comment and repo CLAUDE.md). That player already tracks,
 * per segment, when playback truly started/ended/was stopped, and an `HTMLAudioElement` exposes a
 * real `currentTime` playback-position signal even mid-segment. This module does not read the player
 * directly (it is pure and has no I/O) — the caller reports played bytes as they become known:
 * the full byte length of each segment on `onEnded`, and the partial byte length of the segment
 * that was still playing at the moment of barge-in (derived from `audio.currentTime` right before
 * `stop()`). Either source degrades gracefully to "0 bytes played" if unavailable, which this module
 * treats as "no truncation needed" rather than guessing.
 *
 * Immutable transitions, injected clock-free (audio duration only needs byte counts, never wall-clock
 * time), following the shape of `s2s-user-transcript-buffer.ts`.
 */

import { DEFAULT_S2S_OUTPUT_SAMPLE_RATE } from "./pcm16-stream-player";

/** PCM16 is 2 bytes per sample, regardless of channel layout (this app's S2S audio is mono). */
export const PCM16_BYTES_PER_SAMPLE = 2;

/**
 * Convert a byte count of mono PCM16 audio into milliseconds.
 *
 * A byte count that is not a whole number of 2-byte samples (e.g. a truncated trailing byte from a
 * mid-frame cut) drops the odd trailing byte — it is floored to whole *samples* before converting to
 * milliseconds, so it never silently reports a fractional-sample duration.
 */
export function pcm16BytesToMs(bytes: number, sampleRateHz: number = DEFAULT_S2S_OUTPUT_SAMPLE_RATE): number {
  const wholeSamples = Math.floor(Math.max(0, bytes) / PCM16_BYTES_PER_SAMPLE);
  return (wholeSamples * 1000) / sampleRateHz;
}

/** Convert milliseconds into a byte count of mono PCM16 audio, floored to a whole sample. */
export function pcm16MsToBytes(ms: number, sampleRateHz: number = DEFAULT_S2S_OUTPUT_SAMPLE_RATE): number {
  const wholeSamples = Math.floor((Math.max(0, ms) * sampleRateHz) / 1000);
  return wholeSamples * PCM16_BYTES_PER_SAMPLE;
}

/** Per-response tracking of one assistant audio item's enqueued/played bytes. */
export interface S2sTruncatePolicyState {
  /** The assistant item currently (or most recently) streaming audio; null while none is in flight,
   *  or while the provider never supplied an item id for the in-flight audio. */
  readonly itemId: string | null;
  /** Total PCM16 bytes enqueued to the player for this item so far. */
  readonly enqueuedBytes: number;
  /** PCM16 bytes the caller has confirmed were actually played (not merely scheduled/buffered). */
  readonly playedBytes: number;
  /** True once this item's audio played to completion without a barge-in. */
  readonly completed: boolean;
  /** The itemId a truncate has already been issued for — guards against re-issuing on repeated
   *  barge-in signals for the same item. */
  readonly truncatedItemId: string | null;
}

export function initialS2sTruncatePolicyState(): S2sTruncatePolicyState {
  return { itemId: null, enqueuedBytes: 0, playedBytes: 0, completed: false, truncatedItemId: null };
}

/** A new assistant audio response started streaming — reset per-item counters. */
export function beginAssistantAudioItem(
  state: S2sTruncatePolicyState,
  itemId: string | null,
): S2sTruncatePolicyState {
  return {
    itemId,
    enqueuedBytes: 0,
    playedBytes: 0,
    completed: false,
    truncatedItemId: state.truncatedItemId,
  };
}

/** More PCM16 bytes were enqueued to the player for `itemId`. Ignored if `itemId` is stale
 *  (a late event for an item that is no longer current) or `byteLength` is not positive. */
export function recordEnqueuedAudioBytes(
  state: S2sTruncatePolicyState,
  itemId: string | null,
  byteLength: number,
): S2sTruncatePolicyState {
  if (state.itemId !== itemId || byteLength <= 0) return state;
  return { ...state, enqueuedBytes: state.enqueuedBytes + byteLength };
}

/** PCM16 bytes were confirmed actually played for `itemId` (a full completed segment, or the
 *  partial tail of the segment interrupted by barge-in). Clamped so playedBytes can never exceed
 *  enqueuedBytes. Ignored if `itemId` is stale or `byteLength` is not positive. */
export function recordPlayedAudioBytes(
  state: S2sTruncatePolicyState,
  itemId: string | null,
  byteLength: number,
): S2sTruncatePolicyState {
  if (state.itemId !== itemId || byteLength <= 0) return state;
  return { ...state, playedBytes: Math.min(state.enqueuedBytes, state.playedBytes + byteLength) };
}

/** The item's audio played to completion with no barge-in — nothing left to truncate. */
export function markAssistantAudioItemComplete(
  state: S2sTruncatePolicyState,
  itemId: string | null,
): S2sTruncatePolicyState {
  if (state.itemId !== itemId) return state;
  return { ...state, completed: true, playedBytes: state.enqueuedBytes };
}

/** Record that a truncate call was actually issued for `itemId` — makes the next barge-in for the
 *  same item a no-op. Ignored if `itemId` does not match the currently tracked item. */
export function markTruncateIssued(state: S2sTruncatePolicyState, itemId: string): S2sTruncatePolicyState {
  if (state.itemId !== itemId) return state;
  return { ...state, truncatedItemId: itemId };
}

export type S2sTruncateDecision =
  | { shouldTruncate: false }
  | { shouldTruncate: true; itemId: string; audioEndMs: number };

const NO_TRUNCATE: S2sTruncateDecision = { shouldTruncate: false };

/**
 * Decide whether a barge-in should issue `conversation.item.truncate`, and with what `audio_end_ms`.
 *
 * No-truncate cases: no assistant item in flight; the item is tracked but its provider never
 * supplied an id (itemId unknown); the item already finished playing completely; played duration is
 * 0; or this item was already truncated (idempotent — safe to call repeatedly, including after a
 * `response.cancel` has already fired).
 *
 * `audioEndMs` is always a non-negative integer, clamped to the item's total enqueued duration — it
 * must never exceed the real audio duration (OpenAI rejects an `audio_end_ms` past the actual audio),
 * so this clamps defensively even if playedBytes was somehow recorded beyond enqueuedBytes.
 */
export function decideBargeInTruncate(
  state: S2sTruncatePolicyState,
  sampleRateHz: number = DEFAULT_S2S_OUTPUT_SAMPLE_RATE,
): S2sTruncateDecision {
  const { itemId } = state;
  if (!itemId) return NO_TRUNCATE;
  if (state.truncatedItemId === itemId) return NO_TRUNCATE;
  if (state.completed) return NO_TRUNCATE;
  if (state.playedBytes <= 0) return NO_TRUNCATE;

  const playedMs = Math.floor(pcm16BytesToMs(state.playedBytes, sampleRateHz));
  if (playedMs <= 0) return NO_TRUNCATE;

  const totalMs = Math.floor(pcm16BytesToMs(state.enqueuedBytes, sampleRateHz));
  const audioEndMs = Math.min(Math.max(0, playedMs), Math.max(0, totalMs));

  return { shouldTruncate: true, itemId, audioEndMs };
}
