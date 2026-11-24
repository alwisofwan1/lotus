import { beforeEach, describe, expect, it } from "vitest";
import {
  getS2sVoiceDiagnosticsSnapshot,
  recordS2sVoiceDiagnostic,
  recordS2sVoiceHealthDiagnostic,
  recordS2sVoiceLatencyDiagnostic,
  resetS2sVoiceDiagnosticsForTests,
  stringifyS2sVoiceDiagnostics,
} from "../s2s-voice-diagnostics";

describe("S2S voice diagnostics", () => {
  beforeEach(() => resetS2sVoiceDiagnosticsForTests());

  it("records sanitized trace entries with context version as JSONL", () => {
    recordS2sVoiceDiagnostic(
      { id: "call-1", tool: "dispatch", ok: true, heardTarget: "claude-3", resolvedTarget: "Bima", preview: "review", speak: "I sent that to Bima." },
      7,
      123,
    );

    expect(getS2sVoiceDiagnosticsSnapshot().events[0]).toMatchObject({ contextVersion: 7, resolvedTarget: "Bima" });
    const jsonl = stringifyS2sVoiceDiagnostics();
    expect(jsonl).toContain('"contextVersion":7');
    expect(jsonl).not.toContain("nodeId");
    expect(jsonl).not.toContain("secret");
  });

  it("records sanitized latency milestones without transcripts, ids, or secrets", () => {
    recordS2sVoiceLatencyDiagnostic(
      {
        milestone: "tool-end",
        turn: 4,
        elapsedFromSpeechEndMs: 812.7,
        durationMs: 91.2,
      },
      456,
    );

    const snapshot = getS2sVoiceDiagnosticsSnapshot();
    expect(snapshot.latencyEvents[0]).toEqual({
      kind: "latency",
      at: 456,
      milestone: "tool-end",
      turn: 4,
      elapsedFromSpeechEndMs: 813,
      durationMs: 91,
    });
    const jsonl = stringifyS2sVoiceDiagnostics(snapshot);
    expect(jsonl).toContain('"kind":"latency"');
    expect(jsonl).not.toContain("callId");
    expect(jsonl).not.toContain("transcript");
  });

  it("records sanitized health events in the same copyable JSONL payload", () => {
    recordS2sVoiceHealthDiagnostic(
      {
        socket: "connected",
        mic: "active",
        playback: "playing",
        tools: "ok",
        audioDeltas: 3,
        issue: "  output   recovered  ",
        lastTool: "dispatch",
      },
      456,
    );

    const snapshot = getS2sVoiceDiagnosticsSnapshot();
    expect(snapshot.healthEvents[0]).toMatchObject({ kind: "health", socket: "connected", mic: "active", audioDeltas: 3 });
    const jsonl = stringifyS2sVoiceDiagnostics(snapshot);
    expect(jsonl).toContain('"kind":"health"');
    expect(jsonl).toContain('"issue":"output recovered"');
    expect(jsonl).not.toContain("nodeId");
  });
});
