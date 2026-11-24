import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerRoute } from "../../services/composer-routing";
import type { CodeVoiceAdapterDeps } from "../../services/code-voice-adapter";

const useSpeechToText = vi.fn();
vi.mock("@/modules/voice-core/use-speech-to-text", () => ({
  useSpeechToText: (...args: unknown[]) => useSpeechToText(...args),
}));
const openSettings = vi.hoisted(() => vi.fn());
const nlComplete = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-api")>()),
  nlComplete: (...args: unknown[]) => nlComplete(...args),
}));
vi.mock("@/modules/lotus-settings/lotus-settings-context", () => ({
  useLotusSettings: () => ({ open: false, openSettings, closeSettings: () => {} }),
}));

import { CODE_VOICE_CLEANUP_FAILED, CODE_VOICE_LIVE_NO_PROVIDER, CODE_VOICE_NO_PROVIDER, useCodeVoice } from "../useCodeVoice";
import { resetVoiceHotkeyStoreForTests, setVoiceHotkeyOverride } from "@/modules/voice-core/voice-hotkeys";
import { resetVoiceAccuracyStoreForTests, setVoiceAccuracySettings } from "@/modules/codecanvas/hooks/useVoiceAccuracySettings";
import { resetVoiceInputStoreForTests, setVoiceInputSetting } from "@/modules/codecanvas/hooks/useVoiceInputSettings";

function fakeStt({ available = true, transcript = "run the tests" } = {}) {
  const stt = {
    available,
    starting: false,
    recording: false,
    transcribing: false,
    interim: "",
    start: vi.fn(async (context?: unknown) => context !== null),
    stop: vi.fn(async () => transcript),
    cancel: vi.fn(),
    getLastTurnMetadata: () => null,
  };
  useSpeechToText.mockReturnValue(stt);
  return stt;
}

function makeDeps(overrides: Partial<CodeVoiceAdapterDeps> = {}) {
  const routes: Record<string, ComposerRoute> = {
    p1: { kind: "terminal", paneId: "p1", runtimeSessionId: "pty-1" },
    p2: { kind: "terminal", paneId: "p2", runtimeSessionId: "pty-2" },
  };
  return {
    focused: () => ({ id: "p1", name: "Rani" }),
    routeFor: (paneId: string | null) => (paneId ? routes[paneId] : undefined) ?? { kind: "blocked", reason: "Pick a pane first." },
    getPanes: () => [
      { id: "p1", name: "Rani", kind: "terminal" as const },
      { id: "p2", name: "Kai", kind: "terminal" as const },
    ],
    sendRightAway: () => false,
    holdInComposer: vi.fn(),
    send: vi.fn(async () => ({ ok: true as const })),
    prompt: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  } satisfies CodeVoiceAdapterDeps;
}

/** Press, then press again to stop: one spoken turn, settled. */
async function speak(result: { current: ReturnType<typeof useCodeVoice> }) {
  await act(async () => result.current.toggle());
  await vi.waitFor(() => expect(result.current.phase).toBe("recording"));
  await act(async () => result.current.toggle());
  await vi.waitFor(() => expect(result.current.phase).toBe("idle"));
}

describe("useCodeVoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("lotus-voice-hotkeys-v1");
    localStorage.removeItem("lotus-voice-accuracy-v1");
    resetVoiceHotkeyStoreForTests();
    resetVoiceAccuracyStoreForTests();
    localStorage.removeItem("lotus-voice-input-v1");
    resetVoiceInputStoreForTests();
  });

  const LONG_TURN = "lotus voice saat ini eh saya ingin optimasi untuk outputnya agar lebih intuitive dan world class";
  const CLEANED_TURN = "Lotus Voice saat ini saya ingin optimasi untuk outputnya agar lebih intuitive dan world class.";

  it("cleans up a turn added to the composer and offers what was said for Undo", async () => {
    fakeStt({ transcript: LONG_TURN });
    setVoiceInputSetting("autoCleanup", true);
    nlComplete.mockResolvedValue("Lotus Voice saat ini saya ingin optimasi untuk outputnya agar lebih intuitive dan world class.");
    const deps = makeDeps({ composerHasText: () => true });
    const { result } = renderHook(() => useCodeVoice({ live: true, deps }));
    await speak(result);
    expect(deps.holdInComposer).toHaveBeenCalledWith(
      "Lotus Voice saat ini saya ingin optimasi untuk outputnya agar lebih intuitive dan world class.",
      LONG_TURN,
    );
    expect(result.current.notice).toBeNull();
  });

  it("tells the agent's Held Prompt the text was cleaned up, with what was said", async () => {
    fakeStt({ transcript: LONG_TURN });
    setVoiceInputSetting("autoCleanup", true);
    nlComplete.mockResolvedValue(CLEANED_TURN);
    const deps = makeDeps();
    const { result } = renderHook(() => useCodeVoice({ live: true, deps }));
    await speak(result);
    expect(deps.prompt).toHaveBeenCalledWith(CLEANED_TURN, expect.objectContaining({ paneId: "p1" }), { id: "p1", name: "Rani" }, LONG_TURN);
    expect(deps.holdInComposer).not.toHaveBeenCalled();
  });

  it("keeps what was said and says so when cleanup fails", async () => {
    fakeStt({ transcript: LONG_TURN });
    setVoiceInputSetting("autoCleanup", true);
    nlComplete.mockRejectedValue(new Error("nl_complete[config]: no key"));
    const deps = makeDeps({ composerHasText: () => true });
    const { result } = renderHook(() => useCodeVoice({ live: true, deps }));
    await speak(result);
    expect(deps.holdInComposer).toHaveBeenCalledWith(LONG_TURN);
    expect(result.current.notice).toBe(CODE_VOICE_CLEANUP_FAILED);
  });

  it("never calls the model when automatic cleanup is off", async () => {
    fakeStt({ transcript: LONG_TURN });
    const deps = makeDeps({ composerHasText: () => true });
    const { result } = renderHook(() => useCodeVoice({ live: true, deps }));
    await speak(result);
    expect(nlComplete).not.toHaveBeenCalled();
    expect(deps.holdInComposer).toHaveBeenCalledWith(LONG_TURN);
  });

  it("gives the speech model the user's terms, Lotus's names and the pane names", async () => {
    const stt = fakeStt();
    setVoiceAccuracySettings({ personalTerms: ["Flow Trader"], expectedLanguages: ["id"], replacements: [] });
    const { result } = renderHook(() => useCodeVoice({ live: true, deps: makeDeps() }));
    await speak(result);
    const context = stt.start.mock.calls[0]?.[0] as { keywords: string[]; languages: string[] };
    expect(context.keywords).toEqual(expect.arrayContaining(["Flow Trader", "Lotus", "Lotus Voice", "Rani"]));
    expect(context.languages).toEqual(["id"]);
  });

  it("applies the user's replacement rules before the text reaches the composer", async () => {
    fakeStt({ transcript: "di ratus voice saat ini" });
    setVoiceAccuracySettings({
      personalTerms: [],
      expectedLanguages: [],
      replacements: [{ id: "r1", variants: ["di ratus"], replacement: "Lotus", timing: "before-ai", enabled: true }],
    });
    const deps = makeDeps({ composerHasText: () => true });
    const { result } = renderHook(() => useCodeVoice({ live: true, deps }));
    await speak(result);
    expect(deps.holdInComposer).toHaveBeenCalledWith("Lotus voice saat ini");
  });

  it("puts what was said, unsent, in the focused agent's prompt", async () => {
    const stt = fakeStt();
    const deps = makeDeps();
    const { result } = renderHook(() => useCodeVoice({ live: true, deps }));
    await speak(result);
    expect(stt.start).toHaveBeenCalledOnce();
    expect(deps.prompt).toHaveBeenCalledWith("run the tests", expect.objectContaining({ paneId: "p1" }), { id: "p1", name: "Rani" });
    expect(deps.holdInComposer).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(result.current.notice).toBeNull();
  });

  it("sends to the focused pane when send right away is on", async () => {
    fakeStt();
    const deps = makeDeps({ sendRightAway: () => true });
    const { result } = renderHook(() => useCodeVoice({ live: true, deps }));
    await speak(result);
    expect(deps.send).toHaveBeenCalledWith("run the tests", { kind: "terminal", paneId: "p1", runtimeSessionId: "pty-1" });
    expect(deps.holdInComposer).not.toHaveBeenCalled();
  });

  it("keeps the text and says why when the focused pane cannot take it", async () => {
    fakeStt();
    const deps = makeDeps({ routeFor: () => ({ kind: "blocked", reason: "This pane does not take text." }) });
    const { result } = renderHook(() => useCodeVoice({ live: true, deps }));
    await speak(result);
    expect(deps.holdInComposer).toHaveBeenCalledWith("run the tests");
    expect(result.current.notice).toBe("This pane does not take text.");
  });

  it("keeps a turn for the pane focused when the mic opened, if focus moved before it ended", async () => {
    fakeStt();
    let focused = { id: "p1", name: "Rani" };
    const deps = makeDeps({ sendRightAway: () => true, focused: () => focused });
    const { result } = renderHook(() => useCodeVoice({ live: true, deps }));
    await act(async () => result.current.toggle());
    await vi.waitFor(() => expect(result.current.phase).toBe("recording"));
    focused = { id: "p2", name: "Kai" };
    await act(async () => result.current.toggle());
    await vi.waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.holdInComposer).toHaveBeenCalledWith("run the tests", undefined, { id: "p1", name: "Rani" });
    expect(result.current.notice).toBe("Spoken for Rani — you moved to Kai. Kept here; Enter sends to Rani.");
  });

  it("sends a turn ended with ⌘Enter right away", async () => {
    fakeStt();
    const deps = makeDeps();
    const { result } = renderHook(() => useCodeVoice({ live: true, deps }));
    await act(async () => result.current.toggle());
    await vi.waitFor(() => expect(result.current.phase).toBe("recording"));
    await act(async () => result.current.toggle({ sendNow: true }));
    await vi.waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(deps.send).toHaveBeenCalledWith("run the tests", { kind: "terminal", paneId: "p1", runtimeSessionId: "pty-1" });
  });

  it("finishes and sends the turn on ⌘Enter while listening", async () => {
    fakeStt();
    const deps = makeDeps();
    const { result } = renderHook(() => useCodeVoice({ live: true, deps }));
    await act(async () => result.current.toggle());
    await vi.waitFor(() => expect(result.current.phase).toBe("recording"));
    const event = new KeyboardEvent("keydown", { key: "Enter", metaKey: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(deps.send).toHaveBeenCalledWith("run the tests", { kind: "terminal", paneId: "p1", runtimeSessionId: "pty-1" });
  });

  it("knows a turn started by holding the key, and a tapped one", async () => {
    fakeStt();
    const { result } = renderHook(() => useCodeVoice({ live: true, deps: makeDeps() }));
    const down = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "\u00a0", code: "Space", altKey: true, shiftKey: true, cancelable: true }));
    const up = () => window.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", cancelable: true }));
    await act(async () => down());
    await vi.waitFor(() => expect(result.current.phase).toBe("recording"));
    expect(result.current.held).toBe(true);
    await act(async () => up());
    expect(result.current.held).toBe(false);
  });

  it("says whether a voice provider is set", () => {
    fakeStt({ available: false });
    const { result } = renderHook(() => useCodeVoice({ live: true, deps: makeDeps() }));
    expect(result.current.available).toBe(false);
  });

  function fakeLive(over: Partial<{ available: boolean; active: boolean }> = {}) {
    return { available: true, active: false, start: vi.fn(async () => {}), stop: vi.fn(), ...over };
  }

  it("starts Live Voice from its button, and ends it from the same button", () => {
    fakeStt();
    const liveVoice = fakeLive();
    const { result, rerender } = renderHook(({ active }) => useCodeVoice({ live: true, deps: makeDeps(), liveVoice: { ...liveVoice, active } }), {
      initialProps: { active: false },
    });
    expect(result.current.liveHotkeyLabel).toMatch(/L$/);
    act(() => result.current.startLiveVoice());
    expect(liveVoice.start).toHaveBeenCalledTimes(1);
    rerender({ active: true });
    act(() => result.current.startLiveVoice());
    expect(liveVoice.stop).toHaveBeenCalledTimes(1);
  });

  it("sends Live Voice without a provider to Lotus Settings", () => {
    fakeStt();
    const liveVoice = fakeLive({ available: false });
    const { result } = renderHook(() => useCodeVoice({ live: true, deps: makeDeps(), liveVoice }));
    act(() => result.current.startLiveVoice());
    expect(liveVoice.start).not.toHaveBeenCalled();
    expect(result.current.notice).toBe(CODE_VOICE_LIVE_NO_PROVIDER);
    expect(openSettings).toHaveBeenCalledWith({ from: "dictate" });
  });

  it("ends Live Voice when the mic opens for Push-to-Talk", async () => {
    fakeStt();
    const liveVoice = fakeLive({ active: true });
    const { result } = renderHook(() => useCodeVoice({ live: true, deps: makeDeps(), liveVoice }));
    await act(async () => result.current.toggle());
    await vi.waitFor(() => expect(result.current.phase).toBe("recording"));
    expect(liveVoice.stop).toHaveBeenCalled();
  });

  it("opens Lotus Settings on Voice when there is no voice provider", async () => {
    const stt = fakeStt({ available: false });
    const { result } = renderHook(() => useCodeVoice({ live: true, deps: makeDeps() }));
    await act(async () => result.current.toggle());
    await vi.waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(stt.start).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledWith({ from: "dictate" });
    expect(result.current.notice).toBe(CODE_VOICE_NO_PROVIDER);
  });

  it("cancels a recording on Escape without delivering it", async () => {
    const stt = fakeStt();
    const deps = makeDeps();
    const { result } = renderHook(() => useCodeVoice({ live: true, deps }));
    await act(async () => result.current.toggle());
    await vi.waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.phase).toBe("idle");
    expect(stt.cancel).toHaveBeenCalled();
    expect(deps.holdInComposer).not.toHaveBeenCalled();
  });

  it("starts from the app Push-to-Talk key only while Code is the mode on screen", async () => {
    const stt = fakeStt();
    setVoiceHotkeyOverride("push-to-talk", "f5");
    const deps = makeDeps();
    const { rerender } = renderHook(({ live }) => useCodeVoice({ live, deps }), { initialProps: { live: false } });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", cancelable: true }));
    });
    expect(stt.start).not.toHaveBeenCalled();
    rerender({ live: true });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", cancelable: true }));
    });
    await vi.waitFor(() => expect(stt.start).toHaveBeenCalledOnce());
  });

  it("takes the Live Voice key while Code hears the keyboard", () => {
    fakeStt();
    const liveVoice = fakeLive();
    const { rerender } = renderHook(({ live }) => useCodeVoice({ live, deps: makeDeps(), liveVoice }), { initialProps: { live: true } });
    const press = () => {
      const event = new KeyboardEvent("keydown", { key: "l", metaKey: true, shiftKey: true, cancelable: true });
      act(() => {
        window.dispatchEvent(event);
      });
      return event;
    };
    expect(press().defaultPrevented).toBe(true);
    expect(liveVoice.start).toHaveBeenCalledTimes(1);
    // Another mode on screen: the key reaches the page (Monaco's ⌘⇧L) and Code does nothing.
    rerender({ live: false });
    expect(press().defaultPrevented).toBe(false);
    expect(liveVoice.start).toHaveBeenCalledTimes(1);
  });
});
