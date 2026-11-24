import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_VOICE_OUTPUT, type VoiceOutputSettings } from "@/lib/tauri-api";
import { VoiceBehaviourSection } from "../VoiceBehaviourSection";
import { getCanvasBehaviorSettings, resetCanvasBehaviorStoreForTests } from "@/modules/codecanvas/hooks/useCanvasBehaviorSettings";
import { tauriVoicePort } from "@/modules/voice-core/tauri-voice-port";
import { getVoiceInputSettings, resetVoiceInputStoreForTests } from "@/modules/codecanvas/hooks/useVoiceInputSettings";

function setup(output: Partial<VoiceOutputSettings> = {}) {
  const onOutputChange = vi.fn();
  render(<VoiceBehaviourSection output={{ ...DEFAULT_VOICE_OUTPUT, ...output }} onOutputChange={onOutputChange} />);
  return { onOutputChange };
}

describe("VoiceBehaviourSection", () => {
  beforeEach(() => {
    localStorage.clear();
    resetVoiceInputStoreForTests();
    resetCanvasBehaviorStoreForTests();
  });

  it("puts the one 'Send right away' under Dictation, off by default, saved per device for every mode", () => {
    setup();
    expect(screen.getByText("Dictation")).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Send right away" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(getVoiceInputSettings().sendRightAway).toBe(true);
    expect(JSON.parse(localStorage.getItem("lotus-voice-input-v1") ?? "{}")).toMatchObject({ sendRightAway: true });
  });

  it("hosts Clean up dictation next to Send right away, on the same device key", () => {
    setup();
    const cleanup = screen.getByRole("switch", { name: "Clean up dictation" });
    const before = getVoiceInputSettings().autoCleanup;
    fireEvent.click(cleanup);
    expect(getVoiceInputSettings().autoCleanup).toBe(!before);
  });

  it("shows the old callouts switch as Sound (the default), and Voice saves the mode with the old switch kept in step", () => {
    const { onOutputChange } = setup({ agentDoneCallouts: true });
    expect(screen.getByRole("button", { name: "Sound" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Voice" }));

    expect(onOutputChange).toHaveBeenCalledWith(expect.objectContaining({ agentDoneAlert: "voice", agentDoneCallouts: true }));
  });

  it("offers the sound picker while an alert is on, saves the pick and plays it as a preview", () => {
    // Since #297 the preview plays natively (afplay); <audio> is only the fallback when that rejects.
    const play = vi.spyOn(tauriVoicePort, "playAgentDoneSound").mockResolvedValue(undefined);
    const { onOutputChange } = setup({ agentDoneAlert: "sound" });
    const select = screen.getByLabelText("Sound") as HTMLSelectElement;
    expect(select.value).toBe("classic");

    fireEvent.change(select, { target: { value: "droplet" } });

    expect(onOutputChange).toHaveBeenCalledWith(expect.objectContaining({ agentDoneSound: "droplet" }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith("droplet");
    fireEvent.click(screen.getByRole("button", { name: "Preview sound" }));
    expect(play).toHaveBeenCalledTimes(2);
    play.mockRestore();
  });

  it("reads an old switched-off file as Off and hides the rows that only matter when something plays", () => {
    const { onOutputChange } = setup({ agentDoneCallouts: false });
    expect(screen.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("switch", { name: "Also when on screen" })).toBeNull();
    expect(screen.queryByLabelText("Quiet time per agent")).toBeNull();
    expect(screen.queryByLabelText("Sound")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Voice" }));
    expect(onOutputChange).toHaveBeenCalledWith(expect.objectContaining({ agentDoneAlert: "voice", agentDoneCallouts: true }));
  });

  it("sets 'Also when on screen' and the quiet time per agent", () => {
    const { onOutputChange } = setup({ agentDoneAlert: "sound" });
    fireEvent.click(screen.getByRole("switch", { name: "Also when on screen" }));
    expect(onOutputChange).toHaveBeenCalledWith(expect.objectContaining({ wakeOnFinish: true }));

    fireEvent.change(screen.getByLabelText("Quiet time per agent"), { target: { value: "0" } });
    expect(onOutputChange).toHaveBeenCalledWith(expect.objectContaining({ agentDoneCooldownMs: 0 }));
  });

  it("drops the key link rows and saves Reply length", () => {
    const { onOutputChange } = setup();
    expect(screen.queryByText("Push-to-Talk key")).toBeNull();
    expect(screen.queryByText("Live Voice key")).toBeNull();

    fireEvent.change(screen.getByLabelText("Reply length"), { target: { value: "brief" } });

    expect(onOutputChange).toHaveBeenCalledWith(expect.objectContaining({ verbosity: "brief" }));
  });

  it("hosts Narrate agent work aloud on the canvas key; Live auto-close lives in Advanced", () => {
    setup();
    const narrate = screen.getByRole("switch", { name: "Narrate agent work aloud" });
    expect(narrate).toHaveAttribute("aria-checked", "false");
    fireEvent.click(narrate);
    expect(getCanvasBehaviorSettings().liveNarration).toBe(true);
    expect(screen.queryByRole("switch", { name: "Live voice: auto-close after each command" })).toBeNull();
  });
});
