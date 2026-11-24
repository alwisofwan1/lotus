import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserSttProvider } from "../browser-stt-provider";

/** Minimal fake of the Web Speech `SpeechRecognition` engine we can drive from tests. */
class FakeRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  aborted = false;
  stopped = false;
  start() {
    this.started = true;
  }
  /** Deliberately does NOT auto-fire onend — tests decide whether the engine ever ends. */
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
  emitFinal(text: string) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] });
  }
  emitEnd() {
    this.onend?.();
  }
  emitError(code: string) {
    this.onerror?.({ error: code });
  }
}

let inst: FakeRecognition;
beforeEach(() => {
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = function () {
    inst = new FakeRecognition();
    return inst;
  };
});
afterEach(() => {
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  vi.useRealTimers();
});

describe("createBrowserSttProvider", () => {
  it("resolves stop() with the final transcript when the engine ends normally", async () => {
    const p = createBrowserSttProvider();
    await p.start();
    inst.emitFinal("hello world");
    const stopping = p.stop();
    inst.emitEnd();
    expect(await stopping).toBe("hello world");
  });

  it("preserves a final transcript when the browser engine ends before the user clicks Stop", async () => {
    const p = createBrowserSttProvider();
    await p.start();
    inst.emitFinal("buka terminal baru");
    inst.emitEnd();

    await expect(p.stop()).resolves.toBe("buka terminal baru");
  });

  it("ignores a cancelled engine's late end after a newer capture starts", async () => {
    const p = createBrowserSttProvider();
    await p.start();
    const oldRecognition = inst;
    const oldStop = p.stop();
    p.cancel();
    await p.start();
    const newRecognition = inst;

    oldRecognition.emitEnd();
    newRecognition.emitFinal("new transcript");
    const newStop = p.stop();
    newRecognition.emitEnd();

    await expect(oldStop).resolves.toBe("");
    await expect(newStop).resolves.toBe("new transcript");
  });

  it("never hangs: stop() force-resolves and aborts when onend never fires (watchdog)", async () => {
    vi.useFakeTimers();
    const p = createBrowserSttProvider();
    await p.start();
    inst.emitFinal("partial only");
    const stopping = p.stop();
    // The engine goes silent — no onend, no onerror.
    vi.advanceTimersByTime(1200);
    expect(await stopping).toBe("partial only");
    expect(inst.aborted).toBe(true);
  });

  it("surfaces a clear message and resolves a pending stop on recognition error", async () => {
    const onError = vi.fn();
    const p = createBrowserSttProvider("browser", { onError });
    await p.start();
    const stopping = p.stop();
    inst.emitError("service-not-allowed");
    expect(await stopping).toBe("");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Settings → Voice"));
  });

  it("reports a mid-recording error (no pending stop) without leaving the engine running", async () => {
    const onError = vi.fn();
    const p = createBrowserSttProvider("browser", { onError });
    await p.start();
    inst.emitError("network");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("unreachable"));
    // A subsequent stop() is a no-op (engine already torn down), not a hang.
    expect(await p.stop()).toBe("");
  });

  it("treats a benign no-speech error as silent (no message)", async () => {
    const onError = vi.fn();
    const p = createBrowserSttProvider("browser", { onError });
    await p.start();
    inst.emitError("no-speech");
    expect(onError).not.toHaveBeenCalled();
  });
});
