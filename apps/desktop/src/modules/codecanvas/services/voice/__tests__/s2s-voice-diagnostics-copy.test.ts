import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordS2sVoiceDiagnostic,
  recordS2sVoiceHealthDiagnostic,
  recordS2sVoiceLatencyDiagnostic,
  resetS2sVoiceDiagnosticsForTests,
} from "../s2s-voice-diagnostics";
import { copyS2sVoiceDiagnostics } from "../s2s-voice-diagnostics-copy";

describe("copyS2sVoiceDiagnostics", () => {
  beforeEach(() => resetS2sVoiceDiagnosticsForTests());

  it("returns empty when no diagnostics have been recorded", async () => {
    const writeText = vi.fn();
    await expect(copyS2sVoiceDiagnostics({ writeText })).resolves.toBe("empty");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies sanitized JSONL diagnostics", async () => {
    const writeText = vi.fn<Clipboard["writeText"]>(async () => undefined);
    recordS2sVoiceDiagnostic({ id: "call-1", tool: "dispatch", ok: true, heardTarget: "claude-3", resolvedTarget: "Bima", preview: "review", speak: "Done" }, 4, 100);

    await expect(copyS2sVoiceDiagnostics({ writeText })).resolves.toBe("copied");

    expect(writeText).toHaveBeenCalledOnce();
    const payload = writeText.mock.calls[0][0];
    expect(payload).toContain('"contextVersion":4');
    expect(payload).toContain('"resolvedTarget":"Bima"');
    expect(payload).not.toContain("nodeId");
  });

  it("copies health-only diagnostics too", async () => {
    const writeText = vi.fn<Clipboard["writeText"]>(async () => undefined);
    recordS2sVoiceHealthDiagnostic({ socket: "connected", mic: "active", playback: "playing", audioDeltas: 2 }, 100);

    await expect(copyS2sVoiceDiagnostics({ writeText })).resolves.toBe("copied");
    expect(writeText.mock.calls[0][0]).toContain('"kind":"health"');
  });

  it("copies latency-only diagnostics too", async () => {
    const writeText = vi.fn<Clipboard["writeText"]>(async () => undefined);
    recordS2sVoiceLatencyDiagnostic({
      milestone: "first-audio-delta",
      turn: 2,
      elapsedFromSpeechEndMs: 540,
    }, 100);

    await expect(copyS2sVoiceDiagnostics({ writeText })).resolves.toBe("copied");
    expect(writeText.mock.calls[0][0]).toContain('"kind":"latency"');
    expect(writeText.mock.calls[0][0]).not.toContain("callId");
  });

  it("reports unavailable without Clipboard API", async () => {
    recordS2sVoiceDiagnostic({ id: "call-1", tool: "dispatch", ok: true }, 1, 100);
    await expect(copyS2sVoiceDiagnostics(undefined)).resolves.toBe("unavailable");
  });
});
