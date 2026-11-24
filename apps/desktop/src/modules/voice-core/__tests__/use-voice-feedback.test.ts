import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { useVoiceFeedback } from "../use-voice-feedback";

// Registry double — the hook's one external dependency. Tests swap `value` per scenario.
const reg = vi.hoisted(() => ({
  value: {
    activeProvider: "browser",
    providers: [
      { id: "browser", name: "Browser", kind: "browser", builtin: true, enabled: true, voice: "Damayanti", speed: 1.2 },
    ],
    output: { speakReplies: true, agentDoneCallouts: true, wakeOnFinish: false },
  } as unknown,
}));
const ttsSynthesize = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hooks/useTtsProviderRegistry", () => ({
  useTtsProviderRegistry: () => ({ registry: reg.value }),
}));
vi.mock("@/lib/tauri-api", () => ({ ttsSynthesize }));

/** Web Speech stub scoped to the real jsdom window (renderHook needs jsdom intact). */
function stubSpeech(voices: Array<{ name: string; lang: string; localService?: boolean }> = []) {
  let last: { text: string; rate: number; lang: string; voice: unknown; onend?: () => void } | null = null;
  const synth = {
    speak: vi.fn((u) => {
      last = u;
      u.onend?.();
    }),
    cancel: vi.fn(),
    getVoices: () => voices,
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  class Utterance {
    text: string;
    rate = 1;
    lang = "";
    voice: unknown = null;
    onend?: () => void;
    constructor(text: string) { this.text = text; }
  }
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance as unknown);
  return { synth, lastUtterance: () => last };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useVoiceFeedback — settings actually reach the spoken utterance", () => {
  it("passes the active provider's configured voice + speed AND the caller's language to speak()", () => {
    const damayanti = { name: "Damayanti", lang: "id-ID", localService: true };
    const { lastUtterance } = stubSpeech([damayanti]);
    const { result } = renderHook(() => useVoiceFeedback());
    result.current.speak("Tiga agen sudah dibuka", { language: "id" });
    const u = lastUtterance();
    expect(u?.lang).toBe("id");
    expect(u?.rate).toBeCloseTo(1.2);
    expect(u?.voice).toBe(damayanti); // configured voice name resolved against the voice list
  });

  it("announce() carries the language too (agent-done callouts speak the user's language)", () => {
    const { lastUtterance } = stubSpeech();
    const { result } = renderHook(() => useVoiceFeedback());
    result.current.announce("Rowan selesai.", { language: "id-ID" });
    expect(lastUtterance()?.lang).toBe("id-ID");
  });

  it("still speaks with no opts and no per-provider config (zero-config default path)", () => {
    reg.value = {
      activeProvider: "browser",
      providers: [{ id: "browser", name: "Browser", kind: "browser", builtin: true, enabled: true }],
      output: { speakReplies: true, agentDoneCallouts: true, wakeOnFinish: false },
    };
    const { lastUtterance } = stubSpeech();
    const { result } = renderHook(() => useVoiceFeedback());
    result.current.speak("hello");
    expect(lastUtterance()?.text).toBe("hello");
    expect(lastUtterance()?.lang).toBe("");
  });

  it("forwards cloud speech ownership so stop cancels native synthesis", async () => {
    reg.value = {
      activeProvider: "openai",
      providers: [{ id: "openai", name: "OpenAI", kind: "openai", builtin: true, enabled: true }],
      output: { speakReplies: true, agentDoneCallouts: true, wakeOnFinish: false },
    };
    ttsSynthesize.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useVoiceFeedback());

    void result.current.announce("Agent selesai.");
    await waitFor(() => expect(ttsSynthesize).toHaveBeenCalledOnce());
    const signal = ttsSynthesize.mock.calls[0][2]?.signal as AbortSignal | undefined;
    result.current.stop();

    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
  });

  it("stops the old provider when settings replace it", async () => {
    reg.value = {
      activeProvider: "openai",
      providers: [{ id: "openai", name: "OpenAI", kind: "openai", builtin: true, enabled: true }],
      output: { speakReplies: true, agentDoneCallouts: true, wakeOnFinish: false },
    };
    ttsSynthesize.mockImplementation(() => new Promise(() => {}));
    const { result, rerender } = renderHook(() => useVoiceFeedback());
    void result.current.announce("Agent selesai.");
    await waitFor(() => expect(ttsSynthesize).toHaveBeenCalled());
    const signal = ttsSynthesize.mock.calls.at(-1)?.[2]?.signal as AbortSignal | undefined;

    reg.value = {
      activeProvider: "browser",
      providers: [{ id: "browser", name: "Browser", kind: "browser", builtin: true, enabled: true }],
      output: { speakReplies: true, agentDoneCallouts: true, wakeOnFinish: false },
    };
    rerender();

    expect(signal?.aborted).toBe(true);
  });
});
