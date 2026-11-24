import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { VoiceOutputControls } from "../VoiceOutputControls";
import { DEFAULT_VOICE_OUTPUT } from "@/lib/tauri-api";

function setup(overrides: Partial<Parameters<typeof VoiceOutputControls>[0]> = {}) {
  const onChange = vi.fn();
  const onSpeedChange = vi.fn();
  render(
    <VoiceOutputControls
      value={{ ...DEFAULT_VOICE_OUTPUT, ...(overrides.value ?? {}) }}
      onChange={onChange}
      onSpeedChange={onSpeedChange}
      {...overrides}
    />,
  );
  return { onChange, onSpeedChange };
}

describe("VoiceOutputControls — tone / speed", () => {
  it("changes the tone preset", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText("Voice tone"), { target: { value: "formal" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tone: "formal" }));
  });

  it("shows the custom-instructions field only for the custom tone, and commits it on blur", () => {
    const { onChange } = setup({ value: { ...DEFAULT_VOICE_OUTPUT, tone: "custom" } });
    const field = screen.getByLabelText("Custom tone instructions");
    fireEvent.change(field, { target: { value: "Bicara santai seperti teman dekat." } });
    expect(onChange).not.toHaveBeenCalled(); // not per-keystroke — one file write per edit
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ toneInstructions: "Bicara santai seperti teman dekat." }),
    );
  });

  it("hides the custom-instructions field for preset tones", () => {
    setup();
    expect(screen.queryByLabelText("Custom tone instructions")).toBeNull();
  });

  it("changes the speech speed on the active provider, and 'default' clears it", () => {
    const { onSpeedChange } = setup({ speed: 1.25 });
    fireEvent.change(screen.getByLabelText("Speech speed"), { target: { value: "1.5" } });
    expect(onSpeedChange).toHaveBeenCalledWith(1.5);
    fireEvent.change(screen.getByLabelText("Speech speed"), { target: { value: "default" } });
    expect(onSpeedChange).toHaveBeenCalledWith(undefined);
  });

  it("no longer carries the agent-finish rows (they moved to How voice behaves)", () => {
    setup();
    expect(screen.queryByLabelText("Callout cooldown")).toBeNull();
    expect(screen.queryByText(/Agent is done/)).toBeNull();
  });
});
