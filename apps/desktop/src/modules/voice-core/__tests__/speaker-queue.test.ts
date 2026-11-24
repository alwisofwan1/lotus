import { describe, it, expect } from "vitest";
import { createSpeakerQueue, calloutSummaryLine, type SpeakerPlayer } from "../speaker-queue";

/** A player whose utterances finish only when the test says so — so "who is speaking" is observable. */
function scriptedPlayer() {
  const started: string[] = [];
  const stopped: string[] = [];
  const pending = new Map<string, () => void>();
  const player: SpeakerPlayer = {
    play: (text, { signal }) =>
      new Promise<void>((resolve) => {
        started.push(text);
        pending.set(text, resolve);
        signal.addEventListener("abort", () => {
          stopped.push(text);
          pending.delete(text);
          resolve();
        });
      }),
  };
  const finish = async (text: string) => {
    pending.get(text)?.();
    pending.delete(text);
    await flush();
  };
  return { player, started, stopped, finish, speaking: () => [...pending.keys()] };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("Speaker Queue", () => {
  it("speaks one utterance at a time", async () => {
    const p = scriptedPlayer();
    const q = createSpeakerQueue(p.player);
    void q.enqueue({ priority: "narration", text: "Atlas is reading files" });
    void q.enqueue({ priority: "narration", text: "Rowan is running tests" });
    await flush();
    expect(p.speaking()).toEqual(["Atlas is reading files"]);
    await p.finish("Atlas is reading files");
    expect(p.speaking()).toEqual(["Rowan is running tests"]);
  });

  it("lets a waiting reply go before waiting callouts and narration", async () => {
    const p = scriptedPlayer();
    const q = createSpeakerQueue(p.player);
    void q.enqueue({ priority: "narration", text: "n1" });
    await flush();
    void q.enqueue({ priority: "narration", text: "n2" });
    void q.enqueue({ priority: "callout", text: "Atlas finished", name: "Atlas" });
    void q.enqueue({ priority: "reply", text: "Opened three agents" });
    await p.finish("n1");
    expect(p.speaking()).toEqual(["Opened three agents"]);
    await p.finish("Opened three agents");
    expect(p.speaking()).toEqual(["Atlas finished"]);
    await p.finish("Atlas finished");
    expect(p.speaking()).toEqual(["n2"]);
  });

  it("never cuts the current utterance off for a higher-priority one", async () => {
    const p = scriptedPlayer();
    const q = createSpeakerQueue(p.player);
    void q.enqueue({ priority: "narration", text: "n1" });
    await flush();
    void q.enqueue({ priority: "reply", text: "reply" });
    await flush();
    expect(p.stopped).toEqual([]);
    expect(p.speaking()).toEqual(["n1"]);
  });

  it("enqueue resolves when the utterance has finished playing", async () => {
    const p = scriptedPlayer();
    const q = createSpeakerQueue(p.player);
    let done = false;
    void q.enqueue({ priority: "narration", text: "n1" }).then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    await p.finish("n1");
    expect(done).toBe(true);
  });

  describe("Live Voice hold", () => {
    it("stops what is playing at once and silences everything after it", async () => {
      const p = scriptedPlayer();
      const q = createSpeakerQueue(p.player);
      void q.enqueue({ priority: "reply", text: "reply" });
      void q.enqueue({ priority: "narration", text: "n1" });
      await flush();
      q.hold();
      await flush();
      expect(p.stopped).toEqual(["reply"]);
      void q.enqueue({ priority: "reply", text: "late reply" });
      void q.enqueue({ priority: "narration", text: "n2" });
      await flush();
      expect(p.speaking()).toEqual([]);
      expect(p.started).toEqual(["reply"]);
    });

    it("drops held narration on release", async () => {
      const p = scriptedPlayer();
      const q = createSpeakerQueue(p.player);
      q.hold();
      void q.enqueue({ priority: "narration", text: "stale progress" });
      q.release();
      await flush();
      expect(p.started).toEqual([]);
    });

    it("plays a single held callout as it was said", async () => {
      const p = scriptedPlayer();
      const q = createSpeakerQueue(p.player);
      q.hold();
      void q.enqueue({ priority: "callout", text: "Atlas finished.", name: "Atlas", language: "en" });
      q.release();
      await flush();
      expect(p.started).toEqual(["Atlas finished."]);
    });

    it("sums several held callouts into one line that names them", async () => {
      const p = scriptedPlayer();
      const q = createSpeakerQueue(p.player);
      void q.enqueue({ priority: "callout", text: "Atlas finished.", name: "Atlas" });
      await flush();
      q.hold();
      void q.enqueue({ priority: "callout", text: "Rowan finished.", name: "Rowan" });
      void q.enqueue({ priority: "callout", text: "Atlas finished again.", name: "Atlas" });
      void q.enqueue({ priority: "callout", text: "Mira finished.", name: "Mira" });
      q.release();
      await flush();
      // The callout that was playing when Live Voice started counts as held too: it was cut off.
      expect(p.started).toEqual(["Atlas finished.", "Atlas, Rowan and Mira finished."]);
    });

    it("says a count instead of names when more than three agents finished", async () => {
      const p = scriptedPlayer();
      const q = createSpeakerQueue(p.player);
      q.hold();
      for (const name of ["Atlas", "Rowan", "Mira", "Kai"]) {
        void q.enqueue({ priority: "callout", text: `${name} finished.`, name, language: "id" });
      }
      q.release();
      await flush();
      expect(p.started).toEqual(["4 agen selesai."]);
    });

    it("counts instead of naming when a held callout has no name, so no agent is left out", async () => {
      const p = scriptedPlayer();
      const q = createSpeakerQueue(p.player);
      q.hold();
      void q.enqueue({ priority: "callout", text: "Atlas finished.", name: "Atlas" });
      void q.enqueue({ priority: "callout", text: "Rowan finished.", name: "Rowan" });
      void q.enqueue({ priority: "callout", text: "An agent finished." });
      q.release();
      await flush();
      expect(p.started).toEqual(["3 agents finished."]);
    });

    it("names an agent once when it finished twice during Live Voice", async () => {
      const p = scriptedPlayer();
      const q = createSpeakerQueue(p.player);
      q.hold();
      void q.enqueue({ priority: "callout", text: "Atlas finished.", name: "Atlas" });
      void q.enqueue({ priority: "callout", text: "Atlas finished again.", name: "Atlas" });
      q.release();
      await flush();
      expect(p.started).toEqual(["Atlas finished."]);
    });

    it("releasing without held callouts stays silent", async () => {
      const p = scriptedPlayer();
      const q = createSpeakerQueue(p.player);
      q.hold();
      q.release();
      await flush();
      expect(p.started).toEqual([]);
    });
  });

  it("stopAll silences the current utterance and drops everything waiting", async () => {
    const p = scriptedPlayer();
    const q = createSpeakerQueue(p.player);
    void q.enqueue({ priority: "callout", text: "c1", name: "Atlas" });
    void q.enqueue({ priority: "reply", text: "r1" });
    void q.enqueue({ priority: "narration", text: "n1" });
    await flush();
    q.stopAll();
    await flush();
    expect(p.stopped).toEqual(["c1"]);
    expect(p.started).toEqual(["c1"]);
    void q.enqueue({ priority: "reply", text: "next" });
    await flush();
    expect(p.speaking()).toEqual(["next"]);
  });

  it("stop(priority) silences only that kind of speech", async () => {
    const p = scriptedPlayer();
    const q = createSpeakerQueue(p.player);
    void q.enqueue({ priority: "reply", text: "r1" });
    void q.enqueue({ priority: "reply", text: "r2" });
    void q.enqueue({ priority: "narration", text: "n1" });
    await flush();
    q.stop("reply");
    await flush();
    expect(p.stopped).toEqual(["r1"]);
    expect(p.speaking()).toEqual(["n1"]);
  });

  it("a failing utterance does not wedge the queue", async () => {
    const started: string[] = [];
    const q = createSpeakerQueue({
      play: async (text) => {
        started.push(text);
        if (text === "bad") throw new Error("synthesis failed");
      },
    });
    await q.enqueue({ priority: "reply", text: "bad" });
    await q.enqueue({ priority: "reply", text: "good" });
    expect(started).toEqual(["bad", "good"]);
  });
});

describe("calloutSummaryLine", () => {
  it("names up to three agents, counts more", () => {
    expect(calloutSummaryLine(["Atlas", "Rowan"], "en")).toBe("Atlas and Rowan finished.");
    expect(calloutSummaryLine(["Atlas", "Rowan"], "id-ID")).toBe("Atlas dan Rowan selesai.");
    expect(calloutSummaryLine(["A", "B", "C", "D", "E"], "en")).toBe("5 agents finished.");
  });
});
