import { describe, expect, it } from "vitest";
import {
  recordS2sPendingClarification,
  resolveS2sClarificationCall,
  S2S_CHOOSE_TARGET_TOOL,
} from "../s2s-voice-clarification";

describe("S2S voice clarification continuation", () => {
  it("records an ambiguous tool result and continues the original action with the chosen visible target", () => {
    const originalCall = { callId: "call-1", name: "dispatch", args: { target: "Claude", task: "review logging" } };
    const state = recordS2sPendingClarification({}, originalCall, {
      ok: false,
      error: "Multiple agents named Claude",
      speak: "Which Claude — Sena, Nara, or Bima?",
      clarify: {
        ambiguousName: "Claude",
        question: "Which Claude — Sena, Nara, or Bima?",
        candidates: [
          { id: "uid-sena", label: "Sena" },
          { id: "uid-nara", label: "Nara" },
          { id: "uid-bima", label: "Bima" },
        ],
      },
    });

    const resolved = resolveS2sClarificationCall(
      { callId: "call-2", name: "choose_target", args: { target: "Bima" } },
      state,
    );

    expect(resolved).toEqual({
      kind: "execute",
      state: {},
      call: { callId: "call-2", name: "dispatch", args: { target: "Bima", task: "review logging" } },
    });
  });

  it("asks the same question again for an invalid choice without leaking candidate ids", () => {
    const state = recordS2sPendingClarification(
      {},
      { callId: "call-1", name: "focus", args: { target: "Claude" } },
      {
        ok: false,
        error: "Multiple agents named Claude",
        speak: "Which Claude — Sena or Nara?",
        clarify: {
          ambiguousName: "Claude",
          question: "Which Claude — Sena or Nara?",
          candidates: [
            { id: "internal-sena", label: "Sena" },
            { id: "internal-nara", label: "Nara" },
          ],
        },
      },
    );

    const resolved = resolveS2sClarificationCall({ callId: "call-2", name: "choose_target", args: { target: "Ghost" } }, state);

    expect(resolved.kind).toBe("result");
    if (resolved.kind === "result") {
      expect(resolved.result).toMatchObject({ ok: false, speak: "Which Claude — Sena or Nara?" });
      expect(JSON.stringify(resolved.result)).not.toContain("internal-sena");
    }
  });

  it("expires stale pending clarifications instead of executing old actions", () => {
    const state = recordS2sPendingClarification(
      {},
      { callId: "old", name: "dispatch", args: { target: "Claude", task: "review logging" } },
      {
        ok: false,
        error: "Multiple agents named Claude",
        speak: "Which Claude — Sena or Bima?",
        clarify: {
          ambiguousName: "Claude",
          question: "Which Claude — Sena or Bima?",
          candidates: [
            { id: "sena", label: "Sena" },
            { id: "bima", label: "Bima" },
          ],
        },
      },
      1_000,
      10_000,
    );

    const resolved = resolveS2sClarificationCall({ callId: "new", name: "choose_target", args: { target: "Bima" } }, state, 12_000);

    expect(resolved).toMatchObject({
      kind: "result",
      state: {},
      result: { ok: false, speak: "That choice expired — please ask again." },
    });
  });

  it("advertises a small choose_target tool for the realtime model", () => {
    expect(S2S_CHOOSE_TARGET_TOOL).toMatchObject({ name: "choose_target", type: "function" });
    expect(JSON.stringify(S2S_CHOOSE_TARGET_TOOL.parameters)).toContain("target");
  });
});
