import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HotkeysTab } from "../tabs/HotkeysTab";
import {
  getCanvasHotkeyOverrides,
  resetCanvasHotkeyStoreForTests,
} from "../../../hooks/useCanvasHotkeySettings";
import { UNBOUND_CHORD } from "../../../services/canvas-hotkeys";
import { useCanvasHotkeys } from "../../../hooks/useCanvasHotkeys";
import { getVoiceHotkeyBindings, resetVoiceHotkeyStoreForTests } from "@/modules/voice-core/voice-hotkeys";

afterEach(() => {
  resetCanvasHotkeyStoreForTests();
  resetVoiceHotkeyStoreForTests();
  try { localStorage.clear(); } catch {}
});

function rowFor(title: string): HTMLElement {
  return screen.getByText(title).closest("[data-hotkey-row]") as HTMLElement;
}
function bindingButton(title: string): HTMLElement {
  return within(rowFor(title)).getByRole("button", { name: /binding/i });
}

function HotkeyRecordingHarness({ onDictate }: { onDictate: () => void }) {
  useCanvasHotkeys({ "voice-dictate": onDictate });
  return <HotkeysTab platform="mac" />;
}

describe("HotkeysTab (editable)", () => {
  it("renders every command with its current binding, platform-aware", () => {
    render(<HotkeysTab platform="mac" />);
    expect(within(rowFor("Command palette")).getByText("⌘")).toBeInTheDocument();
    expect(within(rowFor("Command palette")).getByText("K")).toBeInTheDocument();
    expect(within(rowFor("Jump labels (type-to-focus)")).getByText("F")).toBeInTheDocument();
    expect(within(rowFor("Voice: force Command")).getByText("V")).toBeInTheDocument();
    expect(within(rowFor("Voice: force Dictate")).getByText("D")).toBeInTheDocument();
    expect(screen.getByText(/left and right modifiers stay separate/i)).toBeInTheDocument();
  });

  it("sets the app-wide Push-to-Talk key, which starts on ⌥⇧Space", () => {
    render(<HotkeysTab platform="mac" />);
    expect(screen.getByText("Voice (all modes)")).toBeInTheDocument();
    expect(within(rowFor("Push-to-Talk")).getByText("Space")).toBeInTheDocument();
    expect(within(rowFor("Live Voice on / off")).getByText("L")).toBeInTheDocument();

    fireEvent.click(bindingButton("Push-to-Talk"));
    fireEvent.keyDown(window, { key: "F5" });

    expect(getVoiceHotkeyBindings()["push-to-talk"]).toBe("f5");
    expect(localStorage.getItem("canvas-hotkeys-v1")).toBeNull();
    expect(within(rowFor("Push-to-Talk")).getByText("F5")).toBeInTheDocument();
  });

  it("records and persists a custom Dictate chord", () => {
    render(<HotkeysTab platform="mac" />);
    fireEvent.click(bindingButton("Voice: force Dictate"));
    fireEvent.keyDown(window, { key: "x", metaKey: true, shiftKey: true });

    expect(getCanvasHotkeyOverrides()["voice-dictate"]).toBe("mod+shift+x");
    expect(within(rowFor("Voice: force Dictate")).getByText("X")).toBeInTheDocument();
  });

  it("does not execute the existing voice shortcut while the editor is recording a replacement", () => {
    const onDictate = vi.fn();
    render(<HotkeyRecordingHarness onDictate={onDictate} />);
    fireEvent.click(bindingButton("Voice: force Dictate"));

    fireEvent.keyDown(window, { key: "d", code: "KeyD", metaKey: true, shiftKey: true });

    expect(onDictate).not.toHaveBeenCalled();
  });

  it("accepts a voice shortcut without Cmd or Shift and marks it global", () => {
    render(<HotkeysTab platform="mac" />);
    fireEvent.click(bindingButton("Voice: force Command"));
    fireEvent.keyDown(window, { key: "F8" });

    expect(getCanvasHotkeyOverrides()["voice-command"]).toBe("f8");
    expect(within(rowFor("Voice: force Command")).getByText("global shortcut")).toBeInTheDocument();
  });

  it("records Command by itself only after the modifier is released", () => {
    render(<HotkeysTab platform="mac" />);
    fireEvent.click(bindingButton("Voice: force Command"));

    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    expect(getCanvasHotkeyOverrides()).toEqual({});
    fireEvent.keyUp(window, { key: "Meta" });

    expect(getCanvasHotkeyOverrides()["voice-command"]).toBe("meta");
    expect(within(rowFor("Voice: force Command")).getByText("Any ⌘")).toBeInTheDocument();
  });

  it("records and labels the right physical Command key without widening it to both sides", () => {
    render(<HotkeysTab platform="mac" />);
    fireEvent.click(bindingButton("Voice: force Dictate"));

    fireEvent.keyDown(window, { key: "Meta", code: "MetaRight", location: 2, metaKey: true });
    fireEvent.keyUp(window, { key: "Meta", code: "MetaRight", location: 2 });

    expect(getCanvasHotkeyOverrides()["voice-dictate"]).toBe("meta-right");
    expect(within(rowFor("Voice: force Dictate")).getByText("Right ⌘")).toBeInTheDocument();
  });

  it("warns that a plain global voice key replaces typing while Canvas is open", () => {
    render(<HotkeysTab platform="mac" />);
    fireEvent.click(bindingButton("Voice: force Dictate"));
    fireEvent.keyDown(window, { key: "x" });

    expect(getCanvasHotkeyOverrides()["voice-dictate"]).toBe("x");
    expect(within(rowFor("Voice: force Dictate")).getByText(/replaces typing/i)).toBeInTheDocument();
  });

  it("labels close-node as canvas-layer only because terminals/editors keep text-delete chords", () => {
    render(<HotkeysTab platform="mac" />);
    expect(within(rowFor("Close focused node")).getByText(/canvas-layer only/i)).toBeInTheDocument();
    expect(within(rowFor("Cycle focus (most-recent)")).getByText("terminal-safe")).toBeInTheDocument();
  });

  it("records a new chord onto a remappable command and persists it", () => {
    render(<HotkeysTab platform="mac" />);
    fireEvent.click(bindingButton("Jump labels (type-to-focus)"));
    // Was mod+J until "Jump to the agent that needs you" claimed it — the recorder refuses a chord
    // another command owns, so the EXAMPLE had to move to one that is genuinely free. The refusal
    // itself is correct behaviour and has its own coverage in canvas-hotkeys.test.ts.
    fireEvent.keyDown(window, { key: "z", metaKey: true, altKey: true });
    expect(getCanvasHotkeyOverrides()["jump-labels"]).toBe("mod+alt+z");
    expect(within(rowFor("Jump labels (type-to-focus)")).getByText("⌘")).toBeInTheDocument();
  });

  it("does not let a reserved command start recording", () => {
    render(<HotkeysTab platform="mac" />);
    fireEvent.click(bindingButton("Command palette"));
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(getCanvasHotkeyOverrides()).toEqual({});
  });

  it("warns on a conflict and, on reassign, unbinds the previous owner", () => {
    render(<HotkeysTab platform="mac" />);
    // record cycle-forward onto "f", which jump-labels already owns
    fireEvent.click(bindingButton("Cycle focus (most-recent)"));
    fireEvent.keyDown(window, { key: "f" });
    // conflict is announced, nothing committed yet
    expect(screen.getByText(/already used by/i)).toHaveTextContent("Jump labels");
    expect(getCanvasHotkeyOverrides()).toEqual({});
    // reassign: new owner gets it, old owner is unbound
    fireEvent.click(screen.getByRole("button", { name: /reassign/i }));
    expect(getCanvasHotkeyOverrides()).toEqual({
      "cycle-forward": "f",
      "jump-labels": UNBOUND_CHORD,
    });
  });

  it("warns when a recorded chord collides with a whiteboard tool shortcut, and lets the user bind anyway", () => {
    render(<HotkeysTab platform="mac" />);
    // record cycle-forward onto "r", which arms the rectangle tool in canvas-tool.ts
    fireEvent.click(bindingButton("Cycle focus (most-recent)"));
    fireEvent.keyDown(window, { key: "r" });
    expect(screen.getByText(/rectangle/i)).toBeInTheDocument();
    // nothing committed yet — same non-destructive stance as a registry conflict
    expect(getCanvasHotkeyOverrides()).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: /bind anyway/i }));
    expect(getCanvasHotkeyOverrides()).toEqual({ "cycle-forward": "r" });
  });

  it("cancels a tool-shortcut warning without committing the override", () => {
    render(<HotkeysTab platform="mac" />);
    fireEvent.click(bindingButton("Cycle focus (most-recent)"));
    fireEvent.keyDown(window, { key: "r" });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(getCanvasHotkeyOverrides()).toEqual({});
  });

  it("does not warn for mod+r — that chord never reaches the tool shortcut listener", () => {
    render(<HotkeysTab platform="mac" />);
    fireEvent.click(bindingButton("Cycle focus (most-recent)"));
    fireEvent.keyDown(window, { key: "r", metaKey: true });
    expect(screen.queryByText(/rectangle/i)).not.toBeInTheDocument();
    expect(getCanvasHotkeyOverrides()).toEqual({ "cycle-forward": "mod+r" });
  });

  it("resets a single binding and resets all", () => {
    render(<HotkeysTab platform="mac" />);
    fireEvent.click(bindingButton("Jump labels (type-to-focus)"));
    fireEvent.keyDown(window, { key: "z", metaKey: true, altKey: true }); // see the note above
    fireEvent.click(within(rowFor("Jump labels (type-to-focus)")).getByRole("button", { name: /reset/i }));
    expect(getCanvasHotkeyOverrides()).toEqual({});

    fireEvent.click(bindingButton("Cycle focus (most-recent)"));
    fireEvent.keyDown(window, { key: "m", metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: /reset all/i }));
    expect(getCanvasHotkeyOverrides()).toEqual({});
  });
});
