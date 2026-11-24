import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentPersonaHeader } from "../AgentPersonaHeader";

function renderHeader(overrides: Partial<React.ComponentProps<typeof AgentPersonaHeader>> = {}) {
  const onRename = overrides.onRename ?? vi.fn(() => ({ ok: true }) as const);
  const onClose = overrides.onClose ?? vi.fn();
  render(
    <AgentPersonaHeader name="Atlas" runner="claude" tone="ready" onRename={onRename} onClose={onClose} {...overrides} />,
  );
  return { onRename, onClose };
}

describe("AgentPersonaHeader — inline rename (NP.5)", () => {
  it("shows the name as static text until double-clicked", () => {
    renderHeader();
    expect(screen.getByText("Atlas")).toBeTruthy();
    expect(screen.queryByLabelText("Agent name")).toBeNull();
  });

  it("double-click opens an editable field seeded with the current name", () => {
    renderHeader();
    fireEvent.doubleClick(screen.getByText("Atlas"));
    const input = screen.getByLabelText("Agent name") as HTMLInputElement;
    expect(input.value).toBe("Atlas");
  });

  it("commits a valid new name on Enter and exits edit mode", () => {
    const onRename = vi.fn(() => ({ ok: true }) as const);
    renderHeader({ onRename });
    fireEvent.doubleClick(screen.getByText("Atlas"));
    const input = screen.getByLabelText("Agent name");
    fireEvent.change(input, { target: { value: "Nova" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("Nova");
    expect(screen.queryByLabelText("Agent name")).toBeNull(); // back to static text
  });

  it("keeps the field open and shows a reason when the caller rejects the name", () => {
    const onRename = vi.fn(() => ({ ok: false, reason: "duplicate" }) as const);
    renderHeader({ onRename });
    fireEvent.doubleClick(screen.getByText("Atlas"));
    const input = screen.getByLabelText("Agent name");
    fireEvent.change(input, { target: { value: "Nova" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const stillEditing = screen.getByLabelText("Agent name");
    expect(stillEditing.getAttribute("aria-invalid")).toBe("true");
    expect(stillEditing.getAttribute("title")).toMatch(/already has that name/i);
  });

  it("Escape cancels without calling onRename", () => {
    const onRename = vi.fn(() => ({ ok: true }) as const);
    renderHeader({ onRename });
    fireEvent.doubleClick(screen.getByText("Atlas"));
    const input = screen.getByLabelText("Agent name");
    fireEvent.change(input, { target: { value: "Zzz" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("Atlas")).toBeTruthy();
  });

  it("treats an unchanged name as a friendly cancel, not a duplicate error", () => {
    // Caller reports duplicate because the taken set still includes the agent's own current name.
    const onRename = vi.fn(() => ({ ok: false, reason: "duplicate" }) as const);
    renderHeader({ onRename });
    fireEvent.doubleClick(screen.getByText("Atlas"));
    const input = screen.getByLabelText("Agent name");
    fireEvent.keyDown(input, { key: "Enter" }); // value unchanged = "Atlas"
    expect(screen.getByText("Atlas")).toBeTruthy(); // exited cleanly
    expect(screen.queryByLabelText("Agent name")).toBeNull();
  });

  it("is read-only when no onRename is provided (double-click does nothing)", () => {
    render(<AgentPersonaHeader name="Atlas" runner="claude" tone="ready" onClose={vi.fn()} />);
    fireEvent.doubleClick(screen.getByText("Atlas"));
    expect(screen.queryByLabelText("Agent name")).toBeNull();
  });
});
