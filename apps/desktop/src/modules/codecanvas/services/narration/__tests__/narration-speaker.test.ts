import { describe, expect, it, vi } from "vitest";
import { createNarrationSpeaker } from "../narration-speaker";

/** A speak() whose completion the test controls, so "still talking" is a real state. */
function controllableSpeak() {
  const calls: string[] = [];
  let release: (() => void) | null = null;
  const speak = vi.fn((text: string) => {
    calls.push(text);
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  return {
    speak,
    calls,
    finish: () => {
      release?.();
      release = null;
      return Promise.resolve();
    },
  };
}

const compose = async (parts: readonly string[]) => parts.join(", ");

/** Let compose + speak dispatch. pump() must NOT be awaited when speak() is still hanging. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createNarrationSpeaker", () => {
  it("speaks the first batch", async () => {
    const tts = controllableSpeak();
    const speaker = createNarrationSpeaker({ speak: tts.speak, compose, breathMs: 0 });

    speaker.offer(["editing auth"]);
    void speaker.pump();
    await settle();

    expect(tts.calls).toEqual(["editing auth"]);
  });

  it("will not start a second utterance while the first is still being spoken", async () => {
    // This is the stutter. The old gate was a 2.5s timer measured from the moment we DECIDED to
    // speak — it had no relationship to how long the sentence actually takes, so a 4-second line
    // was routinely cut off by the next one.
    const tts = controllableSpeak();
    const speaker = createNarrationSpeaker({ speak: tts.speak, compose, breathMs: 0 });

    speaker.offer(["first line"]);
    void speaker.pump();
    await settle();
    speaker.offer(["second line"]);
    void speaker.pump();
    void speaker.pump();
    await settle();

    expect(tts.calls).toEqual(["first line"]);
  });

  it("speaks the next batch once the previous utterance has actually finished", async () => {
    const tts = controllableSpeak();
    const speaker = createNarrationSpeaker({ speak: tts.speak, compose, breathMs: 0 });

    speaker.offer(["first line"]);
    void speaker.pump();
    await settle();
    speaker.offer(["second line"]);
    await tts.finish();
    await settle();
    void speaker.pump();
    await settle();

    expect(tts.calls).toEqual(["first line", "second line"]);
  });

  it("merges everything offered while it was talking into ONE next utterance", async () => {
    const tts = controllableSpeak();
    const speaker = createNarrationSpeaker({ speak: tts.speak, compose, breathMs: 0 });

    speaker.offer(["first"]);
    void speaker.pump();
    await settle();
    speaker.offer(["editing auth"]);
    speaker.offer(["editing token"]);
    speaker.offer(["ran the tests"]);
    await tts.finish();
    await settle();
    void speaker.pump();
    await settle();

    expect(tts.calls[1]).toBe("editing auth, editing token, ran the tests");
  });

  it("holds the slot across composition, not just across playback", async () => {
    // Composition can take seconds. Claiming the slot only at playback time let two compositions
    // run concurrently and resolve together — two utterances landing at once.
    const tts = controllableSpeak();
    let releaseCompose: ((v: string) => void) | undefined;
    const slowCompose = vi.fn(() => new Promise<string>((resolve) => { releaseCompose = resolve; }));
    const speaker = createNarrationSpeaker({ speak: tts.speak, compose: slowCompose, breathMs: 0 });

    speaker.offer(["a"]);
    void speaker.pump();
    await settle();
    speaker.offer(["b"]);
    void speaker.pump();
    await settle();

    expect(slowCompose).toHaveBeenCalledTimes(1);
    releaseCompose?.("a");
  });

  it("keeps going after a failed utterance instead of wedging forever", async () => {
    // A speak() that rejects must release the slot, or narration goes permanently silent.
    const speak = vi.fn().mockRejectedValueOnce(new Error("tts down")).mockResolvedValue(undefined);
    const speaker = createNarrationSpeaker({ speak, compose, breathMs: 0 });

    speaker.offer(["first"]);
    await speaker.pump();
    speaker.offer(["second"]);
    await speaker.pump();

    expect(speak).toHaveBeenCalledTimes(2);
  });

  it("says nothing when nothing was offered", async () => {
    const tts = controllableSpeak();
    const speaker = createNarrationSpeaker({ speak: tts.speak, compose, breathMs: 0 });

    await speaker.pump();

    expect(tts.speak).not.toHaveBeenCalled();
  });

  it("drops a batch that composes to nothing without wedging the slot", async () => {
    const tts = controllableSpeak();
    const speaker = createNarrationSpeaker({ speak: tts.speak, compose: async () => null, breathMs: 0 });

    speaker.offer(["a"]);
    await speaker.pump();

    expect(tts.speak).not.toHaveBeenCalled();
    expect(speaker.speaking()).toBe(false);
  });
});

describe("createNarrationSpeaker — already-composed lines", () => {
  it("speaks a finished sentence as-is, without a composition round-trip", async () => {
    // A digest from summarizeFlush ("Three edits.") already carries counts, and the narration
    // policy insists numbers survive. Rewriting it drops them.
    const tts = controllableSpeak();
    const compose = vi.fn(async (parts: readonly string[]) => parts.join(", "));
    const speaker = createNarrationSpeaker({ speak: tts.speak, compose, breathMs: 0 });

    speaker.offer(["Three edits."], { alreadyComposed: true });
    void speaker.pump();
    await settle();

    expect(tts.calls).toEqual(["Three edits."]);
    expect(compose).not.toHaveBeenCalled();
  });

  it("does not let an ordinary step ride along uncomposed with a digest", async () => {
    // Mixing them would either rewrite the digest or leave the step mechanical. Keep them apart:
    // the finished line goes first, on its own.
    const tts = controllableSpeak();
    const speaker = createNarrationSpeaker({
      speak: tts.speak,
      compose: async (parts) => `composed(${parts.join("+")})`,
      breathMs: 0,
    });

    speaker.offer(["editing auth"]);
    speaker.offer(["Three edits."], { alreadyComposed: true });
    void speaker.pump();
    await settle();
    await tts.finish();
    await settle();
    void speaker.pump();
    await settle();

    expect(tts.calls).toEqual(["composed(editing auth)", "Three edits."]);
  });
});
