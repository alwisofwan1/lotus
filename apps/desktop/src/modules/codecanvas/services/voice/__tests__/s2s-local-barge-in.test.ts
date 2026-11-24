import { describe, expect, it } from "vitest";
import { isS2sSpeechLikeMicChunk, shouldTriggerS2sLocalBargeIn } from "../s2s-local-barge-in";

function pcm16Base64(samples: number[]): string {
  const bytes = new Uint8Array(samples.length * 2);
  samples.forEach((sample, i) => {
    const v = sample < 0 ? 0x10000 + sample : sample;
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  });
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("isS2sSpeechLikeMicChunk", () => {
  it("classifies speech-like local mic audio without requiring recent agent audio", () => {
    expect(isS2sSpeechLikeMicChunk(pcm16Base64(new Array(64).fill(4_000)))).toBe(true);
    expect(isS2sSpeechLikeMicChunk(pcm16Base64(new Array(64).fill(80)))).toBe(false);
    expect(isS2sSpeechLikeMicChunk("not-base64")).toBe(false);
  });
});

describe("shouldTriggerS2sLocalBargeIn", () => {
  it("triggers for loud local mic speech while agent audio is recent", () => {
    const loudSpeech = pcm16Base64(new Array(64).fill(9_000));

    expect(
      shouldTriggerS2sLocalBargeIn({
        audioBase64: loudSpeech,
        agentAudioRecent: true,
        nowMs: 1_000,
        lastTriggerMs: 0,
      }),
    ).toBe(true);
  });

  it("does not trigger for low-level echo/noise", () => {
    const quietEcho = pcm16Base64(new Array(64).fill(350));

    expect(
      shouldTriggerS2sLocalBargeIn({
        audioBase64: quietEcho,
        agentAudioRecent: true,
        nowMs: 1_000,
        lastTriggerMs: 0,
      }),
    ).toBe(false);
  });

  it("does not trigger when no agent audio is recent", () => {
    const loudSpeech = pcm16Base64(new Array(64).fill(12_000));

    expect(
      shouldTriggerS2sLocalBargeIn({
        audioBase64: loudSpeech,
        agentAudioRecent: false,
        nowMs: 1_000,
        lastTriggerMs: 0,
      }),
    ).toBe(false);
  });

  it("rate-limits repeated local barge-in triggers", () => {
    const loudSpeech = pcm16Base64(new Array(64).fill(12_000));

    expect(
      shouldTriggerS2sLocalBargeIn({
        audioBase64: loudSpeech,
        agentAudioRecent: true,
        nowMs: 1_100,
        lastTriggerMs: 1_000,
      }),
    ).toBe(false);
  });
});
