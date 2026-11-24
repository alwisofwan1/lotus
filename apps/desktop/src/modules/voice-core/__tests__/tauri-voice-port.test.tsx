import type { ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { VoicePortProvider } from "../voice-port-context";
import { createFakeTauriVoicePort } from "../testing/fake-tauri-voice-port";
import { useVoiceFeedback } from "../use-voice-feedback";
import { useSpeechToText } from "../use-speech-to-text";

// Seam 1 (plans/voice-core): the Voice Core is driven end to end through a fake Tauri Voice Port —
// no module mocks. What we assert is what crossed the port.

function wrapperFor(port: ReturnType<typeof createFakeTauriVoicePort>["port"]) {
  return ({ children }: { children: ReactNode }) => <VoicePortProvider port={port}>{children}</VoicePortProvider>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Tauri Voice Port — the core talks to Tauri only through the port", () => {
  it("cloud TTS synthesis goes through the port with the provider's saved voice", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = createFakeTauriVoicePort({
      ttsRegistry: {
        activeProvider: "openai",
        providers: [{ id: "openai", name: "OpenAI", kind: "openai", builtin: false, enabled: true, voice: "nova" }],
        output: { speakReplies: true, agentDoneCallouts: true, wakeOnFinish: false },
      },
    });
    const { result } = renderHook(() => useVoiceFeedback(), { wrapper: wrapperFor(fake.port) });
    await waitFor(() => expect(fake.calls.map((c) => c.method)).toContain("tts.listProviders"));
    await act(async () => {}); // let the loaded registry resolve the cloud provider

    await act(async () => {
      await result.current.announce("Rowan selesai.");
    });

    const synth = fake.calls.find((c) => c.method === "tts.synthesize");
    expect(synth?.args.slice(0, 2)).toEqual(["openai", "Rowan selesai."]);
    expect(synth?.args[2]).toMatchObject({ voice: "nova" });
  });

  it("the STT provider registry is loaded through the port", async () => {
    const fake = createFakeTauriVoicePort({
      desktop: false,
      sttRegistry: { activeProvider: "browser", providers: [] },
    });
    renderHook(() => useSpeechToText(), { wrapper: wrapperFor(fake.port) });
    await waitFor(() => expect(fake.calls.map((c) => c.method)).toContain("stt.listProviders"));
  });

  it("the fake streams scripted STT events to the session that opened the stream", async () => {
    const fake = createFakeTauriVoicePort();
    const events: unknown[] = [];
    const sessionId = await fake.port.stt.streamStart("deepgram", (e) => events.push(e));
    fake.emitSttStream(sessionId, { kind: "partial", transcript: "halo" });
    await fake.port.stt.streamCancel(sessionId);
    expect(events).toEqual([{ kind: "partial", transcript: "halo" }]);
    expect(fake.calls.map((c) => c.method)).toEqual(["stt.streamStart", "stt.streamCancel"]);
  });
});
