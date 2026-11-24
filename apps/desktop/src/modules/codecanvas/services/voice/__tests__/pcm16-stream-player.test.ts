import { describe, expect, it } from "vitest";
import {
  createPcm16StreamPlayer,
  decodePcm16Base64,
  pcm16Base64ByteLength,
  type Pcm16Sink,
  type ScheduledSource,
} from "../pcm16-stream-player";

/** A fake audio sink with a controllable clock, recording scheduled starts and stop() calls. */
function fakeSink(startClock = 0) {
  let clock = startClock;
  const scheduled: { startAt: number; samples: number; stopped: boolean; stopMode?: string }[] = [];
  const sink: Pcm16Sink = {
    now: () => clock,
    play: (samples, _rate, startAt): ScheduledSource => {
      const entry = { startAt, samples: samples.length, stopped: false, stopMode: undefined as string | undefined };
      scheduled.push(entry);
      return {
        stop: (mode) => {
          entry.stopped = true;
          entry.stopMode = mode;
        },
      };
    },
  };
  return { sink, scheduled, advance: (dt: number) => (clock += dt) };
}

/** base64 of one PCM16 sample (value 1, little-endian) repeated `n` times. */
function pcm16Base64(n: number): string {
  const bytes = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) bytes[i * 2] = 1;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("createPcm16StreamPlayer", () => {
  it("schedules the first chunk at the current clock time", () => {
    const { sink, scheduled } = fakeSink(5);
    const player = createPcm16StreamPlayer(sink, 24000);
    player.enqueue(pcm16Base64(2400)); // 0.1s of audio
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].startAt).toBe(5);
  });

  it("schedules the next chunk gaplessly at the end of the previous one", () => {
    const { sink, scheduled } = fakeSink(0);
    const player = createPcm16StreamPlayer(sink, 24000);
    player.enqueue(pcm16Base64(2400)); // 0.1s → ends at 0.1
    player.enqueue(pcm16Base64(2400)); // starts exactly at 0.1
    expect(scheduled[1].startAt).toBeCloseTo(0.1, 6);
  });

  it("recovers from underrun — a chunk enqueued after the queue drained starts at now(), not the past", () => {
    const { sink, scheduled, advance } = fakeSink(0);
    const player = createPcm16StreamPlayer(sink, 24000);
    player.enqueue(pcm16Base64(2400)); // ends at 0.1
    advance(0.5); // clock now past the cursor
    player.enqueue(pcm16Base64(2400));
    expect(scheduled[1].startAt).toBe(0.5);
  });

  it("barge-in stops every scheduled chunk and resets the timeline", () => {
    const { sink, scheduled } = fakeSink(0);
    const player = createPcm16StreamPlayer(sink, 24000);
    player.enqueue(pcm16Base64(2400));
    player.enqueue(pcm16Base64(2400));
    player.interrupt();
    expect(scheduled.every((s) => s.stopped)).toBe(true);
    expect(scheduled.every((s) => s.stopMode === "fade")).toBe(true);
    // After interrupt the next chunk starts fresh at the current clock, not stacked on the old cursor.
    player.enqueue(pcm16Base64(2400));
    expect(scheduled[2].startAt).toBe(0);
  });

  it("reports active while audio is scheduled ahead of the clock, idle once it has played out", () => {
    const { sink, advance } = fakeSink(0);
    const player = createPcm16StreamPlayer(sink, 24000);
    expect(player.active).toBe(false);
    player.enqueue(pcm16Base64(2400)); // 0.1s ahead
    expect(player.active).toBe(true);
    advance(0.2);
    expect(player.active).toBe(false);
  });

  it("ignores an empty delta", () => {
    const { sink, scheduled } = fakeSink(0);
    const player = createPcm16StreamPlayer(sink, 24000);
    player.enqueue("");
    expect(scheduled).toHaveLength(0);
  });
});

describe("decodePcm16Base64", () => {
  it("decodes little-endian PCM16 samples", () => {
    // bytes [0x00,0x01] little-endian = 256; [0xff,0x7f] = 32767
    const bin = String.fromCharCode(0x00, 0x01, 0xff, 0x7f);
    const samples = decodePcm16Base64(btoa(bin));
    expect(Array.from(samples)).toEqual([256, 32767]);
  });
});

// This total bounds `audio_end_ms` for `conversation.item.truncate`. Over-reporting loosens that
// clamp and a provider rejects an end past the real audio duration, so it must match the decoded
// length exactly for every padding case.
describe("pcm16Base64ByteLength", () => {
  it("matches the real decoded length across all three padding cases", () => {
    for (const byteCount of [1, 2, 3, 4, 5, 6, 300]) {
      const bin = String.fromCharCode(...Array.from({ length: byteCount }, (_, i) => i % 256));
      const b64 = btoa(bin);
      expect(pcm16Base64ByteLength(b64)).toBe(byteCount);
    }
  });

  it("is zero for an empty payload", () => {
    expect(pcm16Base64ByteLength("")).toBe(0);
  });
});
