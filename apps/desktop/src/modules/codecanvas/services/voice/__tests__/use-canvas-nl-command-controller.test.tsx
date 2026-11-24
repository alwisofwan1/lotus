import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  nlComplete: vi.fn(() => new Promise<string>(() => {})),
  runnerStart: vi.fn(async (opts: { onLine?: (line: string) => void }) => {
    mocks.runnerOnLine = opts.onLine ?? null;
    return "run-1";
  }),
  runnerStop: vi.fn(async () => {}),
  runnerOnLine: null as ((line: string) => void) | null,
}));

vi.mock("@/lib/tauri-api", () => ({
  nlComplete: mocks.nlComplete,
}));

vi.mock("@/lib/tauri/canvas-agent", () => ({
  createTauriAgentRunner: vi.fn(() => ({ start: mocks.runnerStart, stop: mocks.runnerStop })),
}));

vi.mock("@/lib/hooks/useSttProviderRegistry", () => ({
  useSttProviderRegistry: () => ({ registry: { activeProvider: "browser", providers: [{ id: "browser", language: "en" }] } }),
}));

vi.mock("@/lib/hooks/useTtsProviderRegistry", () => ({
  useTtsProviderRegistry: () => ({ registry: { output: { tone: "jarvis", verbosity: "normal" } } }),
}));

vi.mock("../../agent-status-registry", () => ({
  agentStatusRegistry: { list: () => [] },
}));

import { useCanvasNlCommandController } from "../use-canvas-nl-command-controller";
import type { SpeechGate } from "@/modules/voice-core/speech-gate";

describe("useCanvasNlCommandController — low-latency spoken acknowledgement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nlComplete.mockImplementation(() => new Promise<string>(() => {}));
    mocks.runnerOnLine = null;
    mocks.runnerStart.mockImplementation(async (opts: { onLine?: (line: string) => void }) => {
      mocks.runnerOnLine = opts.onLine ?? null;
      return "run-1";
    });
  });

  it("speaks the deterministic confirmation as soon as a local command is applied", async () => {
    const speakSink = vi.fn();
    const speechGate = { interrupt: vi.fn(), open: vi.fn(() => speakSink) } as unknown as SpeechGate;
    const runCommand = vi.fn(() => ({ nodeId: undefined }));
    const setTrace = vi.fn();
    const setText = vi.fn();
    const { result } = renderHook(() =>
      useCanvasNlCommandController({
        nodes: [],
        cwd: "/tmp/project",
        runCommand,
        runApp: vi.fn(() => true),
        speechGate,
        setTrace,
        setText,
      }),
    );

    await act(async () => {
      await result.current.submitQuery("arrange the canvas");
    });

    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "arrange-layout" }));
    expect(speechGate.open).toHaveBeenCalledTimes(1);
    expect(speakSink).toHaveBeenCalledWith("Arranging the canvas", { language: "en" });
  });

  it("falls back to the headless CLI for voice-origin model commands when direct NL HTTP is unavailable", async () => {
    mocks.nlComplete.mockRejectedValue(new Error("nl_complete[no_key]: no BYOK NL model configured"));
    const speakSink = vi.fn();
    const speechGate = { interrupt: vi.fn(), open: vi.fn(() => speakSink) } as unknown as SpeechGate;
    const runCommand = vi.fn(() => ({ nodeId: undefined }));
    const { result } = renderHook(() =>
      useCanvasNlCommandController({
        nodes: [],
        cwd: "/tmp/project",
        runCommand,
        runApp: vi.fn(() => true),
        speechGate,
        setTrace: vi.fn(),
        setText: vi.fn(),
      }),
    );

    const pending = act(async () => {
      await result.current.submitQuery("please arrange this messy board", { input: "voice" });
    });
    await vi.waitFor(() => expect(mocks.runnerStart).toHaveBeenCalledTimes(1));
    mocks.runnerOnLine?.(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify({ intents: [{ action: "arrange" }] }) }));
    await pending;

    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "arrange-layout" }));
    expect(speakSink).toHaveBeenCalledWith("Arranging the canvas", { language: "en" });
  });
});

describe("useCanvasNlCommandController — Push-to-Talk bulk close is confirmed (until dictation stops truncating)", () => {
  const agents = [
    { id: "a1", type: "agent", data: { name: "Atlas", runner: "claude" } },
    { id: "a2", type: "agent", data: { name: "Nova", runner: "claude" } },
  ];

  function setup(nodes: Array<{ id: string; type: string; data: unknown }> = []) {
    const speakSink = vi.fn();
    const speechGate = { interrupt: vi.fn(), open: vi.fn(() => speakSink) } as unknown as SpeechGate;
    const runCommand = vi.fn(() => ({ nodeId: undefined }));
    const { result } = renderHook(() =>
      useCanvasNlCommandController({
        nodes: nodes as never,
        cwd: "/tmp/project",
        runCommand,
        runApp: vi.fn(() => true),
        speechGate,
        setTrace: vi.fn(),
        setText: vi.fn(),
      }),
    );
    return { result, runCommand };
  }

  it("asks before a spoken close-everything", async () => {
    const { result, runCommand } = setup();

    await act(async () => {
      await result.current.submitQuery("close all", { input: "voice" });
    });

    expect(result.current.pending).not.toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("asks before a spoken close of every agent", async () => {
    const { result, runCommand } = setup(agents);

    await act(async () => {
      await result.current.submitQuery("close all agents", { input: "voice" });
    });

    expect(result.current.pending).toHaveLength(2);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("closes one spoken node right away", async () => {
    const { result, runCommand } = setup(agents);

    await act(async () => {
      await result.current.submitQuery("close Atlas", { input: "voice" });
    });

    expect(result.current.pending).toBeNull();
    expect(runCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "a1" });
  });

  it("keeps the typed close-everything confirmation", async () => {
    const { result, runCommand } = setup();

    await act(async () => {
      await result.current.submitQuery("close all");
    });

    expect(result.current.pending).not.toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
  });
});
