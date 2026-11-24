import { StrictMode } from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { CanvasNlCommandBar } from "../CanvasNlCommandBar";
import { agentStatusRegistry } from "../../services/agent-status-registry";
import { agentReplyRegistry } from "../../services/agent-reply-registry";
import { noteSelectionRegistry } from "../../services/voice/note-selection-registry";
import { commandBarFocusRegistry } from "../../services/command-bar-focus-registry";
import { clearVoiceTurnDiagnostics, getVoiceTurnDiagnostics } from "../../services/voice/voice-turn-diagnostics";
import { voiceAgentOutputCorrelationRegistry } from "../../services/voice/voice-agent-output-correlation";
import { setVoiceInputSetting, resetVoiceInputStoreForTests } from "../../hooks/useVoiceInputSettings";
import type { Node } from "@xyflow/react";

// Real-semantics fake of the NL model transport: dispose() is PERMANENT per instance, like the
// real one (it kills in-flight CLI runs). Lets the StrictMode test below prove the bar never
// keeps using a disposed instance after the dev-mode mount → cleanup → mount cycle.
const transport = vi.hoisted(() => ({
  created: [] as Array<{ disposed: boolean }>,
  calls: [] as Array<[string, Record<string, unknown> | undefined, { allowCliFallback?: boolean } | undefined]>,
  notice: null as null | { kind: "auth" | "quota" | "config" | "cli-auth"; detail?: string },
  error: null as Error | null,
}));
const terminalInput = vi.hoisted(() => ({
  status: "live" as "idle" | "starting" | "live" | "detached" | "exited" | "failed",
  writes: [] as Array<[string, string]>,
  confirmedWrites: [] as Array<[string, string, Record<string, unknown> | undefined]>,
  confirmedReceipt: null as Promise<void> | null,
}));
vi.mock("@/modules/codespace/services/terminal-session-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/codespace/services/terminal-session-registry")>();
  return {
    ...actual,
    getTerminalSessionStatus: () => terminalInput.status,
    writeTerminalSession: (paneId: string, text: string) => { terminalInput.writes.push([paneId, text]); },
    writeTerminalSessionConfirmed: (paneId: string, text: string, metadata?: Record<string, unknown>) => {
      terminalInput.confirmedWrites.push([paneId, text, metadata]);
      return terminalInput.confirmedReceipt ?? Promise.resolve();
    },
  };
});

vi.mock("../../services/nl-model-transport", () => ({
  createNlModelCaller: (callerOptions: { onNotice?: (notice: { kind: "auth" | "quota" | "config" | "cli-auth"; detail?: string }) => void }) => {
    const inst = { disposed: false };
    transport.created.push(inst);
    return {
      call: async (
        prompt: string,
        schema?: Record<string, unknown>,
        callOptions?: { allowCliFallback?: boolean; signal?: AbortSignal },
      ) => {
        transport.calls.push([prompt, schema, callOptions]);
        if (inst.disposed) throw new Error("NL model transport disposed (cancelled)");
        if (transport.notice) callerOptions.onNotice?.(transport.notice);
        if (transport.error) throw transport.error;
        return '{"action":"create_node","nodeType":"terminal"}';
      },
      dispose: () => {
        inst.disposed = true;
      },
    };
  },
}));

// Overridable `nlComplete` (the HTTP BYOK model seam composeSpokenConfirmation uses). Default
// rejects — exactly the no-BYOK-key jsdom behavior today, so the composer falls back to its
// template. A test can install a deferred impl to control WHEN a composed confirmation lands.
const nl = vi.hoisted(() => ({ complete: undefined as undefined | ((p: string) => Promise<string>) }));
vi.mock("@/lib/tauri-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri-api")>();
  return {
    ...actual,
    nlComplete: (p: string) => (nl.complete ? nl.complete(p) : Promise.reject(new Error("no BYOK key in tests"))),
  };
});

// Controllable STT stub: jsdom has no SpeechRecognition/mic, so the real hook reports
// available:false and the mic path is untestable. This keeps the same surface with the mic "on".
// The options the bar passes are captured so tests can drive the onSpectrum visualizer callback.
const sttMock = vi.hoisted(() => ({
  available: true,
  recording: false,
  transcribing: false,
  interim: "",
  start: vi.fn(async (): Promise<boolean | void> => undefined),
  stop: vi.fn(async () => ""),
  cancel: vi.fn(),
  lastOpts: null as null | { onSpectrum?: (bands: number[]) => void },
}));
vi.mock("@/modules/voice-core/use-speech-to-text", () => ({
  useSpeechToText: (opts: { onSpectrum?: (bands: number[]) => void }) => {
    sttMock.lastOpts = opts;
    return sttMock;
  },
}));

// Controllable Live Voice (S2S) session: jsdom has no WebSocket/AudioContext session to actually
// open, and the only thing the focus-registry tests below need is `live.active` toggled true —
// the exact condition under which the bar swaps its textarea for the Live Voice composer state.
const liveMock = vi.hoisted(() => ({
  active: false,
  phase: "idle" as string,
  agentSpeaking: false,
  error: undefined as string | undefined,
  provider: "Grok" as string | null,
  strip: { turns: [] as unknown[], actions: 0, seq: 0 },
  start: vi.fn(async () => {}),
  stop: vi.fn(),
}));
vi.mock("../../services/voice/use-canvas-live-voice-controller", () => ({
  useCanvasLiveVoiceController: () => ({
    live: {
      active: liveMock.active,
      available: true,
      phase: liveMock.phase,
      agentSpeaking: liveMock.agentSpeaking,
      health: undefined,
      error: liveMock.error,
      providerName: liveMock.provider,
      start: liveMock.start,
      stop: liveMock.stop,
    },
    strip: liveMock.strip,
    voiceToolTrace: null,
    voiceDiagnosticsCopyState: "idle",
    copyVoiceDiagnostics: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText("Natural-language command"), { target: { value } });
}
// Submit is Enter-only now (the redundant send-arrow button was removed for a cleaner bar).
const run = () => fireEvent.keyDown(screen.getByLabelText("Natural-language command"), { key: "Enter" });

/** The Push-to-Talk session owns the capture, so a test opens the mic first and then stops it — the
 *  way a user does — instead of starting from an "already recording" STT state nothing opened. */
async function stopVoiceInput() {
  const micButton = () => screen.getByLabelText(/^(Stop dictating|Dictate)$/);
  sttMock.start.mockResolvedValueOnce(true);
  await act(async () => {
    fireEvent.click(micButton());
  });
  await act(async () => {});
  fireEvent.click(micButton());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const skyeNode = { id: "a-skye", type: "agent", position: { x: 0, y: 0 }, data: { name: "Skye" } } as any;

afterEach(() => {
  agentStatusRegistry.list().forEach((a) => agentStatusRegistry.remove(a.id));
  clearVoiceTurnDiagnostics();
  resetVoiceInputStoreForTests();
  nl.complete = undefined;
  sttMock.start.mockClear();
  sttMock.stop.mockClear();
  sttMock.cancel.mockClear();
  sttMock.recording = false;
  sttMock.transcribing = false;
  sttMock.interim = "";
  liveMock.active = false;
  liveMock.phase = "idle";
  liveMock.agentSpeaking = false;
  liveMock.error = undefined;
  liveMock.provider = "Grok";
  liveMock.strip = { turns: [], actions: 0, seq: 0 };
  liveMock.start.mockClear();
  liveMock.stop.mockClear();
  sttMock.available = true;
  transport.calls.length = 0;
  transport.notice = null;
  transport.error = null;
  terminalInput.status = "live";
  terminalInput.writes.length = 0;
  terminalInput.confirmedWrites.length = 0;
  terminalInput.confirmedReceipt = null;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

// Voice Auto Mode wiring (ADR-0034): the mic routes the finalized transcript through the Voice Intent
// Router. Mode switching is hotkey-only (⌘⇧V Command / ⌘⇧D Dictate) — there is no visible mode chip
// (Direction B revamp). The router itself is unit-tested in services/voice/__tests__.
describe("CanvasNlCommandBar — Voice Auto Mode routing", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const focusedSkye = { id: "a-skye", type: "agent", position: { x: 0, y: 0 }, selected: true, data: { name: "Skye" } } as any;

  it("shows no visible mode chip — switching is hotkey-only", () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    expect(screen.queryByText("→ Skye")).not.toBeInTheDocument();
    expect(screen.queryByText("Auto")).not.toBeInTheDocument();
  });

  it("submits Auto voice text to a focused plain Terminal", async () => {
    const terminal: Node = {
      id: "terminal-1",
      type: "terminal",
      selected: true,
      position: { x: 0, y: 0 },
      data: { name: "Terminal 1", runtimePaneId: "canvas:project:terminal-1" },
    };
    sttMock.recording = true;
    sttMock.stop.mockImplementation(async () => {
      sttMock.recording = false;
      return "git status";
    });
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[terminal]} cwd="/repo" />);

    await stopVoiceInput();

    await waitFor(() => expect(terminalInput.confirmedWrites[0]?.slice(0, 2)).toEqual([
      "canvas:project:terminal-1",
      "git status\r",
    ]));
  });

  it("drops a stale Auto voice Terminal receipt after the command bar unmounts", async () => {
    const receipt = deferred<void>();
    terminalInput.confirmedReceipt = receipt.promise;
    const onCommandDelivery = vi.fn();
    const terminal: Node = {
      id: "terminal-1",
      type: "terminal",
      selected: true,
      position: { x: 0, y: 0 },
      data: { name: "Terminal 1", runtimePaneId: "canvas:project:terminal-1" },
    };
    sttMock.recording = true;
    sttMock.stop.mockImplementation(async () => {
      sttMock.recording = false;
      return "git status";
    });
    const { unmount } = render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[terminal]}
        cwd="/repo"
        onCommandDelivery={onCommandDelivery}
      />,
    );

    await stopVoiceInput();
    await waitFor(() => expect(terminalInput.confirmedWrites).toHaveLength(1));
    unmount();

    await act(async () => receipt.resolve());
    expect(onCommandDelivery).not.toHaveBeenCalled();
  });

  it("inserts Dictate output directly into the focused live agent prompt", async () => {
    const runCommand = vi.fn();
    setVoiceInputSetting("polish", true);
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    const polishModel = vi.fn(() => new Promise<string>(() => {}));
    const insert = vi.fn();
    const sendReply = vi.fn(async () => {});
    const unregister = agentReplyRegistry.register("a-skye", {
      canReply: () => true,
      accepts: () => true,
      sendReply,
      insert,
    });
    sttMock.recording = true;
    sttMock.stop.mockImplementation(async () => {
      sttMock.recording = false;
      return "fix the auth bug in the login flow";
    });

    try {
      render(<CanvasNlCommandBar runCommand={runCommand} nodes={[focusedSkye]} cwd="/repo" callModel={polishModel} />);
      await stopVoiceInput();

      await waitFor(() => expect(insert).toHaveBeenCalledWith("fix the auth bug in the login flow"));
      expect(screen.getByLabelText("Natural-language command")).toHaveValue("");
      expect(screen.queryByText(/Review for Skye/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Discard dictation" })).not.toBeInTheDocument();
      expect(sendReply).not.toHaveBeenCalled();
      expect(polishModel).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("keeps the dictation in the bar, with the reason, when the agent's prompt cannot take text", async () => {
    setVoiceInputSetting("polish", false);
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    const sendReply = vi.fn(async () => {});
    // No `insert`: a headless agent has no prompt to hold unsent text.
    const unregister = agentReplyRegistry.register("a-skye", {
      canReply: () => true,
      accepts: () => true,
      sendReply,
    });
    sttMock.recording = true;
    sttMock.stop.mockImplementation(async () => {
      sttMock.recording = false;
      return "replace every authentication API";
    });

    try {
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
      await stopVoiceInput();
      const input = await screen.findByDisplayValue("replace every authentication API");
      // The field came back after the listening row, and the caret with it: Enter is one key away.
      await waitFor(() => expect(input).toHaveFocus());

      expect(screen.getByRole("alert")).toHaveTextContent(/Skye can't take text in its prompt/);
      expect(screen.queryByRole("button", { name: "Discard dictation" })).not.toBeInTheDocument();
      expect(sendReply).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(sendReply).toHaveBeenCalledWith("replace every authentication API"));
    } finally {
      unregister();
    }
  });

  it("Enter sends dictation kept in the bar to the agent it was spoken to, after the focus moved", async () => {
    setVoiceInputSetting("polish", false);
    const focusedRowan = {
      id: "a-rowan",
      type: "agent",
      position: { x: 0, y: 0 },
      selected: true,
      data: { name: "Rowan" },
    } as never;
    const sendSkye = vi.fn(async () => {});
    const sendRowan = vi.fn(async () => {});
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    agentStatusRegistry.publish({ id: "a-rowan", name: "Rowan", status: "running" });
    const offSkye = agentReplyRegistry.register("a-skye", {
      canReply: () => true,
      accepts: () => true,
      sendReply: sendSkye,
    });
    const offRowan = agentReplyRegistry.register("a-rowan", {
      canReply: () => true,
      accepts: () => true,
      sendReply: sendRowan,
    });
    sttMock.recording = true;
    sttMock.stop.mockImplementation(async () => {
      sttMock.recording = false;
      return "review the login flow";
    });

    try {
      const { rerender } = render(
        <CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />,
      );
      await stopVoiceInput();
      const input = await screen.findByDisplayValue("review the login flow");
      // The focus moves on to Rowan; Skye stays on the board.
      rerender(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[{ ...focusedSkye, selected: false }, focusedRowan]} cwd="/repo" />);
      // The Composer Target says so before Enter: still Skye, locked, not the newly focused Rowan.
      const target = document.querySelector(".canvas-nl-target .ws-composer-target");
      expect(target).toHaveTextContent("Skye");
      expect(target).toHaveAttribute("data-locked", "true");

      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(sendSkye).toHaveBeenCalledWith("review the login flow"));
      expect(sendRowan).not.toHaveBeenCalled();
    } finally {
      offSkye();
      offRowan();
    }
  });

  describe("a Held Prompt in an agent's prompt", () => {
    async function dictateToSkye() {
      setVoiceInputSetting("polish", false);
      agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "idle" });
      const insert = vi.fn();
      const sendReply = vi.fn(async () => {});
      const unregister = agentReplyRegistry.register("a-skye", {
        canReply: () => true,
        accepts: () => true,
        sendReply,
        insert,
      });
      sttMock.recording = true;
      sttMock.stop.mockImplementation(async () => {
        sttMock.recording = false;
        return "please review the compatibility assumptions carefully";
      });
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
      await stopVoiceInput();
      await waitFor(() => expect(insert).toHaveBeenCalledWith("please review the compatibility assumptions carefully"));
      // The bar acts on the Held Prompt once it has rendered it, not when the write lands.
      await screen.findByText(/In Skye's prompt/);
      return { insert, sendReply, unregister, input: screen.getByLabelText("Natural-language command") };
    }

    it("says where the text waits and what Enter and Escape do", async () => {
      const { unregister } = await dictateToSkye();
      try {
        expect(screen.getByRole("status")).toHaveTextContent("In Skye's prompt · Enter to send · Esc to clear");
      } finally {
        unregister();
      }
    });

    it("sends it with Enter in the empty bar", async () => {
      const { insert, sendReply, unregister, input } = await dictateToSkye();
      try {
        fireEvent.keyDown(input, { key: "Enter" });
        expect(insert).toHaveBeenLastCalledWith("\r");
        expect(sendReply).not.toHaveBeenCalled();
        expect(screen.queryByText(/In Skye's prompt/)).not.toBeInTheDocument();
      } finally {
        unregister();
      }
    });

    it("clears it from the agent's prompt with Escape", async () => {
      const { insert, sendReply, unregister, input } = await dictateToSkye();
      try {
        fireEvent.keyDown(input, { key: "Escape" });
        expect(insert).toHaveBeenLastCalledWith(expect.stringMatching(/^\u0015+$/));
        expect(sendReply).not.toHaveBeenCalled();
        expect(screen.queryByText(/In Skye's prompt/)).not.toBeInTheDocument();
      } finally {
        unregister();
      }
    });

    it("is forgotten once the agent starts working on it", async () => {
      const { unregister } = await dictateToSkye();
      try {
        act(() => agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" }));
        expect(screen.queryByText(/In Skye's prompt/)).not.toBeInTheDocument();
      } finally {
        unregister();
      }
    });
  });

  it("Auto: keeps the snapshotted target in review even when its prompt is not live yet", async () => {
    const runCommand = vi.fn();
    setVoiceInputSetting("polish", false);
    sttMock.recording = true;
    sttMock.stop.mockImplementation(async () => {
      sttMock.recording = false;
      return "fix the auth bug in the login flow";
    });
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[focusedSkye]} cwd="/repo" callModel={vi.fn()} />);
    await stopVoiceInput();
    await screen.findByDisplayValue("fix the auth bug in the login flow");
    expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("inserts forced Dictate output directly into a focused plain Terminal node", async () => {
    const terminalNode = {
      id: "terminal-1",
      type: "terminal",
      position: { x: 0, y: 0 },
      selected: true,
      data: { name: "Terminal 1", runtimePaneId: "runtime-terminal-1" },
    } as never;
    sttMock.start.mockResolvedValueOnce(true);
    sttMock.stop.mockResolvedValueOnce("git status");
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[terminalNode]} cwd="/repo" />);

    fireEvent.keyDown(window, { key: "d", metaKey: true, shiftKey: true });
    await waitFor(() => expect(sttMock.start).toHaveBeenCalledTimes(1));
    sttMock.recording = true;
    fireEvent.keyDown(window, { key: "d", metaKey: true, shiftKey: true });

    await waitFor(() => expect(terminalInput.writes).toEqual([["runtime-terminal-1", "git status"]]));
    expect(screen.getByLabelText("Natural-language command")).toHaveValue("");
  });

  it("Auto: with auto-send dictation on, prose is delivered immediately (no review hold)", async () => {
    const runCommand = vi.fn();
    setVoiceInputSetting("sendRightAway", true);
    sttMock.recording = true;
    sttMock.stop.mockResolvedValue("fix the auth bug in the login flow");
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[focusedSkye]} cwd="/repo" callModel={vi.fn()} />);
    await stopVoiceInput();
    // Skye has no live session → the dictate branch reports "not running", proving immediate delivery.
    await waitFor(() => expect(screen.getByText(/Skye isn't running yet/)).toBeInTheDocument());
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("does not report auto-send as delivered until the agent reply write settles", async () => {
    setVoiceInputSetting("sendRightAway", true);
    setVoiceInputSetting("polish", false);
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    let finishWrite: () => void = () => {};
    const sendReply = vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    const unregister = agentReplyRegistry.register("a-skye", {
      canReply: () => true,
      accepts: () => true,
      sendReply,
    });
    sttMock.recording = true;
    sttMock.stop.mockResolvedValue("fix the auth bug in the login flow");

    try {
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
      await stopVoiceInput();

      await waitFor(() => expect(sendReply).toHaveBeenCalledWith("fix the auth bug in the login flow"));
      expect(getVoiceTurnDiagnostics()).toEqual([]);
      finishWrite();
      await waitFor(() => expect(getVoiceTurnDiagnostics()).toHaveLength(1));
      voiceAgentOutputCorrelationRegistry.noteOutput("a-skye", "Working (1s · esc to interrupt)");
      await waitFor(() => expect(getVoiceTurnDiagnostics()[0].milestones).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "agent_first_output" })]),
      ));
      expect(getVoiceTurnDiagnostics()[0]).toMatchObject({ delivery: "written", turnId: expect.stringMatching(/^classic-/) });
      expect(getVoiceTurnDiagnostics()[0].milestones?.map((milestone) => milestone.name)).toEqual([
        "mic_stop",
        "stt_final",
        "route_resolved",
        "delivery_requested",
        "delivery_accepted",
        "pty_enter_written",
        "agent_first_output",
        "turn_complete",
      ]);
    } finally {
      unregister();
    }
  });

  it("times out an unacknowledged native delivery receipt without reporting written", async () => {
    vi.useFakeTimers();
    setVoiceInputSetting("sendRightAway", true);
    setVoiceInputSetting("polish", false);
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    const sendReply = vi.fn(() => new Promise<void>(() => {}));
    const unregister = agentReplyRegistry.register("a-skye", {
      canReply: () => true,
      accepts: () => true,
      sendReply,
    });
    sttMock.recording = true;
    sttMock.stop.mockResolvedValue("fix the auth bug in the login flow");

    try {
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
      await stopVoiceInput();
      await vi.waitFor(() => expect(sendReply).toHaveBeenCalled());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      await vi.waitFor(() => expect(getVoiceTurnDiagnostics()).toHaveLength(1));
      expect(getVoiceTurnDiagnostics()[0]).toMatchObject({ delivery: "failed" });
      expect(getVoiceTurnDiagnostics()[0].milestones?.map((milestone) => milestone.name)).not.toContain("pty_enter_written");
      expect(screen.getByText(/delivery confirmation timed out/i)).toBeInTheDocument();
    } finally {
      unregister();
      vi.useRealTimers();
    }
  });

  it("shows the raw draft immediately and lets Enter bypass pending polish", async () => {
    const raw = "please review the authentication implementation carefully and verify every regression before changing the production login flow today";
    const polished = deferred<string>();
    setVoiceInputSetting("sendRightAway", false);
    setVoiceInputSetting("polish", true);
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    const sendReply = vi.fn(async () => {});
    const unregister = agentReplyRegistry.register("a-skye", {
      canReply: () => true,
      accepts: () => true,
      sendReply,
    });
    sttMock.recording = true;
    sttMock.stop.mockImplementation(async () => {
      sttMock.recording = false;
      return raw;
    });

    try {
      render(
        <CanvasNlCommandBar
          runCommand={vi.fn()}
          nodes={[focusedSkye]}
          cwd="/repo"
          callModel={() => polished.promise}
        />,
      );
      await stopVoiceInput();

      const input = await screen.findByDisplayValue(raw);
      fireEvent.click(screen.getByRole("button", { name: "Polish text" }));
      expect(screen.queryByRole("button", { name: "Cancel text polish" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(sendReply).toHaveBeenCalledWith(raw));
      polished.resolve("Please review authentication carefully.");
    } finally {
      unregister();
    }
  });

  it("does not let late polish overwrite a user-edited review draft", async () => {
    const raw = "please review the authentication implementation carefully and verify every regression before changing the production login flow today";
    const polished = deferred<string>();
    setVoiceInputSetting("sendRightAway", false);
    setVoiceInputSetting("polish", true);
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    sttMock.recording = true;
    sttMock.stop.mockImplementation(async () => {
      sttMock.recording = false;
      return raw;
    });

    render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[focusedSkye]}
        cwd="/repo"
        callModel={() => polished.promise}
      />,
    );
    await stopVoiceInput();
    const input = await screen.findByDisplayValue(raw);
    fireEvent.click(screen.getByRole("button", { name: "Polish text" }));
    expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "review only the login race" } });
    polished.resolve("Please rewrite every authentication API.");
    await Promise.resolve();

    expect(input).toHaveValue("review only the login race");
    expect(screen.queryByRole("button", { name: "Discard dictation" })).not.toBeInTheDocument();
  });

  it("uses direct HTTP only for classic dictation cleanup so a missing key cannot cold-spawn the CLI", async () => {
    const raw = "please review the authentication implementation carefully and verify every regression before changing the production login flow today";
    setVoiceInputSetting("sendRightAway", false);
    setVoiceInputSetting("polish", true);
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    sttMock.recording = true;
    sttMock.stop.mockImplementation(async () => { sttMock.recording = false; return raw; });

    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    await stopVoiceInput();

    await screen.findByDisplayValue(raw);
    expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
    expect(transport.calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Polish text" }));
    await waitFor(() => expect(transport.calls).toHaveLength(1));
    expect(transport.calls[0][2]).toEqual({ allowCliFallback: false, signal: expect.any(AbortSignal) });
  });

  it("Shift+Enter does not submit (newline for multiline compose); Enter submits", async () => {
    const runCommand = vi.fn();
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" callModel={vi.fn()} />);
    type("arrange the canvas");
    fireEvent.keyDown(screen.getByLabelText("Natural-language command"), { key: "Enter", shiftKey: true });
    expect(runCommand).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Natural-language command"), { key: "Enter" });
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith({ kind: "arrange-layout" }));
  });

  it("Auto: a command verb wins even with an agent focused → runs the command", async () => {
    const runCommand = vi.fn();
    sttMock.recording = true;
    sttMock.stop.mockResolvedValue("arrange the canvas");
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[focusedSkye]} cwd="/repo" callModel={vi.fn()} />);
    await stopVoiceInput();
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith({ kind: "arrange-layout" }));
  });

  // TYPED input is Auto-routed too — typing prose with an agent focused must dictate to it (honoring the
  // "→ Skye" chip), NOT fall through to the command pipeline (which would say "isn't supported").
  it("typed prose with an agent focused → dictate, not a command", async () => {
    const runCommand = vi.fn();
    const callModel = vi.fn(); // must never be called — dictation is zero-model
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[focusedSkye]} cwd="/repo" callModel={callModel} />);
    type("jelaskan projek ini secara singkat");
    run();
    await waitFor(() => expect(screen.getByText(/Skye isn't running yet/)).toBeInTheDocument());
    expect(runCommand).not.toHaveBeenCalled();
    expect(callModel).not.toHaveBeenCalled();
    expect(screen.queryByText(/isn't supported by the command bar/)).not.toBeInTheDocument();
  });

  it("submits typed text to a focused plain Terminal and emits a cue only after native acknowledgement", async () => {
    const receipt = deferred<void>();
    terminalInput.confirmedReceipt = receipt.promise;
    const onCommandDelivery = vi.fn();
    const terminal: Node = {
      id: "terminal-1",
      type: "terminal",
      selected: true,
      position: { x: 0, y: 0 },
      data: { name: "Terminal 1", runtimePaneId: "canvas:project:terminal-1" },
    };
    render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[terminal]}
        cwd="/repo"
        onCommandDelivery={onCommandDelivery}
      />,
    );

    type("git status");
    run();

    await waitFor(() => expect(terminalInput.confirmedWrites).toEqual([[
      "canvas:project:terminal-1",
      "git status\r",
      {
        origin: "programmatic",
        intent: "shell-command",
        submitted: true,
        promptText: "git status",
      },
    ]]));
    expect(onCommandDelivery).not.toHaveBeenCalled();

    receipt.resolve();
    await waitFor(() => expect(onCommandDelivery).toHaveBeenCalledWith(expect.objectContaining({
      targetNodeId: "terminal-1",
      outcome: "delivered",
      commandPreview: "git status",
    })));
  });

  it("restores typed Terminal text for retry when the target is unavailable", async () => {
    terminalInput.status = "exited";
    const onCommandDelivery = vi.fn();
    const terminal: Node = {
      id: "terminal-1",
      type: "terminal",
      selected: true,
      position: { x: 0, y: 0 },
      data: { name: "Terminal 1", runtimePaneId: "canvas:project:terminal-1" },
    };
    render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[terminal]}
        cwd="/repo"
        onCommandDelivery={onCommandDelivery}
      />,
    );

    type("git status");
    run();

    await screen.findByText(/isn't writable/i);
    expect(screen.getByLabelText("Natural-language command")).toHaveValue("git status");
    expect(onCommandDelivery).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer draft when an older Terminal receipt fails late", async () => {
    const receipt = deferred<void>();
    terminalInput.confirmedReceipt = receipt.promise;
    const terminal: Node = {
      id: "terminal-1",
      type: "terminal",
      selected: true,
      position: { x: 0, y: 0 },
      data: { name: "Terminal 1", runtimePaneId: "canvas:project:terminal-1" },
    };
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[terminal]} cwd="/repo" />);

    type("first command");
    run();
    await waitFor(() => expect(terminalInput.confirmedWrites).toHaveLength(1));
    type("new draft");

    receipt.reject(new Error("native write failed"));
    await screen.findByText(/Couldn't confirm delivery/i);
    expect(screen.getByLabelText("Natural-language command")).toHaveValue("new draft");
  });

  it("submits an explicitly addressed plain Terminal without requiring selection", async () => {
    const terminal: Node = {
      id: "terminal-1",
      type: "terminal",
      position: { x: 0, y: 0 },
      data: { terminalNumber: 1, runtimePaneId: "canvas:project:terminal-1" },
    };
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[terminal]} cwd="/repo" callModel={vi.fn()} />);

    type("tell Terminal 1 to git status");
    run();

    await waitFor(() => expect(terminalInput.confirmedWrites[0]?.slice(0, 2)).toEqual([
      "canvas:project:terminal-1",
      "git status\r",
    ]));
  });

  it("emits a typed Agent delivery cue only after the agent write receipt settles", async () => {
    const receipt = deferred<void>();
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running", sessionId: "session-1" });
    const sendReply = vi.fn(() => receipt.promise);
    const unregister = agentReplyRegistry.register("a-skye", {
      canReply: () => true,
      accepts: () => true,
      sendReply,
    });
    const onCommandDelivery = vi.fn();
    render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[focusedSkye]}
        cwd="/repo"
        onCommandDelivery={onCommandDelivery}
      />,
    );

    type("review the current implementation");
    run();
    await waitFor(() => expect(sendReply).toHaveBeenCalledWith("review the current implementation"));
    expect(onCommandDelivery).not.toHaveBeenCalled();

    receipt.resolve();
    await waitFor(() => expect(onCommandDelivery).toHaveBeenCalledWith(expect.objectContaining({
      targetNodeId: "a-skye",
      outcome: "delivered",
      commandPreview: "review the current implementation",
    })));
    unregister();
  });

  it("typed command verb with an agent focused → command (verb still wins)", async () => {
    const runCommand = vi.fn();
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[focusedSkye]} cwd="/repo" callModel={vi.fn()} />);
    type("arrange the canvas");
    run();
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith({ kind: "arrange-layout" }));
  });
});

// Selected-text transform (Option D): text selected in a focused note routes the instruction to a
// transform that rewrites the selection in place, via the note-selection bridge.
describe("CanvasNlCommandBar — selected-text transform", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const focusedNote = { id: "n1", type: "note", position: { x: 0, y: 0 }, selected: true, data: { name: "Spec" } } as any;

  it("shows no mode chip even with a note selection — transform is decided by the router, not a chip", () => {
    const off = noteSelectionRegistry.register("n1", { getSelectedText: () => "milk eggs bread", replaceSelection: vi.fn() });
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedNote]} cwd="/repo" />);
    expect(screen.queryByText("✎ Edit")).not.toBeInTheDocument();
    off();
  });

  it("typed instruction with a note selection → rewrites the selection (not a command)", async () => {
    const runCommand = vi.fn();
    const replaceSelection = vi.fn();
    const off = noteSelectionRegistry.register("n1", { getSelectedText: () => "milk eggs bread", replaceSelection });
    const callModel = vi.fn().mockResolvedValue("- milk\n- eggs\n- bread");
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[focusedNote]} cwd="/repo" callModel={callModel} />);
    type("turn this into a bulleted list");
    run();
    await waitFor(() => expect(replaceSelection).toHaveBeenCalledWith("- milk\n- eggs\n- bread"));
    expect(runCommand).not.toHaveBeenCalled();
    off();
  });

  it("a command verb still wins over a note selection", async () => {
    const runCommand = vi.fn();
    const replaceSelection = vi.fn();
    const off = noteSelectionRegistry.register("n1", { getSelectedText: () => "milk eggs bread", replaceSelection });
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[focusedNote]} cwd="/repo" callModel={vi.fn()} />);
    type("arrange the canvas");
    run();
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith({ kind: "arrange-layout" }));
    expect(replaceSelection).not.toHaveBeenCalled();
    off();
  });
});

// Conversational repair (Option C): an ambiguous target asks which node, then the pick executes.
describe("CanvasNlCommandBar — clarify ambiguous target", () => {
  // Two browsers so "close the browser" (a partial match) resolves ambiguously.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b1 = { id: "b1", type: "browser", position: { x: 0, y: 0 }, data: { browserNumber: 1 } } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b2 = { id: "b2", type: "browser", position: { x: 0, y: 0 }, data: { browserNumber: 2 } } as any;

  it("asks to disambiguate, then the chosen candidate runs the command", async () => {
    const runCommand = vi.fn();
    // "browser" partial-matches both "Browser 1" and "Browser 2" → ambiguous (fast-path, zero model).
    const callModel = vi.fn();
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[b1, b2]} cwd="/repo" callModel={callModel} />);
    type("focus browser");
    run();
    // The clarification appears with both candidates; nothing has executed yet.
    const pick = await screen.findByRole("button", { name: "Browser 2" });
    expect(screen.getByRole("button", { name: "Browser 1" })).toBeInTheDocument();
    expect(runCommand).not.toHaveBeenCalled();
    fireEvent.click(pick);
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith({ kind: "focus-node", nodeId: "b2" }));
  });
});

describe("CanvasNlCommandBar — listening-border FX", () => {
  const row = (c: HTMLElement) => c.querySelector(".canvas-nl-input-row") as HTMLElement;

  it("renders the FX overlay layer inside the input row", () => {
    const { container } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    const fx = row(container).querySelector(".canvas-nl-fx");
    expect(fx).not.toBeNull();
    expect(fx).toHaveAttribute("aria-hidden");
  });

  it("has no data-voice while idle", () => {
    const { container } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(row(container).hasAttribute("data-voice")).toBe(false);
  });

  it("marks the row data-voice=recording while capturing", () => {
    sttMock.recording = true;
    const { container } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(row(container)).toHaveAttribute("data-voice", "recording");
  });

  it("marks the row data-voice=transcribing during the transcription round-trip", () => {
    sttMock.transcribing = true;
    const { container } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(row(container)).toHaveAttribute("data-voice", "transcribing");
  });

  it("writes spectrum frames to the FX layer as a conic-gradient CSS variable (no re-render)", () => {
    sttMock.recording = true;
    const { container } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    const fx = row(container).querySelector(".canvas-nl-fx") as HTMLElement;
    sttMock.lastOpts?.onSpectrum?.([0.2, 0.9, 0.5]);
    expect(fx.style.getPropertyValue("--nl-spectrum")).toContain("conic-gradient(from ");
    expect(fx.style.getPropertyValue("--nl-level")).not.toBe("");
  });

  it("kicks the onset pulse on a sharp level rise, decaying it on subsequent quieter frames", () => {
    // Real frames are ~16ms apart; synchronous test calls are not, so performance.now() must be
    // stubbed to advance between calls — otherwise dt=0 and the decay step (correctly) does nothing.
    let t = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => t);
    sttMock.recording = true;
    const { container } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    const fx = row(container).querySelector(".canvas-nl-fx") as HTMLElement;
    sttMock.lastOpts?.onSpectrum?.([0, 0, 0]); // silence baseline
    t += 16;
    sttMock.lastOpts?.onSpectrum?.([0.9, 0.9, 0.9]); // sudden loud attack — a syllable onset
    const afterOnset = parseFloat(fx.style.getPropertyValue("--nl-onset"));
    expect(afterOnset).toBeGreaterThan(0.5);
    t += 100; // real elapsed time before the level is read again
    sttMock.lastOpts?.onSpectrum?.([0.9, 0.9, 0.9]); // level holds steady — no new onset
    const afterHold = parseFloat(fx.style.getPropertyValue("--nl-onset"));
    expect(afterHold).toBeLessThan(afterOnset); // decaying, not re-triggering
    nowSpy.mockRestore();
  });

  it("clears the spectrum, level, and onset vars once capture stops (no stale freeze-frame)", () => {
    sttMock.recording = true;
    const { container, rerender } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    const fx = row(container).querySelector(".canvas-nl-fx") as HTMLElement;
    sttMock.lastOpts?.onSpectrum?.([0.5, 0.5]);
    expect(fx.style.getPropertyValue("--nl-spectrum")).not.toBe("");

    sttMock.recording = false;
    rerender(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(fx.style.getPropertyValue("--nl-spectrum")).toBe("");
    expect(fx.style.getPropertyValue("--nl-level")).toBe("");
    expect(fx.style.getPropertyValue("--nl-onset")).toBe("");
  });
});

// plans/nl-type-to-focus: "/" and Space focus the bar via commandBarFocusRegistry rather than a
// direct ref, because the hotkey dispatcher lives in CanvasPage. The bar's job is to register a
// focus function that tells the truth about whether it can actually take focus right now.
describe("CanvasNlCommandBar — command-bar focus registry", () => {
  it("registers a focus function on mount that really moves DOM focus to the textarea", () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    const input = screen.getByLabelText("Natural-language command");
    expect(document.activeElement).not.toBe(input);
    expect(commandBarFocusRegistry.focus()).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("unregisters on unmount — a stale bar cannot be focused after it's gone", () => {
    const { unmount } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    unmount();
    expect(commandBarFocusRegistry.focus()).toBe(false);
  });

  it("refuses while busy — the disabled textarea cannot take focus, so focus() reports false", () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    // "create a terminal" fast-paths as a command verb, so Enter goes through submitQuery, which
    // sets busy=true synchronously before its async model call resolves — the same window the
    // real UI is in while a command is in flight.
    type("create a terminal");
    run();
    expect(screen.getByLabelText("Natural-language command")).toBeDisabled();
    expect(commandBarFocusRegistry.focus()).toBe(false);
  });

  it("refuses during a live voice session — the textarea isn't even rendered, so focus() reports false", () => {
    liveMock.active = true;
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(screen.queryByLabelText("Natural-language command")).not.toBeInTheDocument();
    expect(commandBarFocusRegistry.focus()).toBe(false);
  });
});

describe("CanvasNlCommandBar", () => {
  it("survives StrictMode double-mount — the NL transport is not left permanently disposed", async () => {
    // Dev-mode StrictMode runs mount → cleanup → mount. The cleanup disposes the transport;
    // the bar must lazily create a fresh instance instead of reusing the dead memoized one
    // (regression: every LLM-path command failed with "NL model transport disposed").
    const runCommand = vi.fn();
    render(
      <StrictMode>
        <CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" />
      </StrictMode>,
    );
    type("open 1 claude and 1 codex");
    run();
    await screen.findByText("Spawning a Claude agent and a Codex agent");
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("runs a safe command immediately and shows a trace", async () => {
    const runCommand = vi.fn();
    const callModel = vi.fn(async (_p: string) => '{"action":"create_node","nodeType":"terminal"}');
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" callModel={callModel} />);
    type("add a terminal");
    run();
    await screen.findByText("Create a terminal node");
    expect(runCommand).toHaveBeenCalledWith({ kind: "create-node", nodeType: "terminal", focus: true });
  });

  it("navigates the selected BrowserNode from the command bar without calling the model", async () => {
    const runCommand = vi.fn();
    const callModel = vi.fn(async () => { throw new Error("browser command should use the fast path"); });
    const browser1: Node = { id: "browser-1", type: "browser", selected: true, position: { x: 0, y: 0 }, data: { browserNumber: 1 } };
    const browser2: Node = { id: "browser-2", type: "browser", selected: false, position: { x: 0, y: 0 }, data: { browserNumber: 2 } };
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[browser1, browser2]} cwd="/repo" callModel={callModel} />);

    type("Di browser tolong buka YouTube dan putar musik apapun");
    run();

    await waitFor(() =>
      expect(runCommand).toHaveBeenCalledWith({
        kind: "navigate-browser-node",
        nodeId: "browser-1",
        url: "https://www.youtube.com/",
      }),
    );
    expect(callModel).not.toHaveBeenCalled();
  });

  it("shows an optimistic 'Dispatch to <name>…' status while the refine/boot is still in flight (W2b)", async () => {
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    // Hold the refine model call open so we can observe the in-progress placeholder.
    let resolveRefine: (v: string) => void = () => {};
    const callModel = vi.fn(() => new Promise<string>((res) => { resolveRefine = res; }));
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[skyeNode]} cwd="/repo" callModel={callModel} />);
    // Direct address to a live agent (≥6-word task WITH a vague "it" so refinement is eligible) →
    // fast-path dispatch (0-LLM parse); only the refine calls the model, and it's the one we hold open.
    type("Skye, refactor this authentication module and add tests covering it");
    run();
    const input = screen.getByLabelText("Natural-language command");
    await waitFor(() => expect(input).toHaveAttribute("placeholder", "Dispatch to Skye…"));
    resolveRefine("refactor the auth module and add tests"); // let it settle
  });

  it("applies a compound request's effects in order and shows a combined trace", async () => {
    const runCommand = vi.fn();
    const callModel = vi.fn(
      async (_p: string) => '[{"action":"create_node","nodeType":"terminal"},{"action":"create_node","nodeType":"note"}]',
    );
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" callModel={callModel} />);
    type("add a terminal and a note");
    run();
    await screen.findByText("Create a terminal node · Create a note node");
    expect(runCommand).toHaveBeenNthCalledWith(1, { kind: "create-node", nodeType: "terminal", content: undefined, focus: true });
    expect(runCommand).toHaveBeenNthCalledWith(2, { kind: "create-node", nodeType: "note", content: undefined, focus: true });
  });

  it("applies every agent in a planner-counted multi-spawn batch", async () => {
    const runCommand = vi.fn();
    const callModel = vi.fn(async () => JSON.stringify({
      outcome: "intents",
      intents: [{ action: "spawn_agent", runner: "claude", count: 3 }],
      answer: null,
      error: null,
    }));
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" callModel={callModel} />);

    type("tolong siapkan tiga agen Claude untuk saya");
    run();

    await screen.findByText("Spawning 3 Claude agents");
    expect(runCommand).toHaveBeenCalledTimes(3);
    for (const [command] of runCommand.mock.calls) {
      expect(command).toMatchObject({ kind: "create-agent", definition: { runner: "claude" }, focus: true });
    }
  });

  it("applies a batch that includes a close immediately — no confirmation", async () => {
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    const runCommand = vi.fn();
    render(
      <CanvasNlCommandBar
        runCommand={runCommand}
        nodes={[skyeNode]}
        cwd="/repo"
        callModel={async () => '[{"action":"arrange"},{"action":"close","target":"Skye"}]'}
      />,
    );
    type("tidy up and close skye");
    run();
    await screen.findByText(/Arrange the canvas/);
    expect(screen.queryByRole("alertdialog")).toBeNull(); // close no longer confirms
    expect(runCommand).toHaveBeenNthCalledWith(1, { kind: "arrange-layout" });
    expect(runCommand).toHaveBeenNthCalledWith(2, { kind: "close-node", nodeId: "a-skye" });
  });

  it("speaks the batch's spoken confirmations through the voice channel", async () => {
    const speak = vi.fn();
    const callModel = vi.fn(
      async (_p: string) => '[{"action":"create_node","nodeType":"terminal"},{"action":"arrange"}]',
    );
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={callModel} speak={speak} />);
    type("add a terminal and tidy up");
    run();
    await screen.findByText(/Create a terminal node/);
    expect(speak).toHaveBeenCalledWith("Creating a terminal node. Arranging the canvas", { language: "en" });
  });

  it("answers an Indonesian query in English — Indonesian is dropped as a spoken-reply language", async () => {
    const speak = vi.fn();
    render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[]}
        cwd="/repo"
        callModel={async () => '{"action":"arrange"}'}
        speak={speak}
      />,
    );
    type("tolong rapikan semua agen di papan");
    run();
    await screen.findByText(/Arrange the canvas/);
    await waitFor(() => expect(speak).toHaveBeenCalledWith(expect.any(String), { language: "en" }));
  });

  it("reports an undelivered dispatch instead of faking success when the agent has no live session", async () => {
    // Skye is on the roster (so the name resolves) but has no registered reply handle → not deliverable.
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[skyeNode]}
        cwd="/repo"
        callModel={async () => '{"action":"dispatch","target":"Skye","task":"fix the bug"}'}
      />,
    );
    type("tell skye to fix the bug");
    run();
    await screen.findByText(/isn't running yet/i);
  });

  it("waits for the write receipt of a typed dispatch, the way Live Voice does", async () => {
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    const write = deferred<void>();
    const unregister = agentReplyRegistry.register("a-skye", {
      canReply: () => true,
      sendReply: vi.fn(() => write.promise),
    });
    const onCommandDelivery = vi.fn();
    render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[skyeNode]}
        cwd="/repo"
        callModel={async () => '{"action":"dispatch","target":"Skye","task":"fix the bug"}'}
        onCommandDelivery={onCommandDelivery}
      />,
    );
    type("tell skye to fix the bug");
    run();
    await waitFor(() => expect(onCommandDelivery).toHaveBeenCalled());
    // Accepted is not written: no success line until the write lands.
    expect(screen.queryByText(/Dispatch to Skye/i)).not.toBeInTheDocument();
    await act(async () => write.reject(new Error("pty closed")));
    await screen.findByText(/couldn.t deliver.*Skye|Agent session closed before the prompt was written/i);
    unregister();
  });

  it("queues a dispatch (not an error) when the agent is live but still starting", async () => {
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "connecting" });
    // Live PTY, not ready yet: accepts but can't reply now → the message is buffered.
    const unregister = agentReplyRegistry.register("a-skye", {
      canReply: () => false,
      accepts: () => true,
      sendReply: () => {},
    });
    render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[skyeNode]}
        cwd="/repo"
        callModel={async () => '{"action":"dispatch","target":"Skye","task":"fix the bug"}'}
      />,
    );
    type("tell skye to fix the bug");
    run();
    await screen.findByText(/queued until the agent is ready/i);
    unregister();
  });

  it("emits a delivery event only when a dispatch reaches a live agent", async () => {
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    const unregister = agentReplyRegistry.register("a-skye", {
      canReply: () => true,
      accepts: () => true,
      sendReply: () => {},
    });
    const onCommandDelivery = vi.fn();
    render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[skyeNode]}
        cwd="/repo"
        callModel={async () => '{"action":"dispatch","target":"Skye","task":"fix the bug"}'}
        onCommandDelivery={onCommandDelivery}
      />,
    );
    type("tell skye to fix the bug");
    run();
    await screen.findByText(/dispatch to skye/i);
    expect(onCommandDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "nl-command",
        targetNodeId: "a-skye",
        outcome: "delivered",
        commandPreview: "fix the bug",
      }),
    );
    unregister();
  });

  it("answers an informational question with a short spoken reply (not an error)", async () => {
    const speak = vi.fn();
    render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[]}
        cwd="/repo"
        speak={speak}
        callModel={async () => '{"answer":"There are 6 agents on the canvas."}'}
      />,
    );
    type("how many agents are here?");
    run();
    await screen.findByText("There are 6 agents on the canvas.");
    expect(speak).toHaveBeenCalledWith("There are 6 agents on the canvas.", { language: "en" });
  });

  it("shows an error in a dedicated alert (role=alert), not the placeholder", async () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={async () => "I can't do that"} />);
    type("do something impossible");
    run();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/rephrasing/i);
  });

  it("turns an expired Claude session into an actionable recovery notice", async () => {
    const runCommand = vi.fn(() => ({ nodeId: "terminal-login" }));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    transport.notice = { kind: "cli-auth", detail: "OAuth session expired" };
    transport.error = new Error("Claude CLI session expired or signed out");

    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" />);
    type("do something clever");
    run();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Claude needs sign-in");
    expect(alert).toHaveTextContent("Local canvas commands still work");
    fireEvent.click(screen.getByRole("button", { name: "Copy login command and open terminal" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("claude /login"));
    expect(runCommand).toHaveBeenCalledWith({ kind: "create-node", nodeType: "terminal", focus: true });
    expect(await screen.findByRole("status")).toHaveTextContent("Login command copied");
  });

  it("opens a login terminal without claiming a copy when clipboard access is unavailable", async () => {
    const runCommand = vi.fn(() => ({ nodeId: "terminal-login" }));
    transport.notice = { kind: "cli-auth", detail: "OAuth session expired" };
    transport.error = new Error("Claude CLI session expired or signed out");

    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" />);
    type("do something clever");
    run();
    fireEvent.click(await screen.findByRole("button", { name: "Copy login command and open terminal" }));

    await waitFor(() => expect(runCommand).toHaveBeenCalledWith({ kind: "create-node", nodeType: "terminal", focus: true }));
    expect(await screen.findByRole("status")).toHaveTextContent("Run claude /login");
    expect(screen.queryByText(/Login command copied/)).toBeNull();
  });

  it("does not render an error alert for a successful command", async () => {
    const callModel = vi.fn(async (_p: string) => '{"action":"create_node","nodeType":"terminal"}');
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={callModel} />);
    type("add a terminal");
    run();
    await screen.findByText("Create a terminal node"); // sr-only status
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closes a node immediately without confirmation", async () => {
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    const runCommand = vi.fn();
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[skyeNode]} cwd="/repo" callModel={async () => '{"action":"close","target":"Skye"}'} />);
    type("close skye");
    run();
    await screen.findByText(/close skye/i);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(runCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "a-skye" });
  });

  // --- Barge-in (voice output interruption) ---------------------------------------------------

  it("barge-in: starting a mic capture silences in-flight speech before listening", async () => {
    sttMock.start.mockClear();
    const stopSpeaking = vi.fn();
    render(
      <CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={async () => "unused"} stopSpeaking={stopSpeaking} />,
    );
    fireEvent.click(screen.getByLabelText("Dictate"));
    await waitFor(() => expect(sttMock.start).toHaveBeenCalledTimes(1));
    expect(stopSpeaking).toHaveBeenCalledTimes(1);
    // Order matters: the TTS must be silenced BEFORE the mic opens, or it bleeds into the capture.
    expect(stopSpeaking.mock.invocationCallOrder[0]).toBeLessThan(sttMock.start.mock.invocationCallOrder[0]);
  });

  it("barge-in: submitting a new command silences the previous confirmation", async () => {
    const stopSpeaking = vi.fn();
    render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[]}
        cwd="/repo"
        callModel={async () => '{"action":"create_node","nodeType":"terminal"}'}
        stopSpeaking={stopSpeaking}
      />,
    );
    type("add a terminal");
    run();
    await screen.findByText("Create a terminal node");
    expect(stopSpeaking).toHaveBeenCalled();
  });

  it("confirms a completed command immediately without waiting for model-composed speech", async () => {
    // Command acknowledgement is deterministic and localized. A slow utility model must not sit
    // between an already-applied Canvas action and its spoken confirmation.
    nl.complete = () => new Promise<string>(() => {});
    const speak = vi.fn();
    render(
      <CanvasNlCommandBar
        runCommand={vi.fn()}
        nodes={[]}
        cwd="/repo"
        callModel={async () => '{"action":"arrange"}'}
        speak={speak}
      />,
    );

    type("tidy up the canvas");
    run();

    await screen.findByText(/Arrange the canvas/);
    expect(speak).toHaveBeenCalledWith("Arranging the canvas", { language: "en" });
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("confirms close_all before closing everything (blast-radius confirmation), then applies on Confirm", async () => {
    const runCommand = vi.fn();
    // "close all" resolves locally (fast path) → no model call needed.
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[skyeNode]} cwd="/repo" callModel={async () => "unused"} />);
    type("close everything");
    run();
    // Closing everything is high blast-radius → a confirmation dialog, not an immediate apply.
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Close everything?");
    expect(runCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm"));
    expect(runCommand).toHaveBeenCalledWith({ kind: "close-all-nodes" });
  });

  describe("docked top controls (command-bar mode)", () => {
    const docked = {
      projects: [],
      activeProjectId: null,
      fallbackName: "/repo",
      onSelectProject: vi.fn(),
      onOpenCanvases: vi.fn(),
      onOpenSettings: vi.fn(),
      onNewProject: vi.fn(),
      onCloseProject: vi.fn(),
    };

    it("renders no top controls without the docked prop (top-bar mode is default)", () => {
      const { container } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
      expect(container.querySelector("[data-docked]")).toBeNull();
      expect(screen.queryByRole("button", { name: "Canvas settings" })).toBeNull();
    });

    it("folds Frame overview and Settings into the More menu when docked", () => {
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" docked={docked} />);
      expect(screen.getByLabelText("Natural-language command")).toBeInTheDocument(); // input still there
      expect(screen.queryByRole("menuitem", { name: "Canvas settings" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      expect(screen.getByRole("menuitem", { name: "Canvas settings" })).toBeInTheDocument();
      expect(screen.getByRole("menuitemcheckbox", { name: "Frame overview" })).toBeInTheDocument();
    });

    it("keeps the Dock as its own button with the waiting count, not folded behind More", () => {
      render(
        <CanvasNlCommandBar
          runCommand={vi.fn()}
          nodes={[]}
          cwd="/repo"
          docked={{ ...docked, onToggleDock: vi.fn(), dockWaiting: [{ app: "automation", label: "Automation", count: 3 }] }}
        />,
      );
      expect(screen.getByRole("button", { name: "Show the Dock, 3 waiting" })).toHaveTextContent("3");
      expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    });

    /// Board 22: before it, a remote board in command-bar mode showed no machine status at all.
    it("shows the remote project's machine beside the project name when docked", () => {
      const machine = {
        label: "devbox-vps",
        host: "devbox-vps",
        tunnel: { state: "failed" as const, ports: [], detail: "remote port forwarding failed" },
        hooks: null,
        onRetry: vi.fn(),
        onRecheck: () => Promise.resolve(),
        onDisconnect: vi.fn(),
      };
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" docked={docked} machine={machine} />);
      const chip = screen.getByRole("button", { name: "devbox-vps · tak melapor" });
      fireEvent.click(chip);
      fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));
      expect(machine.onRetry).toHaveBeenCalledOnce();
    });

    it("offers Lotus Home in the More menu when docked, like the Top Bar's mark", () => {
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" docked={docked} />);
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      expect(screen.getByRole("menuitem", { name: "Lotus Home" })).toHaveAttribute("href", "/");
    });

    it("has no Lotus mark when not docked (the Top Bar owns it then)", () => {
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
      expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    });

    it("marks the bar as docked so CSS can widen the pill", () => {
      const { container } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" docked={docked} />);
      expect(container.querySelector("[data-docked]")).not.toBeNull();
    });

    it("wires the More menu's Settings and Frame overview to their callbacks (overview, not Canvases)", () => {
      const onOpenSettings = vi.fn();
      const onOpenCanvases = vi.fn();
      const onToggleFrameOverview = vi.fn();
      render(
        <CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" docked={{ ...docked, onOpenSettings, onOpenCanvases, onToggleFrameOverview }} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Canvas settings" }));
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Frame overview" }));
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
      expect(onToggleFrameOverview).toHaveBeenCalledTimes(1);
      expect(onOpenCanvases).not.toHaveBeenCalled();
    });

    // End-to-end: a typed NL command flows through the resolver + effect executor to the docked
    // navigation callbacks — the app-effect channel (switch project / open page / close project).
    const withProjects = {
      ...docked,
      projects: [
        { id: "cp_alpha", rootDir: "/work/alpha", alias: null, position: 0, updatedAt: 0, lastOpenedAt: 2 },
        { id: "cp_beta", rootDir: "/work/beta", alias: null, position: 1, updatedAt: 0, lastOpenedAt: 1 },
      ],
      activeProjectId: "cp_alpha",
    };

    it("switches project from a typed NL command (fast path → onSelectProject)", async () => {
      const onSelectProject = vi.fn();
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={vi.fn()} docked={{ ...withProjects, onSelectProject }} />);
      type("switch to project beta");
      run();
      await waitFor(() => expect(onSelectProject).toHaveBeenCalledWith("cp_beta"));
    });

    it("goes back to the previous project (most-recently-opened other than active)", async () => {
      const onSelectProject = vi.fn();
      // active = cp_alpha; the other project (cp_beta) is the most-recent → the "previous" target.
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={vi.fn()} docked={{ ...withProjects, onSelectProject }} />);
      type("go back to the previous project");
      run();
      await waitFor(() => expect(onSelectProject).toHaveBeenCalledWith("cp_beta"));
    });

    it("opens settings from a typed NL command", async () => {
      const onOpenSettings = vi.fn();
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={vi.fn()} docked={{ ...withProjects, onOpenSettings }} />);
      type("open settings");
      run();
      await waitFor(() => expect(onOpenSettings).toHaveBeenCalledTimes(1));
    });

    it("closes a named project after confirmation (destructive), via the projectId-aware callback", async () => {
      const onCloseProject = vi.fn();
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={vi.fn()} docked={{ ...withProjects, onCloseProject }} />);
      type("close project beta");
      run();
      // Closing a whole project is destructive — it asks first, and does not fire until confirmed.
      const confirm = await screen.findByRole("button", { name: "Confirm" });
      expect(onCloseProject).not.toHaveBeenCalled();
      fireEvent.click(confirm);
      await waitFor(() => expect(onCloseProject).toHaveBeenCalledWith("cp_beta"));
    });
  });

  // Decoupling the app-effect channel from the docked UI: the host always has projects + navigation
  // callbacks available, regardless of whether the top controls are docked into this bar. `appNav`
  // carries that channel independently of `docked`, so switch_project/open_page/new_project/
  // close_project resolve in the default top-bar layout too — and so voice sees the same tool set
  // (buildS2sCanvasRealtimeTools gates switch_project on `projects`, fed by this same channel).
  describe("appNav (app-effect channel independent of docked layout)", () => {
    const appNav = {
      projects: [
        { id: "cp_alpha", rootDir: "/work/alpha", alias: null, position: 0, updatedAt: 0, lastOpenedAt: 2 },
        { id: "cp_beta", rootDir: "/work/beta", alias: null, position: 1, updatedAt: 0, lastOpenedAt: 1 },
      ],
      activeProjectId: "cp_alpha",
      onSelectProject: vi.fn(),
      onOpenCanvases: vi.fn(),
      onOpenSettings: vi.fn(),
      onNewProject: vi.fn(),
      onCloseProject: vi.fn(),
    };

    it("renders no docked chrome with appNav alone — the channel is not a UI layout switch", () => {
      const { container } = render(
        <CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={vi.fn()} appNav={appNav} />,
      );
      expect(container.querySelector("[data-docked]")).toBeNull();
      expect(screen.queryByRole("button", { name: "Canvas settings" })).toBeNull();
    });

    it("switches project from a typed NL command via appNav, with no docked prop at all", async () => {
      const onSelectProject = vi.fn();
      render(
        <CanvasNlCommandBar
          runCommand={vi.fn()}
          nodes={[]}
          cwd="/repo"
          callModel={vi.fn()}
          appNav={{ ...appNav, onSelectProject }}
        />,
      );
      type("switch to project beta");
      run();
      await waitFor(() => expect(onSelectProject).toHaveBeenCalledWith("cp_beta"));
    });

    it("goes back to the previous project via appNav without docked", async () => {
      const onSelectProject = vi.fn();
      render(
        <CanvasNlCommandBar
          runCommand={vi.fn()}
          nodes={[]}
          cwd="/repo"
          callModel={vi.fn()}
          appNav={{ ...appNav, onSelectProject }}
        />,
      );
      type("go back to the previous project");
      run();
      await waitFor(() => expect(onSelectProject).toHaveBeenCalledWith("cp_beta"));
    });

    it("opens settings from a typed NL command via appNav without docked", async () => {
      const onOpenSettings = vi.fn();
      render(
        <CanvasNlCommandBar
          runCommand={vi.fn()}
          nodes={[]}
          cwd="/repo"
          callModel={vi.fn()}
          appNav={{ ...appNav, onOpenSettings }}
        />,
      );
      type("open settings");
      run();
      await waitFor(() => expect(onOpenSettings).toHaveBeenCalledTimes(1));
    });

    it("closes a named project after confirmation via appNav without docked", async () => {
      const onCloseProject = vi.fn();
      render(
        <CanvasNlCommandBar
          runCommand={vi.fn()}
          nodes={[]}
          cwd="/repo"
          callModel={vi.fn()}
          appNav={{ ...appNav, onCloseProject }}
        />,
      );
      type("close project beta");
      run();
      const confirm = await screen.findByRole("button", { name: "Confirm" });
      expect(onCloseProject).not.toHaveBeenCalled();
      fireEvent.click(confirm);
      await waitFor(() => expect(onCloseProject).toHaveBeenCalledWith("cp_beta"));
    });

    it("prefers docked over appNav when both are provided", async () => {
      const dockedSelect = vi.fn();
      const appNavSelect = vi.fn();
      render(
        <CanvasNlCommandBar
          runCommand={vi.fn()}
          nodes={[]}
          cwd="/repo"
          callModel={vi.fn()}
          docked={{ ...appNav, onSelectProject: dockedSelect }}
          appNav={{ ...appNav, onSelectProject: appNavSelect }}
        />,
      );
      type("switch to project beta");
      run();
      await waitFor(() => expect(dockedSelect).toHaveBeenCalledWith("cp_beta"));
      expect(appNavSelect).not.toHaveBeenCalled();
    });

    it("without appNav or docked, an app-level NL command reports it is not available here", async () => {
      const runCommand = vi.fn();
      render(<CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" callModel={vi.fn()} />);
      type("open settings");
      run();
      await screen.findByText(/not available/i);
    });
  });
});

// The Composer Target: where Enter goes, said before it is pressed. It is the router's fast path on
// what is in the field now — the cases are unit-tested in services/voice/__tests__/composer-target.test.ts;
// these cover the wiring: it follows typing and transcribed words, and the old "Dictating to…" chip is gone.
describe("CanvasNlCommandBar — Composer Target", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const focusedSkye = { id: "a-skye", type: "agent", position: { x: 0, y: 0 }, selected: true, data: { name: "Skye" } } as any;

  /** Open the mic for real (through beginVoice) so the capture's mic-open context is published. */
  async function openMic() {
    sttMock.start.mockImplementation(async () => {
      sttMock.recording = true;
      return true;
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Dictate"));
    });
  }

  const target = () => document.querySelector(".canvas-nl-target");

  it("names the focused agent for prose, and Lotus for a canvas command", () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    expect(target()).toHaveTextContent("Skye");

    type("look at the failing login tests");
    expect(target()).toHaveTextContent("Skye");

    type("arrange the canvas");
    expect(target()).toHaveTextContent("Lotus");
    expect(target()).not.toHaveTextContent("Skye");
    expect(target()).not.toHaveTextContent("Lotus will decide");
  });

  it("says Lotus will decide when the fast path cannot place the text", () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(target()).toHaveTextContent("Lotus");
    expect(target()).not.toHaveTextContent("Lotus will decide");

    type("Skye, look at the failing login tests");
    // Named in the words, but nothing resolved it: the bar does not guess Skye.
    expect(target()).toHaveTextContent("Lotus will decide");
    expect(target()).not.toHaveTextContent("Skye");
  });

  it("follows the words as they are transcribed", async () => {
    const { rerender } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    await openMic();
    expect(target()).toHaveTextContent("Skye");

    sttMock.interim = "arrange the canvas";
    rerender(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    expect(target()).toHaveTextContent("Lotus");
  });

  it("keeps the agent it had when the mic opened, wherever focus goes", async () => {
    const { rerender } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    await openMic();

    rerender(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[{ ...focusedSkye, selected: false }]} cwd="/repo" />);
    expect(target()).toHaveTextContent("Skye");
  });

  it("no longer predicts the turn in the listening copy", async () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    await openMic();

    // The listening row replaces the field while the mic is open; silence so far draws the waveform.
    expect(document.querySelector(".ws-composer-live .ws-voice-wave")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Listening…");
    expect(screen.queryByText(/Dictating to/)).toBeNull();
    expect(screen.getByLabelText("Stop dictating")).toBeInTheDocument();
  });

  it("returns to the neutral prompt once the capture is cancelled", async () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    await openMic();

    await act(async () => {
      fireEvent.keyDown(document.querySelector(".canvas-nl-bar")!, { key: "Escape" });
    });
    sttMock.recording = false;

    await waitFor(() =>
      expect(screen.getByLabelText("Natural-language command")).toHaveAttribute("placeholder", "Ask or command…"),
    );
  });
});

// Escape used to reach the capture only while the bar itself had focus. Everywhere else on the
// canvas it died before the window listener: xterm calls stopPropagation() on every key it handles,
// and a focused agent node — the dictation target — is exactly a focused xterm.
describe("CanvasNlCommandBar — Escape cancels dictation from anywhere", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const focusedSkye = { id: "a-skye", type: "agent", position: { x: 0, y: 0 }, selected: true, data: { name: "Skye" } } as any;

  async function openMic() {
    sttMock.start.mockImplementation(async () => {
      sttMock.recording = true;
      return true;
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Dictate"));
    });
  }

  /** Stands in for xterm: swallows keydown exactly the way `Terminal.cancel` does. */
  function mountTerminalLikeTarget() {
    const el = document.createElement("div");
    el.tabIndex = -1;
    el.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    document.body.appendChild(el);
    return el;
  }

  it("cancels a dictation while a terminal-like node holds the caret", async () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    await openMic();
    expect(document.querySelector(".ws-composer-live")).toBeInTheDocument();

    const terminal = mountTerminalLikeTarget();
    terminal.focus();
    await act(async () => {
      terminal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      sttMock.recording = false;
    });

    expect(sttMock.cancel).toHaveBeenCalled();
    await screen.findByText("Voice input cancelled.");
    terminal.remove();
  });

  it("still cancels from the bar itself", async () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    await openMic();

    await act(async () => {
      fireEvent.keyDown(document.querySelector(".canvas-nl-bar")!, { key: "Escape" });
      sttMock.recording = false;
    });

    expect(sttMock.cancel).toHaveBeenCalled();
  });

  it("does not touch Escape when the mic is closed", async () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);

    const terminal = mountTerminalLikeTarget();
    terminal.focus();
    await act(async () => {
      terminal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });

    expect(sttMock.cancel).not.toHaveBeenCalled();
    terminal.remove();
  });
});

describe("CanvasNlCommandBar — the merged ⌘K sheet", () => {
  // The integration the merge is FOR: one input, one catalog, one Enter. The sheet's own rules are
  // covered in useCanvasCommandSheet.test.tsx; these assert that it is actually wired to this bar —
  // reading its text, hanging off it, and dispatching through the same runCommand.
  const bar = () => screen.getByLabelText("Natural-language command");
  const cmdK = () => act(() => { fireEvent.keyDown(window, { key: "k", metaKey: true }); });

  it("opens the sheet inside the bar on ⌘K, with the bar keeping focus", () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(screen.queryByRole("listbox", { name: "Canvas commands" })).toBeNull();
    cmdK();
    const list = screen.getByRole("listbox", { name: "Canvas commands" });
    expect(list).toBeInTheDocument();
    // Hangs off the bar itself, not a fixed overlay — that is what makes it track the bar's
    // width, position and docked layout with no anchor maths.
    expect(list.closest(".canvas-nl-bar")).not.toBeNull();
    // ⌘K focuses the input it belongs to. There is no second input any more.
    expect(document.activeElement).toBe(bar());
    // And it is NOT the old modal.
    expect(screen.queryByRole("dialog", { name: /command palette/i })).toBeNull();
  });

  it("filters the sheet from the bar's own text — the query is never held twice", () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    type("create note");
    expect(screen.getByRole("option", { name: /Create Note/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Create Team/ })).toBeNull();
  });

  it("runs a sheet row through the same runCommand, with no model call", () => {
    const runCommand = vi.fn();
    const callModel = vi.fn(async () => { throw new Error("a sheet row must not reach the planner"); });
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" callModel={callModel} />);
    type("create note");
    fireEvent.keyDown(bar(), { key: "ArrowDown" });
    fireEvent.keyDown(bar(), { key: "Enter" });
    expect(runCommand).toHaveBeenCalledWith({ kind: "create-node", nodeType: "note" });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("leaves the NL pipeline in charge of Enter while no row is selected", async () => {
    // The bar's primary job. "add a terminal" opens the sheet (it matches Create Terminal), and
    // Enter must STILL go through the NL path — see the advisory contract in useCanvasCommandSheet.
    const runCommand = vi.fn();
    const callModel = vi.fn(async () => '{"action":"create_node","nodeType":"terminal"}');
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" callModel={callModel} />);
    type("add a terminal");
    expect(screen.getByRole("listbox", { name: "Canvas commands" })).toBeInTheDocument();
    run();
    await screen.findByText("Create a terminal node");
    expect(runCommand).toHaveBeenCalledWith({ kind: "create-node", nodeType: "terminal", focus: true });
  });

  it("marks the input as a combobox pointing at the active row", () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    cmdK();
    expect(bar()).toHaveAttribute("role", "combobox");
    expect(bar()).toHaveAttribute("aria-expanded", "true");
    const active = screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")!;
    expect(bar()).toHaveAttribute("aria-activedescendant", active.id);
  });

  it("closes the sheet on Escape without clearing what was typed", () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    type("create note");
    expect(screen.getByRole("listbox", { name: "Canvas commands" })).toBeInTheDocument();
    fireEvent.keyDown(bar(), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Canvas commands" })).toBeNull();
    expect((bar() as HTMLTextAreaElement).value).toBe("create note");
  });
});

// Push-to-Talk session (LOT2-177, ADR-0053): one turn at a time, every async branch is abortable and
// checks it is still current, and a failing submit is shown — never an unhandled rejection.
describe("CanvasNlCommandBar — Push-to-Talk session guards", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectedNote = { id: "n1", type: "note", position: { x: 0, y: 0 }, selected: true, data: { name: "Spec" } } as any;

  it("two fast Enters run a typed rewrite once", async () => {
    const replaceSelection = vi.fn();
    const off = noteSelectionRegistry.register("n1", { getSelectedText: () => "milk eggs bread", replaceSelection });
    const rewritten = deferred<string>();
    const callModel = vi.fn(() => rewritten.promise);
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[selectedNote]} cwd="/repo" callModel={callModel} />);
    type("turn this into a bulleted list");
    // Both key presses land before React re-renders — render-time `busy` cannot stop the second.
    act(() => {
      run();
      run();
    });
    await act(async () => {
      rewritten.resolve("- milk\n- eggs\n- bread");
    });
    await waitFor(() => expect(replaceSelection).toHaveBeenCalledTimes(1));
    expect(callModel).toHaveBeenCalledTimes(1);
    off();
  });

  it("the refused second Enter says the last command is still running", () => {
    const off = noteSelectionRegistry.register("n1", { getSelectedText: () => "milk eggs bread", replaceSelection: vi.fn() });
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[selectedNote]} cwd="/repo" callModel={() => new Promise<string>(() => {})} />);
    type("turn this into a bulleted list");
    act(() => {
      run();
      run();
    });
    expect(screen.getByText("Still working on the last command — try again in a moment.")).toBeInTheDocument();
    off();
  });

  it("a new recording aborts a running rewrite; its late result never touches the note", async () => {
    const replaceSelection = vi.fn();
    const off = noteSelectionRegistry.register("n1", { getSelectedText: () => "milk eggs bread", replaceSelection });
    const rewritten = deferred<string>();
    const callModel = vi.fn((_prompt: string, _schema?: unknown, _opts?: { signal?: AbortSignal }) => rewritten.promise);
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[selectedNote]} cwd="/repo" callModel={callModel} />);
    type("turn this into a bulleted list");
    run();
    await waitFor(() => expect(callModel).toHaveBeenCalled());
    const signal = callModel.mock.calls[0][2]?.signal;
    expect(signal?.aborted).toBe(false);

    sttMock.start.mockResolvedValueOnce(true);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Dictate"));
    });
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      rewritten.resolve("- milk\n- eggs\n- bread");
    });
    expect(replaceSelection).not.toHaveBeenCalled();
    off();
  });

  it("Escape while a rewrite still runs aborts it; the note is left alone", async () => {
    const replaceSelection = vi.fn();
    const off = noteSelectionRegistry.register("n1", { getSelectedText: () => "milk eggs bread", replaceSelection });
    const rewritten = deferred<string>();
    const callModel = vi.fn((_prompt: string, _schema?: unknown, _opts?: { signal?: AbortSignal }) => rewritten.promise);
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[selectedNote]} cwd="/repo" callModel={callModel} />);
    type("turn this into a bulleted list");
    run();
    await waitFor(() => expect(callModel).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByLabelText("Natural-language command"), { key: "Escape" });
    expect(callModel.mock.calls[0][2]?.signal?.aborted).toBe(true);
    await act(async () => {
      rewritten.resolve("- milk\n- eggs\n- bread");
    });
    expect(replaceSelection).not.toHaveBeenCalled();
    off();
  });

  it("text typed before the mic opened survives the turn: shown while listening, back after", async () => {
    const runCommand = vi.fn();
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" callModel={vi.fn()} />);
    type("arrange the canvas");
    sttMock.start.mockResolvedValueOnce(true);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Dictate"));
    });
    // The field gives way to the listening row, which shows what was typed — nothing can be sent now.
    expect(screen.queryByLabelText("Natural-language command")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(document.querySelector(".ws-composer-live")).toHaveTextContent("arrange the canvas");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(await screen.findByLabelText("Natural-language command")).toHaveValue("arrange the canvas");
  });

  it("a command that throws is shown in the bar, and the bar accepts the next command", async () => {
    const runCommand = vi.fn(() => {
      throw new Error("canvas is locked");
    });
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" callModel={vi.fn()} />);
    type("arrange the canvas");
    run();
    expect(await screen.findByText(/canvas is locked/)).toBeInTheDocument();

    runCommand.mockImplementation(() => undefined as never);
    type("arrange the canvas");
    run();
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(2));
  });
});

// Ticket 08 (plans/composer-voice-ux): the Canvas bar draws the same voice slot and listening row as
// the Code composer — mic always, Live Voice while the field is empty, Send once there is text.
describe("CanvasNlCommandBar — shared voice slot and listening row", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const focusedSkye = { id: "a-skye", type: "agent", position: { x: 0, y: 0 }, selected: true, data: { name: "Skye" } } as any;

  async function openMic() {
    sttMock.start.mockImplementation(async () => {
      sttMock.recording = true;
      return true;
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    });
  }

  it("offers the mic and Live Voice on an empty bar, with nothing to send", () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(screen.getByRole("button", { name: "Dictate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Live Voice" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("swaps Live Voice for Send once there is text, and keeps the mic", () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    type("arrange the canvas");
    expect(screen.getByRole("button", { name: "Dictate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Live Voice" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("Send runs what is typed, the way Enter does", async () => {
    const runCommand = vi.fn();
    render(<CanvasNlCommandBar runCommand={runCommand} nodes={[]} cwd="/repo" callModel={vi.fn()} />);
    type("arrange the canvas");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith({ kind: "arrange-layout" }));
  });

  it("the Live Voice button starts Canvas Live Voice", () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    fireEvent.click(screen.getByRole("button", { name: "Live Voice" }));
    expect(liveMock.start).toHaveBeenCalledTimes(1);
  });

  it("the mic looks unavailable, not hidden, without a voice provider", () => {
    sttMock.available = false;
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(screen.getByRole("button", { name: "Dictate" })).toHaveAttribute("data-unavailable", "true");
  });

  it("while listening: cancel, the live row and stop — no key-hint line under the bar", async () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    await openMic();
    expect(screen.getByRole("button", { name: "Cancel dictation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop dictating" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Live Voice" })).toBeNull();
    expect(screen.queryByText(/to finish/)).toBeNull();
    // The target still says where the words go.
    expect(document.querySelector(".canvas-nl-target")).toHaveTextContent("Skye");
  });

  it("shows the words as they are heard, after what was typed", async () => {
    const { rerender } = render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    type("also");
    await openMic();
    sttMock.interim = "check the login tests";
    rerender(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    const row = document.querySelector(".ws-composer-live");
    expect(row).toHaveTextContent("also check the login tests");
  });

  it("the ✕ drops the turn", async () => {
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
    await openMic();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    });
    expect(sttMock.cancel).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toBeInTheDocument());
  });

  it("⌘Enter while listening finishes the turn and sends it, whatever Send Right Away says", async () => {
    setVoiceInputSetting("sendRightAway", false);
    setVoiceInputSetting("polish", false);
    agentStatusRegistry.publish({ id: "a-skye", name: "Skye", status: "running" });
    const sendReply = vi.fn(async () => {});
    const unregister = agentReplyRegistry.register("a-skye", { canReply: () => true, accepts: () => true, sendReply });
    sttMock.stop.mockImplementation(async () => {
      sttMock.recording = false;
      return "fix the auth bug in the login flow";
    });
    try {
      render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[focusedSkye]} cwd="/repo" />);
      await openMic();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, ctrlKey: true, cancelable: true }));
      });
      await waitFor(() => expect(sendReply).toHaveBeenCalledWith("fix the auth bug in the login flow"));
    } finally {
      unregister();
    }
  });
});

describe("CanvasNlCommandBar — Live Voice as a composer state", () => {
  /** Starts a session the way the controller reports one: active, then connected. */
  // A fresh element per render: re-rendering the same element object lets React skip the bar.
  type Bar = () => React.ReactElement;
  function goLive(rerender: (ui: React.ReactElement) => void, ui: Bar, phase = "listening") {
    liveMock.active = true;
    liveMock.phase = phase;
    rerender(ui());
  }

  function endLive(rerender: (ui: React.ReactElement) => void, ui: Bar) {
    liveMock.active = false;
    liveMock.phase = "closed";
    rerender(ui());
  }

  it("becomes the Live Voice state: → Lotus, the status line and End, with no field", () => {
    liveMock.active = true;
    liveMock.phase = "listening";
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(screen.queryByLabelText("Natural-language command")).toBeNull();
    expect(screen.getByTitle("Lotus")).toHaveTextContent("Lotus");
    expect(screen.getByText("Listening…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "End Live Voice" }));
    expect(liveMock.stop).toHaveBeenCalledTimes(1);
  });

  it("says barge-in works while Lotus speaks", () => {
    liveMock.active = true;
    liveMock.phase = "agent";
    liveMock.agentSpeaking = true;
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(screen.getByText("Lotus is speaking — talk to interrupt")).toBeInTheDocument();
  });

  it("shows a reconnect in the status line", () => {
    liveMock.active = true;
    liveMock.phase = "reconnecting";
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(screen.getByText("Connection dropped — reconnecting…")).toBeInTheDocument();
  });

  it("an error offers Retry and a way back to the bar", () => {
    liveMock.active = true;
    liveMock.phase = "error";
    liveMock.error = "Provider rejected the key";
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    expect(screen.getByText("Provider rejected the key")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry Live Voice" }));
    expect(liveMock.start).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close Live Voice" }));
    expect(liveMock.stop).toHaveBeenCalledTimes(1);
  });

  it("the strip shows the turns, their tool lines, the provider and a timer", () => {
    liveMock.active = true;
    liveMock.phase = "listening";
    liveMock.strip = {
      turns: [
        {
          turn: 1,
          lines: [
            { key: "you:u1", kind: "you", text: "Spawn a reviewer", final: true },
            { key: "tool:0", kind: "tool", text: "spawn_agent · Reviewer", ok: true },
            { key: "lotus:a1", kind: "lotus", text: "Reviewer is up.", final: true },
          ],
        },
      ],
      actions: 1,
      seq: 1,
    };
    render(<CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />);
    const strip = screen.getByRole("log", { name: "Live Voice conversation" });
    expect(strip).toHaveTextContent("Spawn a reviewer");
    expect(strip).toHaveTextContent("spawn_agent · Reviewer");
    expect(strip).toHaveTextContent("Reviewer is up.");
    expect(strip).toHaveTextContent("Grok");
    expect(strip).toHaveTextContent("0:00");
  });

  it("after End: one summary line that can be dismissed", () => {
    const ui = () => <CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />;
    const { rerender } = render(ui());
    goLive(rerender, ui);
    liveMock.strip = { turns: [], actions: 2, seq: 2 };
    rerender(ui());
    endLive(rerender, ui);
    expect(screen.getByText("Live Voice · 2 actions · 0:00")).toBeInTheDocument();
    expect(screen.queryByRole("log", { name: "Live Voice conversation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Live Voice summary" }));
    expect(screen.queryByText(/Live Voice · 2 actions/)).toBeNull();
  });

  it("the summary hides itself after 8 s", () => {
    vi.useFakeTimers();
    try {
      const ui = () => <CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />;
      const { rerender } = render(ui());
      goLive(rerender, ui);
      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      endLive(rerender, ui);
      expect(screen.getByText("Live Voice · 0 actions · 1:05")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(8_000);
      });
      expect(screen.queryByText(/Live Voice · 0 actions/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the next send hides the summary", () => {
    const ui = () => <CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" callModel={vi.fn()} />;
    const { rerender } = render(ui());
    goLive(rerender, ui);
    endLive(rerender, ui);
    expect(screen.getByText(/Live Voice · 0 actions/)).toBeInTheDocument();
    type("arrange the canvas");
    run();
    expect(screen.queryByText(/Live Voice · 0 actions/)).toBeNull();
  });

  it("stashes typed text when Live Voice starts and restores it on End", () => {
    const ui = () => <CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />;
    const { rerender } = render(ui());
    type("half a thought");
    goLive(rerender, ui, "connecting");
    endLive(rerender, ui);
    expect(screen.getByLabelText("Natural-language command")).toHaveValue("half a thought");
  });

  it("Retry starts the timer again, and time on the error screen is not counted", () => {
    vi.useFakeTimers();
    try {
      const ui = () => <CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />;
      const { rerender } = render(ui());
      goLive(rerender, ui);
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      goLive(rerender, ui, "error");
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      // Retry: straight from the error to a new connection, never inactive in between.
      goLive(rerender, ui, "connecting");
      goLive(rerender, ui, "listening");
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      goLive(rerender, ui, "error");
      act(() => {
        vi.advanceTimersByTime(40_000);
      });
      endLive(rerender, ui);
      expect(screen.getByText("Live Voice · 0 actions · 0:05")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a session that never connected leaves no summary", () => {
    const ui = () => <CanvasNlCommandBar runCommand={vi.fn()} nodes={[]} cwd="/repo" />;
    const { rerender } = render(ui());
    goLive(rerender, ui, "connecting");
    endLive(rerender, ui);
    expect(screen.queryByText(/Live Voice ·/)).toBeNull();
  });
});
