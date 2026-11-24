import { describe, it, expect, vi } from "vitest";
import { createSpeechGate } from "../speech-gate";

describe("createSpeechGate (barge-in)", () => {
  it("speaks through a sink opened while the gate is un-interrupted", () => {
    const speak = vi.fn();
    const gate = createSpeechGate({ speak, stop: vi.fn() });
    gate.open()("Creating a terminal node");
    expect(speak).toHaveBeenCalledWith("Creating a terminal node");
  });

  it("interrupt() stops in-flight speech immediately", () => {
    const stop = vi.fn();
    const gate = createSpeechGate({ speak: vi.fn(), stop });
    gate.interrupt();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("mutes a sink opened BEFORE the interrupt — a late async confirmation is dropped, not spoken", () => {
    const speak = vi.fn();
    const gate = createSpeechGate({ speak, stop: vi.fn() });
    // The command bar opens a sink, then composeSpokenConfirmation runs for up to 4s. If the user
    // barges in (starts talking / submits a new command) meanwhile, the stale text must NOT speak.
    const sink = gate.open();
    gate.interrupt();
    sink("Spawning 3 Claude agents");
    expect(speak).not.toHaveBeenCalled();
  });

  it("a sink opened AFTER an interrupt speaks normally (the new turn owns the voice)", () => {
    const speak = vi.fn();
    const gate = createSpeechGate({ speak, stop: vi.fn() });
    gate.interrupt();
    gate.open()("Arranging the canvas");
    expect(speak).toHaveBeenCalledWith("Arranging the canvas");
  });

  it("interleaved turns: only the sink from the latest turn is live", () => {
    const speak = vi.fn();
    const gate = createSpeechGate({ speak, stop: vi.fn() });
    const staleSink = gate.open();
    gate.interrupt();
    const freshSink = gate.open();
    staleSink("old confirmation"); // resolved late — must stay silent
    freshSink("new confirmation");
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith("new confirmation");
  });

  it("a muted sink stays muted across repeated calls", () => {
    const speak = vi.fn();
    const gate = createSpeechGate({ speak, stop: vi.fn() });
    const sink = gate.open();
    gate.interrupt();
    sink("first");
    sink("second");
    expect(speak).not.toHaveBeenCalled();
  });

  it("repeated interrupts are safe and each one silences the channel", () => {
    const stop = vi.fn();
    const gate = createSpeechGate({ speak: vi.fn(), stop });
    gate.interrupt();
    gate.interrupt();
    gate.interrupt();
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it("passes per-utterance opts (language) through an open sink to speak", () => {
    const speak = vi.fn();
    const gate = createSpeechGate({ speak, stop: vi.fn() });
    gate.open()("Tiga agen sudah dibuka", { language: "id" });
    expect(speak).toHaveBeenCalledWith("Tiga agen sudah dibuka", { language: "id" });
  });

  it("reads speak/stop lazily on each call — late-bound deps (refs) see the latest impl", () => {
    // The component wires the gate to prop refs; a re-render swaps the underlying callbacks.
    let target = "a";
    const spokenTo: string[] = [];
    const gate = createSpeechGate({
      speak: (text) => spokenTo.push(`${target}:${text}`),
      stop: () => {},
    });
    const sink = gate.open();
    target = "b";
    sink("hello");
    expect(spokenTo).toEqual(["b:hello"]);
  });
});
