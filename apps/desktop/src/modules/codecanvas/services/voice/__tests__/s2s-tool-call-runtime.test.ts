import { describe, expect, it, vi } from "vitest";
import {
  createS2sToolCallRuntime,
  sanitizeRealtimeToolOutput,
} from "../s2s-tool-call-runtime";
import type { S2sPhase } from "@/modules/voice-core/s2s-session";

function createHarness(phase: S2sPhase = "thinking") {
  const sendToolResult = vi.fn(async () => undefined);
  const handler = vi.fn(async () => ({ ok: true, summary: "Done", speak: "Done." }));
  const updateHealth = vi.fn();
  const markToolStart = vi.fn();
  const markToolEnd = vi.fn();
  const requestGracefulEnd = vi.fn();
  const runtime = createS2sToolCallRuntime({
    getSessionId: () => "sid-1",
    getPhase: () => phase,
    getTurn: () => 2,
    getHandler: () => handler,
    updateHealth,
    markTurnSettled: vi.fn(),
    requestGracefulEnd,
    latencyTracker: { markToolStart, markToolEnd },
    sendToolResult,
  });
  return {
    runtime,
    handler,
    sendToolResult,
    updateHealth,
    markToolStart,
    markToolEnd,
    requestGracefulEnd,
  };
}

describe("S2S tool call runtime", () => {
  it("deduplicates provider call ids and sends one settled continuation", async () => {
    const h = createHarness();
    const call = { callId: "call-1", name: "arrange", args: {} };

    h.runtime.handle(call);
    h.runtime.handle(call);
    h.runtime.markResponseDone();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.sendToolResult).toHaveBeenCalledOnce();
    expect(h.sendToolResult).toHaveBeenCalledWith(
      "sid-1",
      "call-1",
      JSON.stringify({ ok: true, speak: "Done.", summary: "Done" }),
      true,
    );
    expect(h.markToolStart).toHaveBeenCalledWith(2, "call-1");
    expect(h.markToolEnd).toHaveBeenCalledWith("call-1");
  });

  it("rejects stale calls without creating a response while the user has the floor", async () => {
    const h = createHarness("user");

    h.runtime.handle({ callId: "stale", name: "dispatch", args: {} });
    await Promise.resolve();

    expect(h.handler).not.toHaveBeenCalled();
    expect(h.sendToolResult).toHaveBeenCalledWith(
      "sid-1",
      "stale",
      JSON.stringify({
        ok: false,
        error: "Tool call ignored because the user is still speaking.",
      }),
      false,
    );
  });

  it("keeps clarification labels but strips internal candidate ids", () => {
    const output = sanitizeRealtimeToolOutput({
      ok: false,
      error: "Ambiguous",
      clarify: {
        ambiguousName: "Claude",
        question: "Which Claude?",
        candidates: [{ id: "private-node-id", label: "Sena" }],
      },
    });

    expect(output).toEqual({
      ok: false,
      error: "Ambiguous",
      clarify: {
        ambiguousName: "Claude",
        question: "Which Claude?",
        candidates: ["Sena"],
      },
    });
    expect(JSON.stringify(output)).not.toContain("private-node-id");
  });
});
