import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoToFilePalette } from "../GoToFilePalette";

const root = "/repo";
const files = [
  "/repo/src/modules/codespace/components/WorkbenchCell.tsx",
  "/repo/src/modules/codespace/components/workbench/WorkbenchBrowserTab.tsx",
  "/repo/src/web/cache.ts",
  "/repo/README.md",
];

function setup(props: Partial<Parameters<typeof GoToFilePalette>[0]> = {}) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  render(<GoToFilePalette rootDir={root} files={files} truncated={false} onOpen={onOpen} onClose={onClose} {...props} />);
  const input = screen.getByRole("combobox", { name: "Go to file" });
  return { onOpen, onClose, input };
}

const typeQuery = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

describe("GoToFilePalette", () => {
  it("focuses the input and says how many files it can search", () => {
    const { input } = setup();
    expect(input).toHaveFocus();
    expect(screen.getByText("Type to search 4 files")).toBeInTheDocument();
  });

  it("says it is indexing while the list is not in yet", () => {
    setup({ files: null });
    expect(screen.getByText("Indexing files…")).toBeInTheDocument();
  });

  it("ranks, shows the file name first with matched letters marked, and the folder after", async () => {
    const { input } = setup();
    typeQuery(input, "wbc");

    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("WorkbenchCell.tsx");
    expect(options[0]).toHaveTextContent("src/modules/codespace/components");
    expect(options[0].querySelectorAll("mark")).toHaveLength(3);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(`${options.length} of 4`)).toBeInTheDocument();
  });

  it("moves with the arrow keys, wrapping at both ends, and opens with Enter", async () => {
    const { input, onOpen } = setup();
    typeQuery(input, "wbc");
    const options = await screen.findAllByRole("option");
    expect(options.length).toBeGreaterThan(1);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", options[options.length - 1].id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("/repo/src/modules/codespace/components/WorkbenchCell.tsx", undefined);
  });

  it("opens at a line when the query ends in :number", async () => {
    const { input, onOpen } = setup();
    typeQuery(input, "readme:42");
    await screen.findAllByRole("option");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("/repo/README.md", 42);
  });

  it("opens a clicked row", async () => {
    const { input, onOpen } = setup();
    typeQuery(input, "cache");
    fireEvent.click(await screen.findByRole("option", { name: /cache\.ts/ }));
    expect(onOpen).toHaveBeenCalledWith("/repo/src/web/cache.ts", undefined);
  });

  it("closes on Escape and says when nothing matches", async () => {
    const { input, onClose } = setup();
    typeQuery(input, "zzzz");
    await waitFor(() => expect(screen.getByText("No file matches zzzz")).toBeInTheDocument());
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("warns when the index was cut short", () => {
    setup({ truncated: true });
    expect(screen.getByText(/Type to search 4\+ files/)).toBeInTheDocument();
  });

  it("Enter right after typing opens the match for what was typed, not the last settled query", () => {
    const { input, onOpen } = setup();
    typeQuery(input, "w");
    typeQuery(input, "cache:7");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("/repo/src/web/cache.ts", 7);
  });

  it("says why when the file list could not be read", () => {
    setup({ files: [], error: "Permission denied" });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not list the files: Permission denied");
  });

  it("marks the right letters after an emoji in the name", async () => {
    const { input } = setup({ files: ["/repo/🙂notes.md"] });
    typeQuery(input, "notes");
    const option = await screen.findByRole("option");
    expect([...option.querySelectorAll("mark")].map((mark) => mark.textContent).join("")).toBe("notes");
  });
});
