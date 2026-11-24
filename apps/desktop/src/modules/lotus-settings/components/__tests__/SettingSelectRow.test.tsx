import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SettingSelectRow } from "../SettingSelectRow";

const options = [
  { value: "auto", label: "Automatic" },
  { value: "ja", label: "日本語 (Japanese)" },
];

describe("SettingSelectRow", () => {
  it("renders the title, a labelled select, and the current value", () => {
    render(
      <SettingSelectRow
        title="Naming language"
        description="Pick a language."
        selectLabel="Agent naming language"
        options={options}
        value="auto"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Naming language")).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "Agent naming language" }) as HTMLSelectElement;
    expect(select.value).toBe("auto");
  });

  it("calls onChange with the chosen value", () => {
    const onChange = vi.fn();
    render(
      <SettingSelectRow
        title="Naming language"
        description="Pick a language."
        selectLabel="Agent naming language"
        options={options}
        value="auto"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Agent naming language" }), { target: { value: "ja" } });
    expect(onChange).toHaveBeenCalledWith("ja");
  });

  it("renders an optional footer inside the card", () => {
    render(
      <SettingSelectRow
        title="Naming language"
        description="Pick a language."
        selectLabel="Agent naming language"
        options={options}
        value="auto"
        onChange={vi.fn()}
        footer={<span>Example: Rin · Ren</span>}
      />,
    );
    expect(screen.getByText("Example: Rin · Ren")).toBeInTheDocument();
  });
});
