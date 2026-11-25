import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const useSpeechToText = vi.fn();
const accuracyState = vi.hoisted(() => ({ replacements: [] as unknown[] }));
vi.mock("@/modules/voice-core/use-speech-to-text", () => ({
  useSpeechToText: (...args: unknown[]) => useSpeechToText(...args),
}));

const openSettings = vi.hoisted(() => vi.fn());
vi.mock("@/modules/lotus-settings/lotus-settings-context", () => ({
  useLotusSettings: () => ({ open: false, openSettings, closeSettings: () => {} }),
}));

vi.mock("../../agent-status-registry", () => ({
  agentStatusRegistry: { list: () => [], subscribe: () => () => {} },
}));
vi.mock("../../../hooks/useVoiceAccuracySettings", () => ({
  getVoiceAccuracySettings: () => ({
    personalTerms: [],
    expectedLanguages: [],
    replacements: accuracyState.replacements,
  }),
}));

import { useCanvasTurnVoiceController } from "../use-canvas-turn-voice-controller";
import { clearVoiceTurnDiagnostics, getVoiceTurnDiagnostics } from "../voice-turn-diagnostics";
import { resetVoiceInputStoreForTests, setVoiceInputSetting } from "../../../hooks/useVoiceInputSettings";
import {
  resetCanvasHotkeyStoreForTests,
  setCanvasHotkeyOverride,
} from "../../../hooks/useCanvasHotkeySettings";
import type { SpeechGate } from "@/modules/voice-core/speech-gate";
import { resetVoiceHotkeyStoreForTests, setVoiceHotkeyOverride } from "@/modules/voice-core/voice-hotkeys";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function baseOptions(overrides: Partial<Parameters<typeof useCanvasTurnVoiceController>[0]> = {}) {
  return {
    nodes: [],
    busy: false,
    live: {
      available: false,
      active: false,
      phase: "idle",
      turn: 0,
      providerName: null,
      agentSpeaking: false,
      health: { socket: "idle", mic: "idle", playback: "idle", tools: "idle", audioDeltas: 0 },
      start: vi.fn(),
      stop: vi.fn(),
      interrupt: vi.fn(),
      micMuted: false,
      setMicMuted: vi.fn(),
    },
    speechGate: { interrupt: vi.fn(), open: vi.fn(() => vi.fn()) } as unknown as SpeechGate,
    setTrace: vi.fn(),
    text: "",
    setText: vi.fn(),
    focusInput: vi.fn(),
    hasCommandVerb: vi.fn(() => true),
    submitQuery: vi.fn(),
    dispatchDictation: vi.fn(async (_agentId: string, _agentName: string, text: string) => ({
      text,
      delivery: "written" as const,
    })),
    runTransform: vi.fn(),
    getDecoderContext: vi.fn(() => ({ prompt: "", keywords: [], languages: [] })),
    onSpectrum: vi.fn(),
    ...overrides,
  } satisfies Parameters<typeof useCanvasTurnVoiceController>[0];
}

/** The Push-to-Talk session owns the capture: open the mic first, as a user does, so the test's
 *  `beginVoice` stops a capture the session actually started. The STT mocks below report
 *  `recording: true` throughout; that alone no longer counts as an open capture. */
/** What the bar holds after the latest `setText`, whether it was given a value or an update. */
function barText(setText: unknown, before = ""): string {
  const update = (setText as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string | ((current: string) => string) | undefined;
  return typeof update === "function" ? update(before) : (update ?? before);
}

async function openMic(result: { current: ReturnType<typeof useCanvasTurnVoiceController> }) {
  (result.current.stt.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
  await act(async () => {
    await result.current.beginVoice();
  });
}

describe("useCanvasTurnVoiceController — push-to-talk latency feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accuracyState.replacements = [];
    localStorage.removeItem("lotus-voice-input-v1");
    localStorage.removeItem("canvas-hotkeys-v1");
    resetVoiceInputStoreForTests();
    resetCanvasHotkeyStoreForTests();
    localStorage.removeItem("lotus-voice-hotkeys-v1");
    resetVoiceHotkeyStoreForTests();
    clearVoiceTurnDiagnostics();
  });

  it("starts Push-to-Talk from the app-level key the user picked", async () => {
    const start = vi.fn(async () => true);
    useSpeechToText.mockReturnValue({
      available: true,
      recording: false,
      transcribing: false,
      interim: "",
      start,
      stop: vi.fn(async () => ""),
      cancel: vi.fn(),
    });
    setVoiceHotkeyOverride("push-to-talk", "f5");
    const opts = baseOptions({
      getDecoderContext: vi.fn((mode) => ({ prompt: `hint:${mode}`, keywords: [], languages: [] })),
    });
    renderHook(() => useCanvasTurnVoiceController(opts));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", cancelable: true }));
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith({ prompt: "hint:auto", keywords: [], languages: [] }));
  });

  it("starts Live Voice from a remapped app-level key", () => {
    const liveStart = vi.fn(async () => {});
    setVoiceHotkeyOverride("live-voice", "mod+alt+l");
    const opts = baseOptions({ live: { ...baseOptions().live, available: true, start: liveStart } });
    renderHook(() => useCanvasTurnVoiceController(opts));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", metaKey: true, shiftKey: true }));
    });
    expect(liveStart).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", metaKey: true, altKey: true }));
    });
    expect(liveStart).toHaveBeenCalledOnce();
  });

  it("says why when the Live Voice key is pressed with no Live Voice provider", () => {
    const opts = baseOptions({ live: { ...baseOptions().live, available: false } });
    renderHook(() => useCanvasTurnVoiceController(opts));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", metaKey: true, shiftKey: true }));
    });
    expect(opts.setTrace).toHaveBeenCalledWith({
      text: "Live Voice needs a provider — enable one in Settings → Voice.",
      tone: "error",
    });
    expect(openSettings).toHaveBeenCalledWith({ from: "dictate" });
  });

  it("opens Lotus Settings on Voice when Dictate is pressed with no voice provider", async () => {
    const start = vi.fn(async () => true);
    useSpeechToText.mockReturnValue({
      available: false,
      recording: false,
      transcribing: false,
      interim: "",
      start,
      stop: vi.fn(async () => ""),
      cancel: vi.fn(),
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await act(async () => {
      await result.current.beginVoice("dictate");
    });
    expect(start).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledWith({ from: "dictate" });
  });

  it("does not open Lotus Settings when a voice provider is set up", async () => {
    useSpeechToText.mockReturnValue({
      available: true,
      recording: false,
      transcribing: false,
      interim: "",
      start: vi.fn(async () => true),
      stop: vi.fn(async () => ""),
      cancel: vi.fn(),
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await act(async () => {
      await result.current.beginVoice("dictate");
    });
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("starts explicit Dictate from the user's custom hotkey and frees the old default", async () => {
    const start = vi.fn(async () => true);
    useSpeechToText.mockReturnValue({
      available: true,
      recording: false,
      transcribing: false,
      interim: "",
      start,
      stop: vi.fn(async () => ""),
      cancel: vi.fn(),
    });
    setCanvasHotkeyOverride("voice-dictate", "x");
    const opts = baseOptions({
      getDecoderContext: vi.fn((mode) => ({ prompt: `hint:${mode}`, keywords: [], languages: [] })),
    });
    renderHook(() => useCanvasTurnVoiceController(opts));

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: true, shiftKey: true }));
    });
    expect(start).not.toHaveBeenCalled();
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith({ prompt: "hint:dictate", keywords: [], languages: [] }));
    input.remove();
  });

  it("snapshots a neutral Auto decoder hint before capture instead of command-biasing free speech", async () => {
    const start = vi.fn(async () => true);
    useSpeechToText.mockReturnValue({
      available: true,
      recording: false,
      transcribing: false,
      interim: "",
      start,
      stop: vi.fn(async () => ""),
      cancel: vi.fn(),
    });
    const opts = baseOptions({
      getDecoderContext: vi.fn((mode) => ({ prompt: `hint:${mode}`, keywords: [], languages: [] })),
    });
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));

    await act(async () => {
      await result.current.beginVoice();
    });

    expect(opts.getDecoderContext).toHaveBeenCalledWith("auto");
    expect(start).toHaveBeenCalledWith({ prompt: "hint:auto", keywords: [], languages: [] });
  });

  it("uses command-biased decoder context only for an explicit Command capture", async () => {
    const start = vi.fn(async () => true);
    useSpeechToText.mockReturnValue({
      available: true,
      recording: false,
      transcribing: false,
      interim: "",
      start,
      stop: vi.fn(async () => ""),
      cancel: vi.fn(),
    });
    const opts = baseOptions({
      getDecoderContext: vi.fn((mode) => ({ prompt: `hint:${mode}`, keywords: [], languages: [] })),
    });
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));

    await act(async () => {
      await result.current.beginVoice("command");
    });

    expect(opts.getDecoderContext).toHaveBeenCalledWith("command");
    expect(start).toHaveBeenCalledWith({ prompt: "hint:command", keywords: [], languages: [] });
  });

  it("treats explicit Command as a one-turn capture instead of a hidden sticky mode", async () => {
    const start = vi.fn(async () => true);
    const stop = vi.fn(async () => "fix the authentication bug now");
    useSpeechToText
      .mockReturnValueOnce({
        available: true,
        recording: false,
        transcribing: false,
        interim: "",
        start,
        stop,
        cancel: vi.fn(),
      })
      .mockReturnValue({
        available: true,
        recording: true,
        transcribing: false,
        interim: "",
        start,
        stop,
        cancel: vi.fn(),
      });
    const opts = baseOptions({
      nodes: [{ id: "a1", type: "agent", selected: true, data: { name: "Rowan" }, position: { x: 0, y: 0 } } as never],
      hasCommandVerb: vi.fn(() => false),
    });
    const { result, rerender } = renderHook(() => useCanvasTurnVoiceController(opts));

    await act(async () => {
      await result.current.beginVoice("command");
    });
    rerender();
    await act(async () => {
      await result.current.beginVoice();
    });

    expect(opts.submitQuery).toHaveBeenCalledWith("fix the authentication bug now", { input: "voice", signal: expect.any(AbortSignal) });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit Dictate text for review when no coding agent is focused", async () => {
    const start = vi.fn(async () => true);
    const stop = vi.fn(async () => "tolong perbaiki bug login tanpa mengubah API publik");
    useSpeechToText
      .mockReturnValueOnce({
        available: true,
        recording: false,
        transcribing: false,
        interim: "",
        start,
        stop,
        cancel: vi.fn(),
      })
      .mockReturnValue({
        available: true,
        recording: true,
        transcribing: false,
        interim: "",
        start,
        stop,
        cancel: vi.fn(),
      });
    const opts = baseOptions({ hasCommandVerb: vi.fn(() => true) });
    const { result, rerender } = renderHook(() => useCanvasTurnVoiceController(opts));

    await act(async () => {
      await result.current.beginVoice("dictate");
    });
    rerender();
    await act(async () => {
      await result.current.beginVoice();
    });

    expect(opts.submitQuery).not.toHaveBeenCalled();
    expect(opts.setText).toHaveBeenCalledWith("tolong perbaiki bug login tanpa mengubah API publik");
    expect(opts.focusInput).toHaveBeenCalled();
    expect(opts.setTrace).toHaveBeenCalledWith({
      text: "Select a coding agent to receive this dictation — text kept for review.",
      tone: "error",
    });
  });

  it("routes against the focused target captured at mic start, not a later selection", async () => {
    const start = vi.fn(async () => true);
    const stop = vi.fn(async () => "review the authentication flow carefully");
    useSpeechToText
      .mockReturnValueOnce({
        available: true,
        recording: false,
        transcribing: false,
        interim: "",
        start,
        stop,
        cancel: vi.fn(),
      })
      .mockReturnValue({
        available: true,
        recording: true,
        transcribing: false,
        interim: "",
        start,
        stop,
        cancel: vi.fn(),
      });
    const originalNodes = [{ id: "a1", type: "agent", selected: true, data: { name: "Rowan" }, position: { x: 0, y: 0 } } as never];
    const laterNodes: never[] = [];
    const opts = baseOptions({
      nodes: originalNodes,
      hasCommandVerb: vi.fn(() => false),
      dispatchDictation: vi.fn(async (_agentId: string, _agentName: string, text: string) => ({
        text,
        delivery: "written" as const,
      })),
    });
    const { result, rerender } = renderHook(
      ({ nodes }) => useCanvasTurnVoiceController({ ...opts, nodes }),
      { initialProps: { nodes: originalNodes } },
    );

    await act(async () => {
      await result.current.beginVoice();
    });
    rerender({ nodes: laterNodes });
    await act(async () => {
      await result.current.beginVoice();
    });

    // Rowan left the board while it was spoken: the turn waits in the bar for Rowan, it is not re-routed.
    expect(barText(opts.setText)).toBe("review the authentication flow carefully");
    expect(opts.setTrace).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Spoken for Rowan"),
    }));
    expect(opts.submitQuery).not.toHaveBeenCalled();
    expect(opts.dispatchDictation).not.toHaveBeenCalled();
  });

  describe("a Held Prompt", () => {
    async function dictateToRowan(overrides: Partial<Parameters<typeof useCanvasTurnVoiceController>[0]> = {}) {
      useSpeechToText.mockReturnValue({
        available: true,
        recording: true,
        transcribing: false,
        interim: "",
        start: vi.fn(),
        stop: vi.fn(async () => "review the authentication flow carefully"),
        cancel: vi.fn(),
      });
      const opts = baseOptions({
        nodes: [{ id: "a1", type: "agent", selected: true, data: { name: "Rowan" }, position: { x: 0, y: 0 } } as never],
        hasCommandVerb: vi.fn(() => false),
        writeAgentPrompt: vi.fn(() => true),
        ...overrides,
      });
      const hook = renderHook(() => useCanvasTurnVoiceController(opts));
      await openMic(hook.result);
      await act(async () => {
        await hook.result.current.beginVoice();
      });
      return { ...hook, opts };
    }

    it("waits, unsent, in the agent's prompt, and the bar knows for whom", async () => {
      const { result, opts } = await dictateToRowan();
      expect(opts.writeAgentPrompt).toHaveBeenCalledWith("a1", "review the authentication flow carefully");
      expect(opts.dispatchDictation).not.toHaveBeenCalled();
      expect(result.current.heldPrompt).toMatchObject({ agentId: "a1", name: "Rowan" });
    });

    it("is sent with a lone Enter in the agent's prompt", async () => {
      const { result, opts } = await dictateToRowan();
      act(() => void result.current.sendHeldPrompt());
      expect(opts.writeAgentPrompt).toHaveBeenCalledWith("a1", "\r");
      expect(result.current.heldPrompt).toBeNull();
    });

    it("is cleared with a line-kill in the agent's prompt", async () => {
      const { result, opts } = await dictateToRowan();
      act(() => void result.current.clearHeldPrompt());
      expect(opts.writeAgentPrompt).toHaveBeenCalledWith("a1", expect.stringMatching(/^\u0015+$/));
      expect(result.current.heldPrompt).toBeNull();
    });

    it("does not stand in the way of Live Voice", async () => {
      const liveStart = vi.fn(async () => {});
      await dictateToRowan({ live: { ...baseOptions().live, available: true, start: liveStart } });
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", metaKey: true, shiftKey: true }));
      });
      expect(liveStart).toHaveBeenCalled();
    });
  });

  it("times out a wedged STT finalization and cancels its provider owner", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      useSpeechToText.mockReturnValue({
        available: true,
        recording: true,
        transcribing: false,
        interim: "pending words",
        start: vi.fn(),
        stop: vi.fn(() => new Promise<string>(() => {})),
        cancel,
      });
      const opts = baseOptions();
      const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
      await openMic(result);

      act(() => {
        void result.current.beginVoice("command");
      });
      await vi.advanceTimersByTimeAsync(8_000);

      expect(cancel).toHaveBeenCalled();
      expect(opts.setTrace).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("timed out"),
        tone: "error",
      }));
      expect(getVoiceTurnDiagnostics()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a finalized transcript when the owning turn was cancelled during STT stop", async () => {
    const stopped = deferred<string>();
    const cancel = vi.fn();
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "stale instruction",
      start: vi.fn(),
      stop: vi.fn(() => stopped.promise),
      cancel,
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    let finishing!: Promise<void>;
    act(() => {
      finishing = result.current.beginVoice("command");
    });
    act(() => result.current.cancelRecording());
    await act(async () => {
      stopped.resolve("arrange the canvas");
      await finishing;
    });

    expect(cancel).toHaveBeenCalled();
    expect(opts.submitQuery).not.toHaveBeenCalled();
    expect(opts.setText).not.toHaveBeenCalled();
    expect(getVoiceTurnDiagnostics()).toEqual([]);
  });

  it("ignores a late delivery receipt after the voice turn is cancelled", async () => {
    setVoiceInputSetting("sendRightAway", true);
    setVoiceInputSetting("polish", false);
    const delivered = deferred<{ text: string; delivery: "written" }>();
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "review the authentication implementation carefully"),
      cancel: vi.fn(),
    });
    const opts = baseOptions({
      nodes: [{ id: "a1", type: "agent", selected: true, data: { name: "Rowan" }, position: { x: 0, y: 0 } } as never],
      hasCommandVerb: vi.fn(() => false),
      dispatchDictation: vi.fn(() => delivered.promise),
    });
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    let finishing!: Promise<void>;
    act(() => {
      finishing = result.current.beginVoice();
    });
    await vi.waitFor(() => expect(opts.dispatchDictation).toHaveBeenCalled());
    act(() => result.current.cancelRecording());
    await act(async () => {
      delivered.resolve({ text: "review the authentication implementation carefully", delivery: "written" });
      await finishing;
    });

    expect(getVoiceTurnDiagnostics()).toEqual([]);
  });

  it("shows transcribing feedback immediately after recording stops, before STT finalizes", async () => {
    const stopped = deferred<string>();
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "arrange the canvas",
      start: vi.fn(),
      stop: vi.fn(() => stopped.promise),
      cancel: vi.fn(),
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      const pending = result.current.beginVoice("command");
      await Promise.resolve();
      expect(opts.setTrace).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Transcribing") }));
      stopped.resolve("arrange the canvas");
      await pending;
    });
  });

  it.each(["live", "fallback", "auto"])("keeps literal corrections consistent for %s dictation", async (target) => {
    setVoiceInputSetting("sendRightAway", target === "auto");
    accuracyState.replacements = [
      { id: "path", variants: ["agents dot md"], replacement: "AGENTS.md", timing: "after-ai", enabled: true },
    ];
    useSpeechToText.mockReturnValue({ available: true, recording: true, transcribing: false, interim: "",
      start: vi.fn(), stop: vi.fn(async () => "please review agents dot md"), cancel: vi.fn() });
    const opts = baseOptions({
      nodes: [{ id: "a1", type: "agent", selected: true, data: { name: "Rowan" }, position: { x: 0, y: 0 } } as never],
      hasCommandVerb: vi.fn(() => false),
      writeAgentPrompt: vi.fn(() => target === "live"),
    });
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);
    await act(async () => { await result.current.beginVoice(); });
    if (target === "auto") expect(opts.dispatchDictation).toHaveBeenCalledWith("a1", "Rowan", "please review AGENTS.md", expect.objectContaining({ polish: false }));
    else if (target === "live") expect(opts.writeAgentPrompt).toHaveBeenCalledWith("a1", "please review AGENTS.md");
    else expect(barText(opts.setText)).toBe("please review AGENTS.md");
  });

  it("applies approved literal corrections before intent routing and command dispatch", async () => {
    accuracyState.replacements = [
      { id: "claude", variants: ["clod code"], replacement: "Claude Code", timing: "before-ai", enabled: true },
    ];
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "tell clod code to review AGENTS.md"),
      cancel: vi.fn(),
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      await result.current.beginVoice("command");
    });

    expect(opts.submitQuery).toHaveBeenCalledWith("tell Claude Code to review AGENTS.md", { input: "voice", signal: expect.any(AbortSignal) });
  });

  it("keeps repository analysis for review instead of sending it to the canvas utility planner", async () => {
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "Tolong analisis dan jelaskan proyek ini secara singkat"),
      cancel: vi.fn(),
    });
    const opts = baseOptions({ hasCommandVerb: vi.fn(() => false) });
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      await result.current.beginVoice();
    });

    expect(opts.submitQuery).not.toHaveBeenCalled();
    expect(opts.setText).toHaveBeenCalledWith("Tolong analisis dan jelaskan proyek ini secara singkat");
    expect(opts.setTrace).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Select a coding agent"),
      tone: "error",
    }));
  });

  it("holds a transcript for review when the provider returns an unexpected language", async () => {
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "Kullanılmayan klavye kısayollarını da buraya ekleyin."),
      cancel: vi.fn(),
      getLastTurnMetadata: () => ({
        provider: "openai",
        model: "gpt-4o-transcribe",
        requestedLanguages: ["id-ID"],
        detectedLanguages: ["tr"],
      }),
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      await result.current.beginVoice();
    });

    expect(opts.submitQuery).not.toHaveBeenCalled();
    expect(opts.setText).toHaveBeenCalledWith("Kullanılmayan klavye kısayollarını da buraya ekleyin.");
    expect(opts.setTrace).toHaveBeenCalledWith({
      text: "Bahasa transkrip tidak sesuai dengan bahasa suara yang dipilih. Teks ditahan untuk diperiksa.",
      tone: "error",
    });
    expect(getVoiceTurnDiagnostics()).toEqual([
      expect.objectContaining({
        requestedLanguages: ["id-ID"],
        detectedLanguages: ["tr"],
        route: "insert",
        languageIntegrity: "mismatch",
        milestones: [
          expect.objectContaining({ name: "mic_stop" }),
          expect.objectContaining({ name: "stt_final" }),
          expect.objectContaining({ name: "held_for_review" }),
          expect.objectContaining({ name: "turn_complete" }),
        ],
      }),
    ]);
  });

  it("explains a language mismatch in English when English was selected", async () => {
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "Kullanılmayan kısayollarını buraya ekleyin."),
      cancel: vi.fn(),
      getLastTurnMetadata: () => ({
        provider: "openai",
        model: "gpt-4o-transcribe",
        requestedLanguages: ["en"],
        detectedLanguages: ["tr"],
      }),
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      await result.current.beginVoice();
    });

    expect(opts.setTrace).toHaveBeenCalledWith({
      text: "The transcript language did not match the selected speech language. Text was kept for review.",
      tone: "error",
    });
  });

  it("holds a strong Turkish transcript mismatch when legacy STT omits detected-language metadata", async () => {
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "Kullanılmayan klavye kısayollarını da buraya ekleyin."),
      cancel: vi.fn(),
      getLastTurnMetadata: () => ({
        provider: "openai",
        model: "gpt-4o-transcribe",
        requestedLanguages: ["id"],
        detectedLanguages: [],
      }),
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      await result.current.beginVoice();
    });

    expect(opts.submitQuery).not.toHaveBeenCalled();
    expect(opts.setText).toHaveBeenCalledWith("Kullanılmayan klavye kısayollarını da buraya ekleyin.");
    expect(opts.setTrace).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Bahasa transkrip tidak sesuai"),
      tone: "error",
    }));
  });

  it("does not block an Indonesian transcript when a legacy provider omits language metadata", async () => {
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "tambahkan terminal baru ke canvas"),
      cancel: vi.fn(),
      getLastTurnMetadata: () => ({
        provider: "openai",
        model: "gpt-4o-transcribe",
        requestedLanguages: ["id"],
        detectedLanguages: [],
      }),
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      await result.current.beginVoice();
    });

    expect(opts.submitQuery).toHaveBeenCalledWith("tambahkan terminal baru ke canvas", { input: "voice", signal: expect.any(AbortSignal) });
  });

  it("holds a cloud transcript for review when sampled audio contained no speech-like energy", async () => {
    let spectrumSink: ((bands: number[]) => void) | undefined;
    let recording = false;
    useSpeechToText.mockImplementation((options: { onSpectrum?: (bands: number[]) => void }) => {
      spectrumSink = options.onSpectrum;
      return {
        available: true,
        recording,
        transcribing: false,
        interim: "",
        start: vi.fn(async () => true),
        stop: vi.fn(async () => "invented transcript from silence"),
        cancel: vi.fn(),
        getLastTurnMetadata: () => ({
          provider: "openai",
          model: "gpt-transcribe",
          requestedLanguages: ["id"],
          detectedLanguages: [],
        }),
      };
    });
    const opts = baseOptions();
    const { result, rerender } = renderHook(() => useCanvasTurnVoiceController(opts));
    await act(async () => {
      await result.current.beginVoice("command");
    });
    for (let frame = 0; frame < 12; frame += 1) spectrumSink?.([0, 0, 0, 0]);
    recording = true;
    rerender();

    await act(async () => {
      await result.current.beginVoice();
    });

    expect(opts.submitQuery).not.toHaveBeenCalled();
    expect(opts.setText).toHaveBeenCalledWith("invented transcript from silence");
    expect(opts.setTrace).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("little or no speech"),
      tone: "error",
    }));
    expect(getVoiceTurnDiagnostics()).toEqual([
      expect.objectContaining({
        rawTranscript: "invented transcript from silence",
        finalTranscript: "invented transcript from silence",
        route: "insert",
        captureQuality: "low-speech",
        spectrumFrames: 12,
        peakSpectrumLevel: 0,
        latencyMs: expect.objectContaining({ capture: expect.any(Number) }),
        milestones: [
          expect.objectContaining({ name: "mic_stop" }),
          expect.objectContaining({ name: "stt_final" }),
          expect.objectContaining({ name: "held_for_review" }),
          expect.objectContaining({ name: "turn_complete" }),
        ],
      }),
    ]);
  });

  it("records ordered stop-to-delivery milestones for auto-sent dictation", async () => {
    setVoiceInputSetting("sendRightAway", true);
    setVoiceInputSetting("polish", true);
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "please review this authentication implementation carefully today"),
      cancel: vi.fn(),
    });
    const opts = baseOptions({
      nodes: [{ id: "a1", type: "agent", selected: true, data: { name: "Rowan" }, position: { x: 0, y: 0 } } as never],
      hasCommandVerb: vi.fn(() => false),
      dispatchDictation: vi.fn(async (_agentId: string, _agentName: string, text: string, options) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        options.onStage?.("prepared");
        options.onStage?.("requested");
        options.onStage?.("accepted");
        options.onStage?.("written");
        options.onAgentFirstOutput?.();
        return { text, delivery: "written" as const };
      }),
    });
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      await result.current.beginVoice();
    });

    const diagnostic = getVoiceTurnDiagnostics()[0];
    expect(diagnostic.milestones?.map((milestone) => milestone.name)).toEqual([
      "mic_stop",
      "stt_final",
      "route_resolved",
      "delivery_requested",
      "delivery_accepted",
      "pty_enter_written",
      "agent_first_output",
      "turn_complete",
    ]);
    const enterAt = diagnostic.milestones?.find((milestone) => milestone.name === "pty_enter_written")?.elapsedMs ?? -1;
    const firstOutputAt = diagnostic.milestones?.find((milestone) => milestone.name === "agent_first_output")?.elapsedMs ?? -1;
    expect(diagnostic.latencyMs.agentFirstOutput).toBe(firstOutputAt - enterAt);
    expect(diagnostic.turnId).toMatch(/^classic-/);
    expect(opts.dispatchDictation).toHaveBeenCalledWith(
      "a1",
      "Rowan",
      expect.any(String),
      expect.objectContaining({ polish: false, turnId: diagnostic.turnId, signal: expect.any(AbortSignal) }),
    );
    expect(diagnostic.latencyMs.total).toBeGreaterThanOrEqual(
      diagnostic.milestones?.at(-1)?.elapsedMs ?? Number.POSITIVE_INFINITY,
    );
  });

  it("records command submission as a distinct completion milestone", async () => {
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "arrange the canvas"),
      cancel: vi.fn(),
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      await result.current.beginVoice("command");
    });

    expect(getVoiceTurnDiagnostics()[0].milestones?.map((milestone) => milestone.name)).toEqual([
      "mic_stop",
      "stt_final",
      "route_resolved",
      "command_submitted",
      "turn_complete",
    ]);
  });

  it("marks review-mode dictation as held when no live terminal can receive typed text", async () => {
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "please review this authentication implementation carefully today"),
      cancel: vi.fn(),
    });
    const opts = baseOptions({
      nodes: [{ id: "a1", type: "agent", selected: true, data: { name: "Rowan" }, position: { x: 0, y: 0 } } as never],
      hasCommandVerb: vi.fn(() => false),
    });
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      await result.current.beginVoice();
    });

    expect(getVoiceTurnDiagnostics()[0].milestones?.map((milestone) => milestone.name)).toEqual([
      "mic_stop",
      "stt_final",
      "route_resolved",
      "held_for_review",
      "turn_complete",
    ]);
  });

  it("keeps fallback review verbatim even when polish is enabled", async () => {
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "please review this authentication implementation carefully today"),
      cancel: vi.fn(),
      getLastTurnMetadata: () => ({
        provider: "openai",
        model: "gpt-transcribe",
        requestedLanguages: ["id"],
        detectedLanguages: ["id"],
      }),
    });
    const opts = baseOptions({
      nodes: [{ id: "a1", type: "agent", selected: true, data: { name: "Rowan" }, position: { x: 0, y: 0 } } as never],
      hasCommandVerb: vi.fn(() => false),
    });
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      await result.current.beginVoice();
    });

    expect(getVoiceTurnDiagnostics()).toEqual([
      expect.objectContaining({
        rawTranscript: "please review this authentication implementation carefully today",
        finalTranscript: "please review this authentication implementation carefully today",
        route: "dictate",
      }),
    ]);
  });

  it("records provider, language, raw/corrected stages, route, and latency for the finalized turn", async () => {
    accuracyState.replacements = [
      { id: "claude", variants: ["clod"], replacement: "Claude", timing: "before-ai", enabled: true },
    ];
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "tell clod to review"),
      cancel: vi.fn(),
      getLastTurnMetadata: () => ({
        provider: "openai",
        model: "gpt-transcribe",
        requestedLanguages: ["id", "en"],
        detectedLanguages: ["id"],
      }),
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      await result.current.beginVoice("command");
    });

    expect(getVoiceTurnDiagnostics()).toEqual([
      expect.objectContaining({
        provider: "openai",
        model: "gpt-transcribe",
        requestedLanguages: ["id", "en"],
        detectedLanguages: ["id"],
        rawTranscript: "tell clod to review",
        replacementTranscript: "tell Claude to review",
        finalTranscript: "tell Claude to review",
        route: "command",
        latencyMs: expect.objectContaining({ transcription: expect.any(Number), total: expect.any(Number) }),
      }),
    ]);
  });

  it("marks finalized command transcripts as voice submissions so they avoid slow CLI fallback", async () => {
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(),
      stop: vi.fn(async () => "arrange the canvas"),
      cancel: vi.fn(),
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));
    await openMic(result);

    await act(async () => {
      await result.current.beginVoice("command");
    });

    expect(opts.submitQuery).toHaveBeenCalledWith("arrange the canvas", { input: "voice", signal: expect.any(AbortSignal) });
  });
});

describe("useCanvasTurnVoiceController — capture intent published for the bar's copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accuracyState.replacements = [];
    localStorage.removeItem("lotus-voice-input-v1");
    localStorage.removeItem("canvas-hotkeys-v1");
    resetVoiceInputStoreForTests();
    resetCanvasHotkeyStoreForTests();
    clearVoiceTurnDiagnostics();
  });

  function idleStt(start = vi.fn(async () => true)) {
    return {
      available: true,
      recording: false,
      transcribing: false,
      interim: "",
      start,
      stop: vi.fn(async () => ""),
      cancel: vi.fn(),
    };
  }

  it("publishes the mic-open context, focused agent included, before the mic opens", async () => {
    useSpeechToText.mockReturnValue(idleStt());
    const opts = baseOptions({
      nodes: [{ id: "a1", type: "agent", selected: true, data: { name: "Rowan" }, position: { x: 0, y: 0 } } as never],
    });
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));

    expect(result.current.captureRoute).toBeNull();
    await act(async () => {
      await result.current.beginVoice();
    });

    expect(result.current.captureRoute).toMatchObject({ forcedMode: null, context: { focus: { agentId: "a1", name: "Rowan" } } });
  });

  it("publishes the forced mode of an explicit Command capture", async () => {
    useSpeechToText.mockReturnValue(idleStt());
    const opts = baseOptions({
      nodes: [{ id: "a1", type: "agent", selected: true, data: { name: "Rowan" }, position: { x: 0, y: 0 } } as never],
    });
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));

    await act(async () => {
      await result.current.beginVoice("command");
    });

    expect(result.current.captureRoute?.forcedMode).toBe("command");
  });

  it("clears the capture context when the capture is cancelled", async () => {
    const cancel = vi.fn();
    useSpeechToText.mockReturnValue({ ...idleStt(), cancel });
    const opts = baseOptions({
      nodes: [{ id: "a1", type: "agent", selected: true, data: { name: "Rowan" }, position: { x: 0, y: 0 } } as never],
    });
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));

    await act(async () => {
      await result.current.beginVoice();
    });
    expect(result.current.captureRoute).not.toBeNull();

    act(() => {
      result.current.cancelRecording();
    });

    expect(result.current.captureRoute).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it("clears the capture context when the mic fails to start, so a dead capture can't hold the target", async () => {
    useSpeechToText.mockReturnValue(idleStt(vi.fn(async () => false)));
    const opts = baseOptions({
      nodes: [{ id: "a1", type: "agent", selected: true, data: { name: "Rowan" }, position: { x: 0, y: 0 } } as never],
    });
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));

    await act(async () => {
      await result.current.beginVoice();
    });

    expect(result.current.captureRoute).toBeNull();
  });
});

// Escape has to reach the capture from anywhere on the canvas. The bubble-phase window listener
// can't do that: xterm calls stopPropagation() on every key it handles, Escape included, so while a
// terminal holds the caret the event never reaches window — and a focused agent node (the dictation
// target) is exactly that case. These tests dispatch through a stopPropagation-ing ancestor to stand
// in for xterm.
describe("useCanvasTurnVoiceController — Escape cancels a capture from outside the bar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accuracyState.replacements = [];
    localStorage.removeItem("lotus-voice-input-v1");
    localStorage.removeItem("canvas-hotkeys-v1");
    resetVoiceInputStoreForTests();
    resetCanvasHotkeyStoreForTests();
    clearVoiceTurnDiagnostics();
  });

  /** An element that swallows keydown the way xterm's `Terminal.cancel` does. */
  function mountKeySwallowingTarget() {
    const el = document.createElement("div");
    el.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    document.body.appendChild(el);
    return el;
  }

  const escape = () => new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });

  it("cancels even when a terminal-like target swallows the event before it reaches window", () => {
    const cancel = vi.fn();
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(async () => true),
      stop: vi.fn(async () => ""),
      cancel,
    });
    const opts = baseOptions();
    renderHook(() => useCanvasTurnVoiceController(opts));

    const swallower = mountKeySwallowingTarget();
    act(() => {
      swallower.dispatchEvent(escape());
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(opts.setTrace).toHaveBeenCalledWith({ text: "Voice input cancelled.", tone: "error" });
    swallower.remove();
  });

  it("cancels a capture that is still opening the mic", () => {
    const cancel = vi.fn();
    useSpeechToText.mockReturnValue({
      available: true,
      recording: false,
      starting: true,
      transcribing: false,
      interim: "",
      start: vi.fn(async () => true),
      stop: vi.fn(async () => ""),
      cancel,
    });
    renderHook(() => useCanvasTurnVoiceController(baseOptions()));

    const swallower = mountKeySwallowingTarget();
    act(() => {
      swallower.dispatchEvent(escape());
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    swallower.remove();
  });

  it("cancels exactly once — the capture listener consumes the event before the bubble fallback", () => {
    const cancel = vi.fn();
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(async () => true),
      stop: vi.fn(async () => ""),
      cancel,
    });
    renderHook(() => useCanvasTurnVoiceController(baseOptions()));

    act(() => {
      document.body.dispatchEvent(escape());
    });

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape alone when no capture is in flight, so a terminal keeps its own Esc", () => {
    const cancel = vi.fn();
    useSpeechToText.mockReturnValue({
      available: true,
      recording: false,
      starting: false,
      transcribing: false,
      interim: "",
      start: vi.fn(async () => true),
      stop: vi.fn(async () => ""),
      cancel,
    });
    renderHook(() => useCanvasTurnVoiceController(baseOptions()));

    const seen: boolean[] = [];
    const spy = (event: Event) => seen.push(event.defaultPrevented);
    window.addEventListener("keydown", spy);
    act(() => {
      document.body.dispatchEvent(escape());
    });
    window.removeEventListener("keydown", spy);

    expect(cancel).not.toHaveBeenCalled();
    expect(seen).toEqual([false]); // reached the rest of the app untouched
  });

  it("ignores a modified Escape so it can't hijack a chord", () => {
    const cancel = vi.fn();
    useSpeechToText.mockReturnValue({
      available: true,
      recording: true,
      transcribing: false,
      interim: "",
      start: vi.fn(async () => true),
      stop: vi.fn(async () => ""),
      cancel,
    });
    renderHook(() => useCanvasTurnVoiceController(baseOptions()));

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", metaKey: true, bubbles: true, cancelable: true }),
      );
    });

    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("useCanvasTurnVoiceController — mic start failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVoiceInputStoreForTests();
    resetCanvasHotkeyStoreForTests();
  });

  it("shows the macOS permission path when the mic is denied", async () => {
    const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    useSpeechToText.mockReturnValue({
      available: true,
      recording: false,
      transcribing: false,
      interim: "",
      start: vi.fn(async () => {
        throw denied;
      }),
      stop: vi.fn(async () => ""),
      cancel: vi.fn(),
    });
    const opts = baseOptions();
    const { result } = renderHook(() => useCanvasTurnVoiceController(opts));

    await act(async () => {
      await result.current.beginVoice();
    });

    expect(opts.setTrace).toHaveBeenLastCalledWith({
      text: "Microphone permission denied — allow it in System Settings → Privacy & Security → Microphone, then reopen Lotus.",
      tone: "error",
    });
  });
});
