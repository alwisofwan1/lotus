import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ListenPanel } from "../ListenPanel";

vi.mock("@/modules/codecanvas/hooks/useVoiceInputSettings", () => ({
  useVoiceInputSettings: () => ({
    autoSubmit: true,
    polish: false,
    dictationMode: "clean",
    setAutoSubmit: vi.fn(),
    setPolish: vi.fn(),
    setDictationMode: vi.fn(),
  }),
}));

vi.mock("@/modules/codecanvas/hooks/useCanvasHotkeySettings", () => ({
  useCanvasHotkeyOverrides: () => ({
    overrides: {
      "voice-command": "mod+shift+c",
      "voice-dictate": "mod+shift+x",
    },
  }),
}));

vi.mock("../../VoiceProviderList", () => ({ VoiceProviderList: () => <div data-testid="engine-list" /> }));
vi.mock("../VoiceAccuracyControls", () => ({ VoiceAccuracyControls: () => <div /> }));

describe("ListenPanel voice shortcut hints", () => {
  it("shows the user's effective Command and Dictate bindings instead of static defaults", () => {
    render(<ListenPanel list={{} as never} />);

    expect(screen.getByText("Ctrl+Shift+C")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Shift+X")).toBeInTheDocument();
    expect(screen.queryByText("⌘⇧V")).not.toBeInTheDocument();
    expect(screen.queryByText("⌘⇧D")).not.toBeInTheDocument();
  });

  it("has no dictation auto-send row: Send Right Away lives in Voice › How voice behaves, for every mode", () => {
    render(<ListenPanel list={{} as never} />);
    expect(screen.queryByText("Auto-send dictation")).not.toBeInTheDocument();
    expect(screen.getByText("Auto-run commands")).toBeInTheDocument();
  });
});
