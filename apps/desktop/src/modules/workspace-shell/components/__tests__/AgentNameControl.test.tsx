import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentNameControl } from "../AgentNameControl";

describe("AgentNameControl", () => {
  it("click opens the field, Enter renames", () => {
    const onRename = vi.fn(() => null);
    render(<AgentNameControl name="Nara" onRename={onRename} />);
    fireEvent.click(screen.getByRole("button", { name: /Nara/ }));
    const field = screen.getByRole("textbox", { name: "Agent name" });
    fireEvent.change(field, { target: { value: "Kirana" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("Kirana");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a refused name stays open with the reason; Esc cancels", () => {
    const onRename = vi.fn(() => "Another pane already has this name.");
    render(<AgentNameControl name="Nara" onRename={onRename} />);
    fireEvent.click(screen.getByRole("button", { name: /Nara/ }));
    const field = screen.getByRole("textbox", { name: "Agent name" });
    fireEvent.change(field, { target: { value: "Bima" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("already has this name");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
