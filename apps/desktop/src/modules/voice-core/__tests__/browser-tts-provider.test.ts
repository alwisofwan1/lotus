import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserTtsProvider } from "../browser-tts-provider";

/**
 * Minimal Web Speech stub: `speak` captures the utterance so a test can drive its `onend` / `onerror`
 * lifecycle by hand, mirroring how the browser fires them.
 */
interface StubUtterance {
  text: string;
  rate: number;
  lang: string;
  voice: unknown;
  onend?: (() => void) | null;
  onerror?: ((e: { error: string }) => void) | null;
}

function stubSpeechSynthesis(voices: Array<{ name: string; lang: string; voiceURI?: string; localService?: boolean }> = []) {
  let last: StubUtterance | null = null;
  const utterances: StubUtterance[] = [];
  const synth = { speak: vi.fn((u) => { last = u; utterances.push(u); }), cancel: vi.fn(), getVoices: () => voices };
  // SpeechSynthesisUtterance stand-in — records the props the provider sets.
  class Utterance {
    text: string;
    rate = 1;
    lang = "";
    voice: unknown = null;
    onend?: (() => void) | null;
    onerror?: ((e: { error: string }) => void) | null;
    constructor(text: string) { this.text = text; }
  }
  vi.stubGlobal("window", { speechSynthesis: synth });
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance as unknown);
  return {
    synth,
    utterances,
    lastUtterance: () => last,
    fire: (evt: "onend" | "onerror", e?: { error: string }) => (evt === "onerror" ? last?.onerror?.(e!) : last?.onend?.()),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createBrowserTtsProvider", () => {
  it("settles the active promise on stop even when WebKit emits no lifecycle callback", async () => {
    const { utterances } = stubSpeechSynthesis();
    const provider = createBrowserTtsProvider();
    const spoken = provider.speak("hello");
    let settled = false;
    void spoken.finally(() => { settled = true; });

    provider.stop();
    await Promise.resolve();

    expect(settled).toBe(true);
    expect(utterances[0].onend).toBeNull();
    expect(utterances[0].onerror).toBeNull();
  });

  it("settles the replaced promise even when WebKit emits no lifecycle callback", async () => {
    const { utterances } = stubSpeechSynthesis();
    const provider = createBrowserTtsProvider();
    const replaced = provider.speak("first");
    let replacedSettled = false;
    void replaced.finally(() => { replacedSettled = true; });

    const current = provider.speak("second");
    await Promise.resolve();

    expect(replacedSettled).toBe(true);
    expect(utterances[0].onend).toBeNull();
    expect(utterances[0].onerror).toBeNull();
    utterances[1].onend?.();
    await expect(current).resolves.toBeUndefined();
  });

  it("rejects through an injectable watchdog when WebKit emits no lifecycle callback", async () => {
    vi.useFakeTimers();
    const { synth, utterances } = stubSpeechSynthesis();
    const provider = createBrowserTtsProvider("browser", { watchdogMs: 25 });
    const spoken = provider.speak("hello");
    let rejection: unknown;
    void spoken.catch((error) => { rejection = error; });

    await vi.advanceTimersByTimeAsync(25);

    expect(rejection).toEqual(new Error("Browser speech synthesis timed out."));
    expect(utterances[0].onend).toBeNull();
    expect(utterances[0].onerror).toBeNull();
    expect(synth.cancel).toHaveBeenCalledTimes(2);
  });

  it("does not start speech when the caller signal is already aborted", async () => {
    const { synth } = stubSpeechSynthesis();
    const controller = new AbortController();
    controller.abort();

    await expect(
      createBrowserTtsProvider().speak("stale announcement", { signal: controller.signal }),
    ).resolves.toBeUndefined();

    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("resolves (no error) when the utterance is canceled or interrupted — an intentional replacement", async () => {
    for (const code of ["canceled", "interrupted"]) {
      const { fire } = stubSpeechSynthesis();
      const p = createBrowserTtsProvider().speak("hello");
      fire("onerror", { error: code });
      await expect(p).resolves.toBeUndefined();
    }
  });

  it("rejects on a genuine synthesis failure", async () => {
    const { fire } = stubSpeechSynthesis();
    const p = createBrowserTtsProvider().speak("hello");
    fire("onerror", { error: "synthesis-failed" });
    await expect(p).rejects.toThrow(/Speech failed: synthesis-failed/);
  });

  it("sets utterance.lang from the caller's language so the engine picks a matching voice", async () => {
    // Without a lang, WebSpeech uses the page-default (English) voice — Indonesian text read with
    // English phonemes is the "robotic" bug. The language must reach the utterance.
    const { lastUtterance, fire } = stubSpeechSynthesis();
    const p = createBrowserTtsProvider().speak("Tiga agen sudah dibuka", { language: "id" });
    expect(lastUtterance()?.lang).toBe("id");
    fire("onend");
    await p;
  });

  it("picks a voice matching the language when none is configured (Damayanti for id, not Samantha)", async () => {
    const damayanti = { name: "Damayanti", lang: "id-ID", localService: true };
    const { lastUtterance, fire } = stubSpeechSynthesis([
      { name: "Samantha", lang: "en-US", localService: true },
      damayanti,
    ]);
    const p = createBrowserTtsProvider().speak("Tiga agen sudah dibuka", { language: "id" });
    expect(lastUtterance()?.voice).toBe(damayanti);
    fire("onend");
    await p;
  });

  it("an explicitly configured voice wins over language matching", async () => {
    const samantha = { name: "Samantha", lang: "en-US" };
    const { lastUtterance, fire } = stubSpeechSynthesis([samantha, { name: "Damayanti", lang: "id-ID" }]);
    const p = createBrowserTtsProvider().speak("halo", { language: "id", voice: "Samantha" });
    expect(lastUtterance()?.voice).toBe(samantha);
    fire("onend");
    await p;
  });

  it("leaves the voice unset (engine default for lang) when no voice matches the language", async () => {
    const { lastUtterance, fire } = stubSpeechSynthesis([{ name: "Samantha", lang: "en-US" }]);
    const p = createBrowserTtsProvider().speak("こんにちは", { language: "ja" });
    expect(lastUtterance()?.voice).toBeNull();
    expect(lastUtterance()?.lang).toBe("ja");
    fire("onend");
    await p;
  });

  it("cancels any in-flight utterance before speaking the new one", async () => {
    const { synth, fire } = stubSpeechSynthesis();
    const p = createBrowserTtsProvider().speak("hello");
    expect(synth.cancel).toHaveBeenCalled();
    expect(synth.speak).toHaveBeenCalled();
    fire("onend");
    await expect(p).resolves.toBeUndefined();
  });
});
