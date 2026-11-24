import { beforeEach, describe, expect, it } from "vitest";
import {
  clearVoiceTurnDiagnostics,
  createVoiceTurnId,
  getVoiceTurnDiagnostics,
  getVoiceTurnSupportSnapshot,
  recordVoiceTurnDiagnostic,
  updateVoiceTurnDiagnostic,
  type VoiceTurnMilestone,
} from "../voice-turn-diagnostics";

describe("VoiceTurnDiagnostics", () => {
  beforeEach(() => clearVoiceTurnDiagnostics());

  it("keeps a bounded local turn record with stage text for explicit user diagnostics", () => {
    for (let turn = 1; turn <= 25; turn += 1) {
      recordVoiceTurnDiagnostic({
        provider: "openai",
        model: "gpt-transcribe",
        requestedLanguages: ["id", "en"],
        detectedLanguages: ["id"],
        rawTranscript: `private turn ${turn}`,
        replacementTranscript: `corrected turn ${turn}`,
        finalTranscript: `final turn ${turn}`,
        route: "dictate",
        latencyMs: { transcription: turn, total: turn + 5 },
      }, turn);
    }

    const records = getVoiceTurnDiagnostics();
    expect(records).toHaveLength(20);
    expect(records[0]).toMatchObject({ ordinal: 6, rawTranscript: "private turn 6" });
    expect(records.at(-1)).toMatchObject({ ordinal: 25, detectedLanguages: ["id"] });
  });

  it("patches a locally-correlated turn after first agent output without exporting its turn id", () => {
    const turnId = createVoiceTurnId(() => 1_000);
    recordVoiceTurnDiagnostic({
      turnId,
      provider: "deepgram",
      requestedLanguages: ["id"],
      detectedLanguages: ["id"],
      rawTranscript: "private prompt",
      finalTranscript: "private prompt",
      route: "dictate",
      latencyMs: { transcription: 300, total: 500 },
      milestones: [
        { name: "mic_stop", elapsedMs: 0 },
        { name: "pty_enter_written", elapsedMs: 500 },
      ],
    });

    expect(updateVoiceTurnDiagnostic(turnId, {
      latencyMs: { transcription: 300, total: 760 },
      milestones: [
        { name: "mic_stop", elapsedMs: 0 },
        { name: "pty_enter_written", elapsedMs: 500 },
        { name: "agent_first_output", elapsedMs: 760 },
        { name: "turn_complete", elapsedMs: 760 },
      ],
    })).toBe(true);

    expect(getVoiceTurnDiagnostics()[0]).toMatchObject({
      turnId,
      latencyMs: { transcription: 300, total: 760 },
    });
    const support = JSON.stringify(getVoiceTurnSupportSnapshot());
    expect(support).toContain("agent_first_output");
    expect(support).not.toContain(turnId);
    expect(support).not.toContain("private prompt");
  });

  it("projects a defensive, transcript-free milestone timeline into support diagnostics", () => {
    const milestones: VoiceTurnMilestone[] = [
      { name: "mic_stop", elapsedMs: 0 },
      { name: "stt_final", elapsedMs: 420 },
      { name: "delivery_requested", elapsedMs: 510 },
    ];
    recordVoiceTurnDiagnostic({
      provider: "deepgram",
      requestedLanguages: ["id"],
      detectedLanguages: ["id"],
      rawTranscript: "private instruction",
      finalTranscript: "private instruction",
      route: "dictate",
      latencyMs: { transcription: 420, total: 510 },
      milestones,
    });

    const local = getVoiceTurnDiagnostics();
    milestones[1].elapsedMs = 9_999;
    if (local[0].milestones) local[0].milestones[2].elapsedMs = 9_999;
    const support = getVoiceTurnSupportSnapshot();

    expect(support.turns[0].milestones).toEqual([
      { name: "mic_stop", elapsedMs: 0 },
      { name: "stt_final", elapsedMs: 420 },
      { name: "delivery_requested", elapsedMs: 510 },
    ]);
    expect(JSON.stringify(support)).not.toContain("private instruction");
  });

  it("builds support diagnostics without transcript, audio, context terms, or identifiers", () => {
    recordVoiceTurnDiagnostic({
      provider: "openai",
      model: "gpt-transcribe",
      requestedLanguages: ["id", "en"],
      detectedLanguages: ["id"],
      rawTranscript: "secret AGENTS.md contents",
      replacementTranscript: "secret replacement",
      polishedTranscript: "secret polished",
      finalTranscript: "secret final",
      route: "command",
      captureQuality: "low-speech",
      spectrumFrames: 12,
      peakSpectrumLevel: 0.004,
      languageIntegrity: "mismatch",
      latencyMs: { capture: 800, transcription: 420, polish: 30, total: 1_250 },
      fidelity: "accepted",
    }, 100);

    const serialized = JSON.stringify(getVoiceTurnSupportSnapshot());
    expect(serialized).toContain("gpt-transcribe");
    expect(serialized).toContain("transcription");
    expect(serialized).toContain("low-speech");
    expect(serialized).toContain('"spectrumFrames":12');
    expect(serialized).toContain('"languageIntegrity":"mismatch"');
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("AGENTS.md");
    expect(serialized).not.toMatch(/rawTranscript|finalTranscript|polishedTranscript|audio/i);
  });
});
