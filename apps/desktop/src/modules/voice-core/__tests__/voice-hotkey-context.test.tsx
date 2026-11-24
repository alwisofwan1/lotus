import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireHotkeyRecordingLease } from "@/lib/hotkeys/chord";
import { useVoiceHotkeyHandlers, VoiceHotkeyProvider } from "../voice-hotkey-context";
import { resetVoiceHotkeyStoreForTests, setVoiceHotkeyOverride, type VoiceHotkeyHandlers } from "../voice-hotkeys";

function Mode({ handlers }: { handlers: VoiceHotkeyHandlers }) {
  useVoiceHotkeyHandlers(handlers);
  return null;
}

const pressLiveVoice = () => fireEvent.keyDown(window, { key: "L", metaKey: true, shiftKey: true });

describe("voice hotkey provider", () => {
  beforeEach(() => {
    localStorage.clear();
    resetVoiceHotkeyStoreForTests();
  });
  afterEach(() => vi.useRealTimers());

  it("runs the Live Voice handler of the mode on screen", () => {
    const liveVoice = vi.fn();
    render(<VoiceHotkeyProvider><Mode handlers={{ liveVoice }} /></VoiceHotkeyProvider>);
    pressLiveVoice();
    expect(liveVoice).toHaveBeenCalledOnce();
  });

  it("shows a hint in a mode without Live Voice, then hides it", () => {
    vi.useFakeTimers();
    render(<VoiceHotkeyProvider><Mode handlers={{}} /></VoiceHotkeyProvider>);
    pressLiveVoice();
    expect(screen.getByRole("status").textContent).toBe("Live Voice is not available in this mode yet.");
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("leaves the key to a focused editor in a mode without Live Voice, and still says why", () => {
    render(<VoiceHotkeyProvider><Mode handlers={{}} /><textarea aria-label="editor" /></VoiceHotkeyProvider>);
    const editor = screen.getByLabelText("editor");
    const passed = fireEvent.keyDown(editor, { key: "L", metaKey: true, shiftKey: true });
    expect(passed).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Live Voice is not available in this mode yet.");
  });

  it("runs Push-to-Talk on the key the user picked", () => {
    setVoiceHotkeyOverride("push-to-talk", "f5");
    const pushToTalk = vi.fn();
    render(<VoiceHotkeyProvider><Mode handlers={{ pushToTalk }} /></VoiceHotkeyProvider>);
    fireEvent.keyDown(window, { key: "F5" });
    expect(pushToTalk).toHaveBeenCalledOnce();
  });

  it("goes back to a hint once the mode leaves the screen", () => {
    const liveVoice = vi.fn();
    const view = render(<VoiceHotkeyProvider><Mode handlers={{ liveVoice }} /></VoiceHotkeyProvider>);
    view.rerender(<VoiceHotkeyProvider>{null}</VoiceHotkeyProvider>);
    pressLiveVoice();
    expect(liveVoice).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Live Voice is not available in this mode yet.");
  });

  it("does nothing while a hotkey is being recorded in settings", () => {
    const liveVoice = vi.fn();
    render(<VoiceHotkeyProvider><Mode handlers={{ liveVoice }} /></VoiceHotkeyProvider>);
    const release = acquireHotkeyRecordingLease();
    pressLiveVoice();
    release();
    expect(liveVoice).not.toHaveBeenCalled();
  });

  describe("Push-to-Talk on ⌥⇧Space: tap toggles, hold talks while held", () => {
    // ⌥⇧Space reports a non-breaking space as `key` on macOS; `code` is what stays "Space".
    const down = () => fireEvent.keyDown(window, { key: "\u00a0", code: "Space", altKey: true, shiftKey: true });
    const up = () => fireEvent.keyUp(window, { key: " ", code: "Space" });

    it("toggles on a tap and does not release", () => {
      vi.useFakeTimers();
      const pushToTalk = vi.fn();
      const pushToTalkRelease = vi.fn();
      render(<VoiceHotkeyProvider><Mode handlers={{ pushToTalk, pushToTalkRelease }} /></VoiceHotkeyProvider>);
      down();
      vi.advanceTimersByTime(120);
      up();
      expect(pushToTalk).toHaveBeenCalledOnce();
      expect(pushToTalkRelease).not.toHaveBeenCalled();
    });

    it("releases when the key is let go after a hold", () => {
      vi.useFakeTimers();
      const pushToTalk = vi.fn();
      const pushToTalkRelease = vi.fn();
      render(<VoiceHotkeyProvider><Mode handlers={{ pushToTalk, pushToTalkRelease }} /></VoiceHotkeyProvider>);
      down();
      vi.advanceTimersByTime(600);
      up();
      expect(pushToTalk).toHaveBeenCalledOnce();
      expect(pushToTalkRelease).toHaveBeenCalledOnce();
    });

    it("says a press began with the key held, then that it was only a tap", () => {
      vi.useFakeTimers();
      const pushToTalk = vi.fn();
      const pushToTalkTap = vi.fn();
      render(<VoiceHotkeyProvider><Mode handlers={{ pushToTalk, pushToTalkRelease: vi.fn(), pushToTalkTap }} /></VoiceHotkeyProvider>);
      down();
      expect(pushToTalk).toHaveBeenCalledWith({ holding: true });
      vi.advanceTimersByTime(120);
      up();
      expect(pushToTalkTap).toHaveBeenCalledOnce();
    });

    it("says nothing of a tap after a real hold", () => {
      vi.useFakeTimers();
      const pushToTalkTap = vi.fn();
      render(<VoiceHotkeyProvider><Mode handlers={{ pushToTalk: vi.fn(), pushToTalkRelease: vi.fn(), pushToTalkTap }} /></VoiceHotkeyProvider>);
      down();
      vi.advanceTimersByTime(600);
      up();
      expect(pushToTalkTap).not.toHaveBeenCalled();
    });

    it("calls a hold cut short by the window losing focus a tap", () => {
      vi.useFakeTimers();
      const pushToTalkTap = vi.fn();
      render(<VoiceHotkeyProvider><Mode handlers={{ pushToTalk: vi.fn(), pushToTalkRelease: vi.fn(), pushToTalkTap }} /></VoiceHotkeyProvider>);
      down();
      vi.advanceTimersByTime(600);
      fireEvent.blur(window);
      expect(pushToTalkTap).toHaveBeenCalledOnce();
    });

    it("forgets a hold when the window loses focus", () => {
      vi.useFakeTimers();
      const pushToTalkRelease = vi.fn();
      render(<VoiceHotkeyProvider><Mode handlers={{ pushToTalk: vi.fn(), pushToTalkRelease }} /></VoiceHotkeyProvider>);
      down();
      vi.advanceTimersByTime(600);
      fireEvent.blur(window);
      up();
      expect(pushToTalkRelease).not.toHaveBeenCalled();
    });
  });

  it("still works for a mode rendered without the app provider", () => {
    const liveVoice = vi.fn();
    render(<Mode handlers={{ liveVoice }} />);
    pressLiveVoice();
    expect(liveVoice).toHaveBeenCalledOnce();
  });
});
