import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

const { runSmartConvert } = vi.hoisted(() => ({
  runSmartConvert: vi.fn((runner: string, _content: string, _model: string) =>
    runner === "codex"
      ? Promise.resolve('{"title":"ok","intent":"done","acceptanceCriteria":[],"taskClass":"quick","when":"whenever","subtasks":[]}')
      : new Promise<string>(() => {}),
  ),
}));
vi.mock("../../services/smart-convert-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/smart-convert-runner")>()),
  runSmartConvert,
}));
vi.mock("@/modules/chat/runtime/chat-runtime-client", () => ({
  listChatModels: vi.fn((runner: string) =>
    Promise.resolve(runner === "claude" ? [{ value: "sonnet", displayName: "Sonnet 5", description: "", isDefault: true }] : [{ value: "gpt-6", displayName: "GPT 6", description: "", isDefault: true }]),
  ),
}));

import { SmartConvertModal } from "../SmartConvertModal";

describe("SmartConvertModal", () => {
  it("drafts again with the other agent picked in the chat's model picker", async () => {
    render(<SmartConvertModal noteContent="Buatkan puisi tentang alam" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(await screen.findByText(/Claude is drafting the task/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create task/ })).toBeDisabled();

    fireEvent.click(await screen.findByRole("button", { name: /Sonnet 5/ }));
    // Smart Convert runs a CLI: no API tab.
    expect(screen.queryByRole("button", { name: "API" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    await waitFor(() => expect(screen.queryByText(/is drafting the task/)).not.toBeInTheDocument());
    expect(runSmartConvert).toHaveBeenLastCalledWith("codex", "Buatkan puisi tentang alam", "");
    expect(screen.getByDisplayValue("ok")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create task/ })).not.toBeDisabled();
  });
});

describe("SmartConvertModal under StrictMode", () => {
  it("shows the draft when the first answer lands after React's dev remount", async () => {
    runSmartConvert.mockImplementation(() =>
      Promise.resolve('{"title":"strict","intent":"","acceptanceCriteria":[],"taskClass":"quick","when":"whenever","subtasks":[]}'),
    );
    render(<StrictMode><SmartConvertModal noteContent="note" onConfirm={vi.fn()} onCancel={vi.fn()} /></StrictMode>);
    expect(await screen.findByDisplayValue("strict")).toBeInTheDocument();
  });
});
