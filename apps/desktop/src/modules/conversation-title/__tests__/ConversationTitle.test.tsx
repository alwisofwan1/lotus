import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationTitle } from "@/modules/conversation-title/ConversationTitle";

// The menu's head names the title too; the one to double-click is the header's.
const titleText = (text: string) => screen.getByText(text, { selector: ".conversation-title-text" });

describe("ConversationTitle", () => {
  it("renames in place: Enter saves, Esc and clicking away keep the title", () => {
    const onRename = vi.fn();
    render(<ConversationTitle title="Release notes" onRename={onRename} />);

    fireEvent.doubleClick(titleText("Release notes"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    fireEvent.doubleClick(titleText("Release notes"));
    fireEvent.blur(screen.getByRole("textbox"));
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.doubleClick(titleText("Release notes"));
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "  Ship   notes " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("Ship notes");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a cleared title asks for the automatic one", () => {
    const onRename = vi.fn();
    render(<ConversationTitle title="Old" onRename={onRename} />);
    fireEvent.doubleClick(titleText("Old"));
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: " " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("");
  });

  it("a read-only title cannot be edited", () => {
    render(<ConversationTitle title="Archived" readOnly onRename={vi.fn()} />);
    fireEvent.doubleClick(titleText("Archived"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("offers going back to automatic only for a title someone typed", () => {
    const { rerender } = render(<ConversationTitle title="Auto" source="auto" onRename={vi.fn()} />);
    expect(screen.queryByRole("menuitem", { name: /Use automatic title/, hidden: true })).toBeNull();
    const onRename = vi.fn();
    rerender(<ConversationTitle title="Mine" source="manual" onRename={onRename} />);
    fireEvent.click(screen.getByRole("menuitem", { name: /Use automatic title/, hidden: true }));
    expect(onRename).toHaveBeenCalledWith("");
  });
});
