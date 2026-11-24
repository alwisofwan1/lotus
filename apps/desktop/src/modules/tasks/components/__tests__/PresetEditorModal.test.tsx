import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PresetEditorModal } from "@/modules/tasks/components/PresetEditorModal";

const alwi = {
  id: "preset_mue1m27tt1ssy",
  name: "Alwi",
  agent: "ccs acme",
  args: "--dangerously-skip-permissions",
  instructions: "",
};

function open(preset = alwi) {
  const onSave = vi.fn().mockResolvedValue(null);
  const onRemove = vi.fn();
  render(<PresetEditorModal preset={preset} onSave={onSave} onRemove={onRemove} onClose={() => {}} />);
  return { onSave, onRemove };
}

describe("the preset editor", () => {
  it("opens the real saved preset as Full access on its ccs profile, not Ask first", () => {
    open();
    const permissions = screen.getByRole("radiogroup", { name: "Permissions" });
    expect(within(permissions).getByRole("radio", { name: /Full access/ }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("ccs profile") as HTMLInputElement).value).toBe("acme");
  });

  it("saves the picker choices as the flags every runner reads", async () => {
    const { onSave } = open();
    fireEvent.click(screen.getByLabelText("Agent and model"));
    fireEvent.click(screen.getByRole("option", { name: /Opus 5/ }));
    fireEvent.click(screen.getByLabelText("Agent and model"));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Reasoning" })).getByRole("radio", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));

    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      agent: "ccs acme",
      args: "--model opus --effort high --dangerously-skip-permissions",
    });
  });

  it("offers no model or reasoning an agent cannot take", () => {
    open({ ...alwi, agent: "gemini", args: "" });
    fireEvent.click(screen.getByLabelText("Agent and model"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("CLI default"),
    ]);
    expect(screen.queryByRole("radiogroup", { name: "Reasoning" })).toBeNull();
  });

  it("warns when an extra flag overrides a picker", () => {
    open({ ...alwi, args: "--verbose" });
    fireEvent.change(screen.getByPlaceholderText("--verbose"), { target: { value: "--model opus" } });
    expect(screen.getByText(/overrides the picker above/)).toBeTruthy();
  });

  it("asks once more before deleting", () => {
    const { onRemove } = open();
    fireEvent.click(screen.getByRole("button", { name: "Delete preset" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onRemove).toHaveBeenCalled();
  });
});
