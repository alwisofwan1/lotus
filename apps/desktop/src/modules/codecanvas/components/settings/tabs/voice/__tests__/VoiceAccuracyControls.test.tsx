import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  getVoiceAccuracySettings,
  resetVoiceAccuracyStoreForTests,
} from "@/modules/codecanvas/hooks/useVoiceAccuracySettings";
import { VoiceAccuracyControls } from "../VoiceAccuracyControls";

describe("VoiceAccuracyControls", () => {
  const originalLanguages = navigator.languages;

  beforeEach(() => {
    localStorage.clear();
    resetVoiceAccuracyStoreForTests();
  });

  afterEach(() => {
    Object.defineProperty(navigator, "languages", { configurable: true, value: originalLanguages });
  });

  it("hydrates existing accuracy settings into the editor on first render", () => {
    localStorage.setItem("canvas-voice-accuracy-v1", JSON.stringify({
      expectedLanguages: ["id", "en"],
      personalTerms: ["Lotus", "AGENTS.md"],
      replacements: [],
    }));
    resetVoiceAccuracyStoreForTests();

    render(<VoiceAccuracyControls />);

    expect(screen.getByLabelText("Expected languages")).toHaveValue("id, en");
    expect(screen.getByLabelText("Personal dictionary")).toHaveValue("Lotus\nAGENTS.md");
  });

  it("shows the effective device-language fallback when no language was configured", () => {
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-ID", "id-ID"] });

    render(<VoiceAccuracyControls />);

    expect(screen.getByText("Empty uses this device: id-ID.")).toBeInTheDocument();
  });

  it("lets the user persist language hints, personal terms, and safe literal corrections", () => {
    render(<VoiceAccuracyControls />);

    fireEvent.change(screen.getByLabelText("Expected languages"), { target: { value: "id, en" } });
    fireEvent.change(screen.getByLabelText("Personal dictionary"), {
      target: { value: "Lotus\nAGENTS.md\nClaude Code" },
    });
    fireEvent.change(screen.getByLabelText("Misheard variants"), {
      target: { value: "clod code, cloud code" },
    });
    fireEvent.change(screen.getByLabelText("Exact replacement"), { target: { value: "Claude Code" } });
    fireEvent.click(screen.getByRole("button", { name: "Add correction" }));

    expect(getVoiceAccuracySettings()).toEqual({
      expectedLanguages: ["id", "en"],
      personalTerms: ["Lotus", "AGENTS.md", "Claude Code"],
      replacements: [expect.objectContaining({
        variants: ["clod code", "cloud code"],
        replacement: "Claude Code",
        timing: "both",
        enabled: true,
      })],
    });
    expect(screen.getByText("clod code, cloud code")).toBeInTheDocument();
  });
});
