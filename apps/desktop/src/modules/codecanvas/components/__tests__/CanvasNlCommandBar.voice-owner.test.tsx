import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasNlCommandBar } from "../CanvasNlCommandBar";

vi.mock("../../services/nl-model-transport", () => ({
  createNlModelCaller: () => ({ call: async () => '{"action":"arrange"}', dispose: () => {} }),
}));

vi.mock("@/lib/tauri-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri-api")>();
  return {
    ...actual,
    nlComplete: () => Promise.reject(new Error("no BYOK key in tests")),
  };
});

const sttMock = vi.hoisted(() => ({
  available: true,
  recording: false,
  transcribing: false,
  interim: "",
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => ""),
  cancel: vi.fn(),
}));
vi.mock("@/modules/voice-core/use-speech-to-text", () => ({
  useSpeechToText: () => sttMock,
}));

const liveMock = vi.hoisted(() => ({
  available: true,
  active: false,
  phase: "idle" as "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error",
  agentSpeaking: false,
  health: { socket: "idle", mic: "idle", playback: "idle", tools: "idle", audioDeltas: 0 },
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  interrupt: vi.fn(),
}));
vi.mock("../../services/voice/use-command-bar-live-voice", () => ({
  useCommandBarLiveVoice: () => liveMock,
}));

afterEach(() => {
  sttMock.recording = false;
  sttMock.transcribing = false;
  sttMock.start.mockClear();
  sttMock.stop.mockClear();
  sttMock.cancel.mockClear();
  liveMock.available = true;
  liveMock.active = false;
  liveMock.phase = "idle";
  liveMock.start.mockClear();
  liveMock.stop.mockClear();
  liveMock.interrupt.mockClear();
});

describe("CanvasNlCommandBar — single voice capture owner", () => {
  it("starting push-to-talk while Live is active stops Live before opening STT", async () => {
    liveMock.active = true;
    liveMock.phase = "listening";
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={vi.fn()} />);

    fireEvent.keyDown(window, { key: "v", metaKey: true, shiftKey: true });

    await waitFor(() => expect(sttMock.start).toHaveBeenCalledOnce());
    expect(liveMock.stop).toHaveBeenCalledOnce();
    expect(liveMock.stop.mock.invocationCallOrder[0]).toBeLessThan(sttMock.start.mock.invocationCallOrder[0]);
  });

  it("starting Live while push-to-talk is recording cancels STT before opening Live", async () => {
    sttMock.recording = true;
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={vi.fn()} />);

    fireEvent.keyDown(window, { key: "l", metaKey: true, shiftKey: true });

    await waitFor(() => expect(liveMock.start).toHaveBeenCalledOnce());
    expect(sttMock.cancel).toHaveBeenCalledOnce();
    expect(sttMock.cancel.mock.invocationCallOrder[0]).toBeLessThan(liveMock.start.mock.invocationCallOrder[0]);
  });

  it("ending Live does not touch idle STT", () => {
    liveMock.active = true;
    liveMock.phase = "listening";
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "End Live Voice" }));

    expect(liveMock.stop).toHaveBeenCalledOnce();
    expect(sttMock.cancel).not.toHaveBeenCalled();
  });
});
