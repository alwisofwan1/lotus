import { describe, expect, it, vi } from "vitest";
import { createCloudSttProvider, type SttRecording } from "../cloud-stt-provider";

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

describe("createCloudSttProvider — stale stop isolation", () => {
  it("does not let an old cancelled stop clear a newer recording", async () => {
    const oldAudio = deferred<{ base64: string; mime: string }>();
    const oldRecording: SttRecording = { stop: vi.fn(() => oldAudio.promise), cancel: vi.fn() };
    const newRecording: SttRecording = {
      stop: vi.fn(async () => ({ base64: "bmV3", mime: "audio/webm" })),
      cancel: vi.fn(),
    };
    const record = vi.fn()
      .mockResolvedValueOnce(oldRecording)
      .mockResolvedValueOnce(newRecording);
    const transcribe = vi.fn(async (base64: string) => base64 === "bmV3" ? "new transcript" : "stale transcript");
    const provider = createCloudSttProvider("openai", "openai", { record, transcribe });

    await provider.start();
    const oldStop = provider.stop();
    provider.cancel();
    await provider.start();
    oldAudio.resolve({ base64: "b2xk", mime: "audio/webm" });
    await oldStop;

    await expect(provider.stop()).resolves.toBe("new transcript");
    expect(newRecording.stop).toHaveBeenCalledOnce();
  });
});
