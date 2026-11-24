import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_OUTPUT, type VoiceOutputSettings } from "@/lib/tauri-api";

const tts = vi.hoisted(() => ({ output: undefined as VoiceOutputSettings | undefined }));
vi.mock("@/lib/hooks/useTtsProviderRegistry", () => ({
  useTtsProviderRegistry: () => ({ registry: tts.output ? { output: tts.output, providers: [] } : null }),
}));
vi.mock("@/lib/hooks/useSttProviderRegistry", () => ({
  useSttProviderRegistry: () => ({ registry: null }),
}));
const voice = vi.hoisted(() => ({ announce: vi.fn(async () => {}), chime: vi.fn(), canSpeak: vi.fn(() => true) }));
vi.mock("@/modules/voice-core/use-voice-feedback", () => ({ useVoiceFeedback: () => voice }));

import { useCodeAgentDoneAlerts } from "../useCodeAgentDoneAlerts";

function setup(over: Partial<VoiceOutputSettings> = {}) {
  tts.output = { ...DEFAULT_VOICE_OUTPUT, ...over };
  const { result } = renderHook(() => useCodeAgentDoneAlerts({ nameFor: (id) => (id === "p1" ? "Rani" : undefined) }));
  return result.current;
}

describe("useCodeAgentDoneAlerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voice.canSpeak.mockReturnValue(true);
  });

  it("says the pane's name as a callout when a turn ends out of sight", () => {
    const alert = setup({ agentDoneAlert: "voice" });
    alert("p1", { seen: false, fresh: true });
    expect(voice.announce).toHaveBeenCalledWith("Rani is done.", expect.objectContaining({ priority: "callout", name: "Rani" }));
    expect(voice.chime).not.toHaveBeenCalled();
  });

  it("plays the chime for Sound, and for Voice when nothing can speak", () => {
    setup({ agentDoneAlert: "sound" })("p1", { seen: false, fresh: true });
    expect(voice.chime).toHaveBeenCalledTimes(1);

    voice.canSpeak.mockReturnValue(false);
    setup({ agentDoneAlert: "voice" })("p1", { seen: false, fresh: true });
    expect(voice.chime).toHaveBeenCalledTimes(2);
    expect(voice.announce).not.toHaveBeenCalled();
  });

  it("is silent when Off, and for the pane being watched unless 'Also when on screen'", () => {
    setup({ agentDoneAlert: "off" })("p1", { seen: false, fresh: true });
    setup({ agentDoneAlert: "voice", wakeOnFinish: false })("p1", { seen: true, fresh: true });
    expect(voice.announce).not.toHaveBeenCalled();

    setup({ agentDoneAlert: "voice", wakeOnFinish: true })("p1", { seen: true, fresh: true });
    expect(voice.announce).toHaveBeenCalledTimes(1);
  });

  it("keeps the quiet time per agent for unprompted turns, but not for work just sent", () => {
    const alert = setup({ agentDoneAlert: "sound" });
    alert("p1", { seen: false, fresh: false });
    alert("p1", { seen: false, fresh: false });
    expect(voice.chime).toHaveBeenCalledTimes(1);
    alert("p1", { seen: false, fresh: true });
    expect(voice.chime).toHaveBeenCalledTimes(2);
  });
});
