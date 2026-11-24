import { describe, expect, it } from "vitest";
import { detectS2sEndVoiceIntent } from "../s2s-end-voice-intent";

describe("detectS2sEndVoiceIntent", () => {
  it("ends live voice for explicit English sleep/end phrases", () => {
    expect(detectS2sEndVoiceIntent("okay, go to sleep")).toEqual({ kind: "end", phrase: "go to sleep" });
    expect(detectS2sEndVoiceIntent("okay, go to slepp")).toEqual({ kind: "end", phrase: "go to slepp" });
    expect(detectS2sEndVoiceIntent("End live voice please")).toEqual({ kind: "end", phrase: "end live voice" });
    expect(detectS2sEndVoiceIntent("stop listening")).toEqual({ kind: "end", phrase: "stop listening" });
  });

  it("ends live voice for Indonesian and casual mixed phrases", () => {
    expect(detectS2sEndVoiceIntent("oke tidur dulu")).toEqual({ kind: "end", phrase: "tidur dulu" });
    expect(detectS2sEndVoiceIntent("udah cukup lotus")).toEqual({ kind: "end", phrase: "udah cukup" });
    expect(detectS2sEndVoiceIntent("matikan live voice")).toEqual({ kind: "end", phrase: "matikan live voice" });
  });

  it("ends live voice for natural sign-offs and gratitude-prefixed endings", () => {
    expect(detectS2sEndVoiceIntent("bye")).toEqual({ kind: "end", phrase: "bye" });
    expect(detectS2sEndVoiceIntent("okay bye bye")).toEqual({ kind: "end", phrase: "bye bye" });
    expect(detectS2sEndVoiceIntent("thanks, that's all")).toEqual({ kind: "end", phrase: "thats all" });
    expect(detectS2sEndVoiceIntent("makasih udahan")).toEqual({ kind: "end", phrase: "udahan" });
    expect(detectS2sEndVoiceIntent("dadah")).toEqual({ kind: "end", phrase: "dadah" });
    expect(detectS2sEndVoiceIntent("sampai jumpa ya")).toEqual({ kind: "end", phrase: "sampai jumpa" });
    expect(detectS2sEndVoiceIntent("segitu aja deh")).toEqual({ kind: "end", phrase: "segitu aja" });
    expect(detectS2sEndVoiceIntent("terima kasih sudah cukup")).toEqual({ kind: "end", phrase: "sudah cukup" });
  });

  it("does not steal targeted agent instructions that happen to contain sleep words", () => {
    expect(detectS2sEndVoiceIntent("tell Claude to go to sleep after finishing the task")).toEqual({ kind: "none" });
    expect(detectS2sEndVoiceIntent("suruh Bima tidur dulu setelah selesai")).toEqual({ kind: "none" });
  });

  it("does not end when a farewell word is only message content, not a sign-off", () => {
    expect(detectS2sEndVoiceIntent("ask Nara to say goodbye when the deploy is done")).toEqual({ kind: "none" });
    expect(detectS2sEndVoiceIntent("thanks for the help earlier")).toEqual({ kind: "none" });
  });
});
