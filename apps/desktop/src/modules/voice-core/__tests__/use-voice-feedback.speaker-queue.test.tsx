import type { ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VoicePortProvider } from "../voice-port-context";
import { createFakeTauriVoicePort } from "../testing/fake-tauri-voice-port";
import { useHoldSpeechWhileLive, useVoiceFeedback } from "../use-voice-feedback";

// Seam 1 (plans/voice-core): the Speaker Queue driven through useVoiceFeedback and a fake Tauri Voice
// Port. Cloud synthesis never finishes on its own here, so "what is speaking" is the open synthesis.

const CLOUD_REGISTRY = {
  activeProvider: "openai",
  providers: [{ id: "openai", name: "OpenAI", kind: "openai" as const, builtin: false, enabled: true }],
  output: { speakReplies: true, agentDoneCallouts: true, wakeOnFinish: false },
};

async function setup() {
  const fake = createFakeTauriVoicePort({ ttsRegistry: CLOUD_REGISTRY, synthesisNeverEnds: true });
  const wrapper = ({ children }: { children: ReactNode }) => <VoicePortProvider port={fake.port}>{children}</VoicePortProvider>;
  const hook = renderHook(() => useVoiceFeedback(), { wrapper });
  await waitFor(() => expect(fake.calls.map((c) => c.method)).toContain("tts.listProviders"));
  await act(async () => {});
  const synths = () => fake.calls.filter((c) => c.method === "tts.synthesize");
  const spoken = () => synths().map((c) => c.args[1]);
  const signalOf = (text: string) =>
    (synths().find((c) => c.args[1] === text)?.args[2] as { signal?: AbortSignal } | undefined)?.signal;
  return { fake, voice: () => hook.result.current, spoken, signalOf };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("useVoiceFeedback — Speaker Queue", () => {
  it("speaks one line at a time; a reply goes before waiting narration", async () => {
    const t = await setup();
    act(() => {
      void t.voice().announce("Atlas is reading files", { priority: "narration" });
      void t.voice().announce("Rowan is running tests", { priority: "narration" });
      t.voice().speak("Opened three agents");
    });
    await waitFor(() => expect(t.spoken()).toEqual(["Atlas is reading files"]));
    expect(t.signalOf("Atlas is reading files")?.aborted).toBe(false);
  });

  it("Live Voice hold stops the playing line at once and keeps the rest silent", async () => {
    const t = await setup();
    act(() => void t.voice().announce("Atlas is reading files", { priority: "narration" }));
    await waitFor(() => expect(t.spoken()).toEqual(["Atlas is reading files"]));

    act(() => t.voice().hold());
    expect(t.signalOf("Atlas is reading files")?.aborted).toBe(true);

    act(() => {
      t.voice().speak("late reply");
      void t.voice().announce("Rowan finished.", { priority: "callout", name: "Rowan" });
      void t.voice().announce("Mira finished.", { priority: "callout", name: "Mira" });
      void t.voice().announce("stale progress", { priority: "narration" });
    });
    await act(async () => {});
    expect(t.spoken()).toEqual(["Atlas is reading files"]);

    act(() => t.voice().release());
    await waitFor(() => expect(t.spoken()).toEqual(["Atlas is reading files", "Rowan and Mira finished."]));
  });

  it("stopAll silences the current line and everything waiting", async () => {
    const t = await setup();
    act(() => {
      void t.voice().announce("Atlas finished.", { priority: "callout", name: "Atlas" });
      void t.voice().announce("Atlas is reading files", { priority: "narration" });
    });
    await waitFor(() => expect(t.spoken()).toEqual(["Atlas finished."]));
    act(() => t.voice().stopAll());
    await act(async () => {});
    expect(t.signalOf("Atlas finished.")?.aborted).toBe(true);
    expect(t.spoken()).toEqual(["Atlas finished."]);
  });

  it("every useVoiceFeedback owner shares ONE queue — a Settings preview cannot talk over the canvas", async () => {
    const fake = createFakeTauriVoicePort({ ttsRegistry: CLOUD_REGISTRY, synthesisNeverEnds: true });
    const wrapper = ({ children }: { children: ReactNode }) => <VoicePortProvider port={fake.port}>{children}</VoicePortProvider>;
    const canvas = renderHook(() => useVoiceFeedback(), { wrapper });
    const settings = renderHook(() => useVoiceFeedback(), { wrapper });
    await waitFor(() => expect(fake.calls.filter((c) => c.method === "tts.listProviders").length).toBe(2));
    await act(async () => {});
    const spoken = () => fake.calls.filter((c) => c.method === "tts.synthesize").map((c) => c.args[1]);

    act(() => void canvas.result.current.announce("Atlas finished.", { priority: "callout", name: "Atlas" }));
    act(() => void settings.result.current.announce("This is how I sound"));
    await waitFor(() => expect(spoken()).toEqual(["Atlas finished."]));

    // Live Voice holds through the canvas owner; the Settings owner must stay silent too.
    act(() => canvas.result.current.hold());
    act(() => void settings.result.current.announce("This is how I sound"));
    await act(async () => {});
    expect(spoken()).toEqual(["Atlas finished."]);

    // Closing Settings must not silence the canvas.
    act(() => canvas.result.current.release());
    settings.unmount();
    await waitFor(() => expect(spoken()).toEqual(["Atlas finished.", "Atlas finished."]));
  });

  it("stop() (barge-in) silences replies but leaves narration alone", async () => {
    const t = await setup();
    act(() => {
      t.voice().speak("Opened three agents");
      void t.voice().announce("Atlas is reading files", { priority: "narration" });
    });
    await waitFor(() => expect(t.spoken()).toEqual(["Opened three agents"]));
    act(() => t.voice().stop());
    await waitFor(() => expect(t.spoken()).toEqual(["Opened three agents", "Atlas is reading files"]));
  });
});

describe("useHoldSpeechWhileLive — Live Voice drives the Speaker Queue hold", () => {
  it("holds while Live Voice is active and releases when it ends", async () => {
    const t = await setup();
    const hold = renderHook(({ active }) => useHoldSpeechWhileLive(active, t.voice()), {
      initialProps: { active: false },
    });
    act(() => void t.voice().announce("Atlas is reading files", { priority: "narration" }));
    await waitFor(() => expect(t.spoken()).toEqual(["Atlas is reading files"]));

    hold.rerender({ active: true });
    expect(t.signalOf("Atlas is reading files")?.aborted).toBe(true);
    act(() => void t.voice().announce("Rowan finished.", { priority: "callout", name: "Rowan" }));
    await act(async () => {});
    expect(t.spoken()).toEqual(["Atlas is reading files"]);

    hold.rerender({ active: false });
    await waitFor(() => expect(t.spoken()).toEqual(["Atlas is reading files", "Rowan finished."]));
  });
});
