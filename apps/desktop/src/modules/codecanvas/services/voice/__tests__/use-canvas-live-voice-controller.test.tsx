import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { evaluateDelegationFidelity } from "../delegation-fidelity";
import { useCanvasLiveVoiceController } from "../use-canvas-live-voice-controller";
import { S2S_TRANSCRIPT_INITIAL_WAIT_MS } from "../s2s-transcript-wait-queue";
import { DELEGATION_FIDELITY_FIXTURES } from "./fixtures/delegation-fidelity-fixtures";

interface CapturedToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

interface CapturedLiveOptions {
  instructions?: string;
  onTranscript?: (
    text: string,
    isFinal: boolean,
    meta: { speaker?: "user" | "agent"; itemId?: string; cumulative?: boolean; turn: number },
  ) => void;
  onUserTranscriptProgress?: (text: string, isFinal: boolean) => void;
  onFinalUserTranscript?: (text: string) => void;
  onAgentFinalTranscript?: () => void;
  onConciergeAction?: (action: unknown, call: CapturedToolCall) => unknown | Promise<unknown>;
}

const harness = vi.hoisted(() => ({
  instructions: "",
  liveOptions: null as CapturedLiveOptions | null,
  executedCall: null as CapturedToolCall | null,
  runtimeDispatchAgentId: null as string | null,
  sentMessages: [] as Array<{ target: string; text: string }>,
  sendResult: { delivered: [] as string[], queued: [] as string[], skipped: [] as string[] },
  deliveryCompletion: Promise.resolve([] as Array<{ agentId: string; state: "written" | "queued" | "failed" }>),
}));

vi.mock("@/lib/agent-naming", () => ({ currentNamePool: () => ["Skye"] }));

vi.mock("../../../hooks/useCanvasBehaviorSettings", () => ({
  useCanvasBehaviorSettings: () => ({ voiceAutoCloseAfterCommand: false }),
}));

vi.mock("@/lib/hooks/useTtsProviderRegistry", () => ({
  useTtsProviderRegistry: () => ({
    registry: { output: { verbosity: "expressive" } },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../agent-status-registry", () => ({
  agentStatusRegistry: { list: () => [] },
}));

vi.mock("../../canvas-agent-messaging", () => ({
  createAgentMessagingDeps: () => ({}),
  sendAgentMessage: (target: string, text: string) => {
    harness.sentMessages.push({ target, text });
    return harness.sendResult;
  },
  sendAgentMessageTracked: (target: string, text: string) => {
    harness.sentMessages.push({ target, text });
    return {
      ...harness.sendResult,
      initial: harness.sendResult.queued.map((agentId) => ({ agentId, state: "queued" })),
      completion: harness.deliveryCompletion,
    };
  },
}));

vi.mock("../s2s-canvas-tool-executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../s2s-canvas-tool-executor")>();
  return {
    ...actual,
    executeS2sCanvasToolCall: (
      call: CapturedToolCall,
      _context: unknown,
      deps: { dispatch?: (agentId: string, message: string) => unknown },
    ) => {
      harness.executedCall = call;
      if (harness.runtimeDispatchAgentId) {
        deps.dispatch?.(harness.runtimeDispatchAgentId, String(call.args.task ?? ""));
      }
      return { ok: true, summary: "Dispatch to Codex", speak: "Sent to Codex." };
    },
  };
});

vi.mock("../use-command-bar-live-voice", () => ({
  useCommandBarLiveVoice: (options: CapturedLiveOptions) => {
    harness.instructions = options.instructions ?? "";
    harness.liveOptions = options;
    return {
      available: true,
      active: false,
      phase: "idle",
      turn: 1,
      agentSpeaking: false,
      health: {},
      start: vi.fn(),
      stop: vi.fn(),
      interrupt: vi.fn(),
    };
  },
}));

describe("useCanvasLiveVoiceController", () => {
  beforeEach(() => {
    harness.instructions = "";
    harness.liveOptions = null;
    harness.executedCall = null;
    harness.runtimeDispatchAgentId = null;
    harness.sentMessages = [];
    harness.sendResult = { delivered: [], queued: [], skipped: [] };
    harness.deliveryCompletion = Promise.resolve([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records the conversation and each tool call for the Live Voice strip", async () => {
    const { result } = renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );
    act(() => {
      harness.liveOptions?.onTranscript?.("Open the board", true, { speaker: "user", itemId: "u1", turn: 1 });
      harness.liveOptions?.onTranscript?.("On it.", true, { speaker: "agent", itemId: "a1", turn: 1 });
    });
    await act(async () => {
      await harness.liveOptions?.onConciergeAction?.(undefined, { callId: "c1", name: "focus", args: { target: "Board" } });
    });
    expect(result.current.strip.turns).toEqual([
      {
        turn: 1,
        lines: [
          expect.objectContaining({ kind: "you", text: "Open the board" }),
          expect.objectContaining({ kind: "lotus", text: "On it." }),
          expect.objectContaining({ kind: "tool", text: "Dispatch to Codex", ok: true }),
        ],
      },
    ]);
    expect(result.current.strip.actions).toBe(1);
  });

  it("applies the persisted expressive Voice preference to realtime instructions", () => {
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );

    expect(harness.instructions).toContain("Evidence-bearing results: up to 5 sentences");
  });

  it("applies the persisted Speak-style persona to realtime instructions", () => {
    // The registry mock sets no `tone`, so this exercises the default (jarvis) persona — the
    // register a user hears without ever opening the setting.
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );

    expect(harness.instructions).toContain("poised, courteous AI valet");
  });

  it("keeps an exact social message out of structured delegation", async () => {
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );
    const exactMessage = "Halo Skye, semoga harimu menyenangkan.";

    await act(async () => {
      harness.liveOptions?.onFinalUserTranscript?.(
        "Sampaikan salam yang hangat ke Skye dan bilang: Halo Skye, semoga harimu menyenangkan.",
      );
      await harness.liveOptions?.onConciergeAction?.(
        {},
        {
          callId: "social-1",
          name: "dispatch",
          args: { target: "Skye", task: exactMessage },
        },
      );
    });

    expect(harness.executedCall?.args.task).toBe(exactMessage);
  });

  it("holds a risky dispatch for a spoken yes, then sends what was asked about, not the yes", async () => {
    renderHook(() => useCanvasLiveVoiceController({ nodes: [], cwd: "/repo", runCommand: vi.fn(), runApp: vi.fn(), setTrace: vi.fn() }));
    let asked: unknown;
    await act(async () => {
      harness.liveOptions?.onFinalUserTranscript?.("Ask Codex to push the branch to main.");
      asked = await harness.liveOptions?.onConciergeAction?.({}, { callId: "r1", name: "dispatch", args: { target: "Codex", task: "Push the branch to main.", risky: "high" } });
    });
    expect(asked).toMatchObject({ ok: true, speak: expect.stringMatching(/^That asks Codex to push: .*Should I send it\?$/) });
    expect(harness.executedCall).toBeNull();

    await act(async () => {
      harness.liveOptions?.onFinalUserTranscript?.("Ya.");
      await harness.liveOptions?.onConciergeAction?.({}, { callId: "r2", name: "dispatch", args: { target: "Codex", task: "yes", confirm: true } });
    });
    expect(String(harness.executedCall?.args.task)).toMatch(/push the branch to main/i);
    expect(String(harness.executedCall?.args.task)).not.toMatch(/\bya\b/i);
  });

  it("sends a safe dispatch without asking", async () => {
    renderHook(() => useCanvasLiveVoiceController({ nodes: [], cwd: "/repo", runCommand: vi.fn(), runApp: vi.fn(), setTrace: vi.fn() }));
    await act(async () => {
      harness.liveOptions?.onFinalUserTranscript?.("Ask Codex to write a short poem.");
      await harness.liveOptions?.onConciergeAction?.({}, { callId: "s1", name: "dispatch", args: { target: "Codex", task: "Write a short poem.", risky: "none" } });
    });
    expect(harness.executedCall).not.toBeNull();
  });

  it("accumulates split VAD segments: two final transcripts then a dispatch compiles with both segments joined", async () => {
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );

    await act(async () => {
      harness.liveOptions?.onFinalUserTranscript?.("Ask Codex to review auth.ts");
      harness.liveOptions?.onFinalUserTranscript?.("and report the top five issues.");
      await harness.liveOptions?.onConciergeAction?.(
        {},
        {
          callId: "dispatch-split",
          name: "dispatch",
          args: { target: "Codex", task: "Review auth.ts." },
        },
      );
    });

    // Both segments merge, and the relay frame ("Ask Codex to") is stripped locally — the reading
    // agent must not see itself described in third person. No model is configured here, so this is
    // purely the deterministic de-framing layer.
    const deliveredText = String(harness.executedCall?.args.task ?? "");
    expect(deliveredText).toBe("review auth.ts and report the top five issues.");
  });

  // The structured path skips the compose REWRITE by design (the capture is known incomplete), but
  // de-framing is deterministic and model-free — skipping it too left the relay frame in the one place
  // the agent is most likely to be confused by it.
  it("de-frames a cut-off capture too, and keeps the caveat that says it was cut off", async () => {
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );

    await act(async () => {
      harness.liveOptions?.onFinalUserTranscript?.("Ask Codex to review auth.ts and package.json and");
      await harness.liveOptions?.onConciergeAction?.(
        {},
        {
          callId: "dispatch-cutoff",
          name: "dispatch",
          args: { target: "Codex", intent: "Review auth.ts." },
        },
      );
    });

    const deliveredText = String(harness.executedCall?.args.task ?? "");
    expect(deliveredText).toContain("review auth.ts and package.json and");
    expect(deliveredText).not.toContain("Ask Codex to");
    expect(deliveredText).toContain("may have been cut off at the end");
  });

  it("an uninterrupted agent reply starts a new turn: final transcript -> onAgentFinalTranscript() -> next final transcript replaces, dispatch compiles with only the new segment", async () => {
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );
    const nextTurnTask = "Inspect package.json.";

    expect(harness.liveOptions?.onAgentFinalTranscript).toBeTypeOf("function");
    await act(async () => {
      harness.liveOptions?.onFinalUserTranscript?.(DELEGATION_FIDELITY_FIXTURES[0].transcript);
      harness.liveOptions?.onAgentFinalTranscript?.(); // the agent spoke a full, uninterrupted reply
      harness.liveOptions?.onFinalUserTranscript?.(nextTurnTask);
      await harness.liveOptions?.onConciergeAction?.(
        {},
        {
          callId: "dispatch-next-turn",
          name: "dispatch",
          args: { target: "Codex", task: nextTurnTask },
        },
      );
    });

    const deliveredText = String(harness.executedCall?.args.task ?? "");
    expect(deliveredText).toContain(nextTurnTask);
    expect(deliveredText).not.toContain(DELEGATION_FIDELITY_FIXTURES[0].transcript);
  });

  it("grace-waits for a late final transcript: dispatch arrives first, transcript resolves 300ms later, compiled task contains the verbatim transcript, not the paraphrase marker", async () => {
    vi.useFakeTimers();
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );
    const transcript = "Audit auth.ts for missing input validation.";

    const dispatchDone = harness.liveOptions?.onConciergeAction?.(
      {},
      {
        callId: "dispatch-late-transcript",
        name: "dispatch",
        args: { target: "Codex", intent: "Audit auth.ts." },
      },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
      harness.liveOptions?.onFinalUserTranscript?.(transcript);
      await dispatchDone;
    });
    vi.useRealTimers();

    const deliveredText = String(harness.executedCall?.args.task ?? "");
    expect(deliveredText).toContain(transcript);
    expect(deliveredText).not.toContain(
      "Objective (paraphrased from speech — verbatim transcript unavailable)",
    );
  });

  it("extends the short transcript wait while partial STT is still progressing", async () => {
    vi.useFakeTimers();
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );
    const transcript = "Kirim hasil audit auth.ts ke Atlas.";
    const dispatchDone = harness.liveOptions?.onConciergeAction?.(
      {},
      {
        callId: "dispatch-progressing-transcript",
        name: "dispatch",
        args: { target: "Atlas", intent: "Audit auth.ts." },
      },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(S2S_TRANSCRIPT_INITIAL_WAIT_MS - 100);
      harness.liveOptions?.onUserTranscriptProgress?.("Kirim hasil audit", false);
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(harness.executedCall).toBeNull();

    await act(async () => {
      harness.liveOptions?.onFinalUserTranscript?.(transcript);
      await dispatchDone;
    });

    expect(String(harness.executedCall?.args.task ?? "")).toContain(transcript);
  });

  it("consumes the buffer after a dispatch: a second dispatch without new speech falls back to paraphrase mode", async () => {
    vi.useFakeTimers();
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );

    await act(async () => {
      harness.liveOptions?.onFinalUserTranscript?.(DELEGATION_FIDELITY_FIXTURES[0].transcript);
      await harness.liveOptions?.onConciergeAction?.(
        {},
        {
          callId: "dispatch-first",
          name: "dispatch",
          args: { target: "Codex", task: "Review auth.ts." },
        },
      );
    });

    const secondDispatch = harness.liveOptions?.onConciergeAction?.(
      {},
      {
        callId: "dispatch-second",
        name: "dispatch",
        args: { target: "Codex", intent: "Now check the tests too." },
      },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(S2S_TRANSCRIPT_INITIAL_WAIT_MS);
      await secondDispatch;
    });
    vi.useRealTimers();

    const deliveredText = String(harness.executedCall?.args.task ?? "");
    expect(deliveredText).toContain("Now check the tests too.");
    expect(deliveredText).toContain("summary of what I said");
    expect(deliveredText).not.toContain("# Delegated voice task");
  });

  it("composes a vague Live dispatch into bare grounded prose — one model call, no envelope", async () => {
    const transcript = "Ask Codex to review this carefully and report the five highest-priority issues.";
    const groundedTask = "Review the selected authentication changes in src/auth.ts and report the five highest-priority issues with file:line evidence.";
    // Typed via the generic so `mock.calls[0][0]` is a string, with no unused parameter binding.
    const callModel = vi.fn<(prompt: string) => Promise<string>>(async () => groundedTask);
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        callModel,
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );

    await act(async () => {
      harness.liveOptions?.onFinalUserTranscript?.(transcript);
      await harness.liveOptions?.onConciergeAction?.(
        {},
        {
          callId: "dispatch-vague",
          name: "dispatch",
          args: { target: "Codex", task: "Review this carefully." },
        },
      );
    });

    expect(callModel).toHaveBeenCalledTimes(1);
    // The composed prose IS the payload — there is no second rendition riding along with it.
    const deliveredText = String(harness.executedCall?.args.task ?? "");
    expect(deliveredText).toBe(groundedTask);
    expect(deliveredText).not.toContain("# Delegated voice task");
    // The one model call is the compose prompt (not the old refine prompt), carrying the raw speech.
    const composePrompt = String(callModel.mock.calls[0]?.[0] ?? "");
    expect(composePrompt).toContain(`Speech: ${transcript}`);
    expect(composePrompt.toLowerCase()).toContain("never summarise");
  });

  it("uses the final user transcript as the authoritative dispatch payload", async () => {
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );
    const fixture = DELEGATION_FIDELITY_FIXTURES[0];

    expect(harness.liveOptions?.onFinalUserTranscript).toBeTypeOf("function");
    harness.liveOptions?.onFinalUserTranscript?.(fixture.transcript);
    await harness.liveOptions?.onConciergeAction?.(
      {},
      {
        callId: "dispatch-1",
        name: "dispatch",
        args: { target: "Codex", task: fixture.deliveredText },
      },
    );

    const deliveredText = String(harness.executedCall?.args.task ?? "");
    const fidelity = evaluateDelegationFidelity({
      transcript: fixture.transcript,
      deliveredText,
      requiredFacts: fixture.requiredFacts,
    });
    expect(fidelity.score).toBe(1);
    expect(fidelity.missing).toEqual([]);
  });

  it("delivers the authoritative prompt to a concrete agent with a truthful receipt", async () => {
    const fixture = DELEGATION_FIDELITY_FIXTURES[0];
    harness.runtimeDispatchAgentId = "agent-codex";
    harness.sendResult = {
      delivered: ["agent-codex"],
      queued: [],
      skipped: [],
    };
    const onCommandDelivery = vi.fn();
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [{
          id: "agent-codex",
          type: "agent",
          position: { x: 0, y: 0 },
          data: { name: "Codex" },
        }],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        onCommandDelivery,
        setTrace: vi.fn(),
      }),
    );

    await act(async () => {
      harness.liveOptions?.onFinalUserTranscript?.(fixture.transcript);
      await harness.liveOptions?.onConciergeAction?.(
        {},
        {
          callId: "dispatch-real-prompt",
          name: "dispatch",
          args: { target: "Codex", task: fixture.deliveredText },
        },
      );
    });

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.target).toBe("agent-codex");
    const fidelity = evaluateDelegationFidelity({
      transcript: fixture.transcript,
      deliveredText: harness.sentMessages[0]?.text ?? "",
      requiredFacts: fixture.requiredFacts,
    });
    expect(fidelity.score).toBe(1);
    expect(fidelity.missing).toEqual([]);
    expect(onCommandDelivery).toHaveBeenCalledWith(expect.objectContaining({
      targetNodeId: "agent-codex",
      outcome: "delivered",
    }));
  });

  it("waits for the concrete agent write receipt before reporting dispatch success", async () => {
    harness.runtimeDispatchAgentId = "agent-codex";
    harness.sendResult = { delivered: ["agent-codex"], queued: [], skipped: [] };
    let finishWrite: (value: Array<{ agentId: string; state: "written" }>) => void = () => {};
    harness.deliveryCompletion = new Promise((resolve) => { finishWrite = resolve; });
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [{
          id: "agent-codex",
          type: "agent",
          position: { x: 0, y: 0 },
          data: { name: "Codex" },
        }],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );

    harness.liveOptions?.onFinalUserTranscript?.("Audit auth.ts and send the prompt to Codex.");
    const action = harness.liveOptions?.onConciergeAction?.(
      {},
      {
        callId: "dispatch-write-receipt",
        name: "dispatch",
        args: { target: "Codex", intent: "Audit auth.ts." },
      },
    );
    let settled = false;
    void Promise.resolve(action).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishWrite([{ agentId: "agent-codex", state: "written" }]);
    await expect(action).resolves.toMatchObject({
      ok: true,
      delivery: "written",
    });
  });

  it("reports queued and failed prompt receipts without claiming delivery", async () => {
    harness.runtimeDispatchAgentId = "agent-codex";
    harness.sendResult = { delivered: [], queued: ["agent-codex"], skipped: [] };
    harness.deliveryCompletion = Promise.resolve([
      { agentId: "agent-codex", state: "queued" },
    ]);
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [{
          id: "agent-codex",
          type: "agent",
          position: { x: 0, y: 0 },
          data: { name: "Codex" },
        }],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );
    harness.liveOptions?.onFinalUserTranscript?.("Send this to Codex.");

    await expect(harness.liveOptions?.onConciergeAction?.(
      {},
      { callId: "dispatch-queued", name: "dispatch", args: { target: "Codex", intent: "Review it." } },
    )).resolves.toMatchObject({
      ok: true,
      queued: true,
      delivery: "queued",
      speak: "The prompt is queued until the agent is ready.",
    });

    harness.sendResult = { delivered: ["agent-codex"], queued: [], skipped: [] };
    harness.deliveryCompletion = Promise.resolve([
      { agentId: "agent-codex", state: "failed" },
    ]);
    harness.liveOptions?.onFinalUserTranscript?.("Try one more prompt.");
    await expect(harness.liveOptions?.onConciergeAction?.(
      {},
      { callId: "dispatch-failed", name: "dispatch", args: { target: "Codex", intent: "Retry it." } },
    )).resolves.toMatchObject({
      ok: false,
      error: "Agent prompt delivery failed.",
    });
  });

  it("delivers the transcript as prose when a final transcript exists, and drops intent from forwarded args", async () => {
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );
    const transcript = "Audit auth.ts and report findings; analysis only, don't change code.";

    await act(async () => {
      harness.liveOptions?.onFinalUserTranscript?.(transcript);
      await harness.liveOptions?.onConciergeAction?.(
        {},
        {
          callId: "dispatch-intent",
          name: "dispatch",
          args: { target: "Codex", intent: "Audit auth.ts.", key_constraints: ["analysis only, don't change code"] },
        },
      );
    });

    // The spoken sentence already states the constraint, so the model's intent label and its extracted
    // key_constraints stay out of the payload — one rendition only.
    const deliveredText = String(harness.executedCall?.args.task ?? "");
    expect(deliveredText).toBe(transcript);
    expect(deliveredText).not.toContain("Objective:");
    expect(deliveredText).not.toContain("- analysis only, don't change code");
    expect(harness.executedCall?.args.intent).toBeUndefined();
    expect(harness.executedCall?.args.key_constraints).toBeUndefined();
  });

  it("paraphrases from intent when no final transcript was recorded (STT race)", async () => {
    renderHook(() =>
      useCanvasLiveVoiceController({
        nodes: [],
        cwd: "/repo",
        runCommand: vi.fn(),
        runApp: vi.fn(),
        setTrace: vi.fn(),
      }),
    );

    await act(async () => {
      await harness.liveOptions?.onConciergeAction?.(
        {},
        {
          callId: "dispatch-race",
          name: "dispatch",
          args: { target: "Codex", intent: "Restart the failing agent." },
        },
      );
    });

    const deliveredText = String(harness.executedCall?.args.task ?? "");
    // Prose, with the approximation flagged as a person would flag it — not a relay envelope.
    expect(deliveredText).toBe(
      "Restart the failing agent.\n\n(Dictated by voice: this is a summary of what I said, not my exact words — ask me if anything is ambiguous.)",
    );
  });

});
