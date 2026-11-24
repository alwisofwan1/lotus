import { fireEvent, render, screen } from "@testing-library/react";
import * as tauriApi from "@/lib/tauri-api";
import { describe, expect, it, vi } from "vitest";
import { NlModelKeyField } from "../NlModelKeyField";

vi.mock("@/lib/tauri-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri-api")>();
  return {
    ...actual,
    getNlModelConfig: vi.fn(async () => ({ provider: "", apiKey: undefined, model: undefined })),
    setNlModelConfig: vi.fn(async () => {}),
  };
});

describe("NlModelKeyField", () => {
  it("explains that classic dictation fails open instead of cold-spawning the CLI", async () => {
    render(<NlModelKeyField />);

    expect(await screen.findByText(/dictation cleanup falls back to the original transcript/i)).toBeInTheDocument();
  });

  it("surfaces a save failure instead of leaking an unhandled rejection", async () => {
    vi.mocked(tauriApi.setNlModelConfig).mockRejectedValueOnce(new Error("nl_model_set_config not allowed. Command not found"));
    render(<NlModelKeyField />);

    const keyInput = await screen.findByLabelText("OpenAI API key");
    fireEvent.change(keyInput, { target: { value: "sk-test" } });
    fireEvent.keyDown(keyInput, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to save NL model config: nl_model_set_config not allowed. Command not found",
    );
  });
});
