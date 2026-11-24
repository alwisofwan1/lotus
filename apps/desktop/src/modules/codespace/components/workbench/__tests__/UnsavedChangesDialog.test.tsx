import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnsavedChangesDialog } from "../UnsavedChangesDialog";

function setup(paths: string[], extra: Partial<Parameters<typeof UnsavedChangesDialog>[0]> = {}) {
  const handlers = { onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() };
  render(<UnsavedChangesDialog paths={paths} rootDir="/repo" {...handlers} {...extra} />);
  return handlers;
}

describe("UnsavedChangesDialog", () => {
  it("names the one file and offers Save, Don't save and Cancel", () => {
    const h = setup(["/repo/src/UserController.php"]);

    expect(screen.getByRole("alertdialog", { name: "Save changes to UserController.php?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Don't save" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.onSave).toHaveBeenCalledTimes(1);
    expect(h.onDiscard).toHaveBeenCalledTimes(1);
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("counts several files and lists them relative to the root", () => {
    setup(["/repo/a.ts", "/repo/src/b.ts"]);

    expect(screen.getByRole("alertdialog", { name: "Save changes to 2 files?" })).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
  });

  it("Escape cancels", () => {
    const h = setup(["/repo/a.ts"]);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("puts focus on Save", () => {
    setup(["/repo/a.ts"]);
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
  });

  it("shows why saving failed and keeps every choice available", () => {
    setup(["/repo/a.ts"], { error: "Could not save a.ts: File has changed on disk" });
    expect(screen.getByRole("alert")).toHaveTextContent("File has changed on disk");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("shows progress while saving and blocks a second click", () => {
    const h = setup(["/repo/a.ts"], { busy: true });
    const save = screen.getByRole("button", { name: /Saving/ });
    fireEvent.click(save);
    expect(h.onSave).not.toHaveBeenCalled();
  });

  it("ignores Cancel, Don't save and Escape while a save is running", () => {
    const h = setup(["/repo/a.ts"], { busy: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Don't save" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(h.onCancel).not.toHaveBeenCalled();
    expect(h.onDiscard).not.toHaveBeenCalled();
  });
});
