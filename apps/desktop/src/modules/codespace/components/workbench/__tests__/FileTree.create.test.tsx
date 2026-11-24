import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FILE_TREE_ROW_HEIGHT, FileTree } from "../FileTree";

const rootDir = "/workspace/project";
const entries = [
  { path: "/workspace/project/src", kind: "directory" as const },
  { path: "/workspace/project/src/components", kind: "directory" as const },
  { path: "/workspace/project/src/index.ts", kind: "file" as const },
  { path: "/workspace/project/README.md", kind: "file" as const },
];

const item = (name: string) => screen.getByRole("treeitem", { name });
const focused = () => document.activeElement as HTMLElement;
/** The absolutely positioned block that holds an input: its `top` is where it sits in the tree. */
const rowOf = (element: HTMLElement) => element.closest<HTMLElement>("[data-tree-row]")!;

function renderTree(props: Partial<Parameters<typeof FileTree>[0]> = {}) {
  const onCreateFile = vi.fn().mockResolvedValue(undefined);
  const onCreateFolder = vi.fn().mockResolvedValue(undefined);
  render(
    <FileTree
      rootDir={rootDir}
      entries={entries}
      activeFilePath={null}
      onOpenFile={vi.fn()}
      onCreateFile={onCreateFile}
      onCreateFolder={onCreateFolder}
      onDeleteEntry={vi.fn()}
      {...props}
    />,
  );
  return { onCreateFile, onCreateFolder };
}

const submit = async (input: HTMLElement) => {
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
};

describe("FileTree rows have no delete button", () => {
  it("deletes from the menu or the keyboard only", () => {
    renderTree();
    expect(screen.queryByRole("button", { name: /Open delete confirmation/ })).not.toBeInTheDocument();
    expect(screen.queryByTitle("Delete")).not.toBeInTheDocument();
  });
});

describe("FileTree new file / folder in place (like VS Code)", () => {
  it("New File on a folder opens it and puts an empty name field as its first row", () => {
    renderTree();
    fireEvent.contextMenu(item("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }));

    const input = screen.getByRole("textbox", { name: "New file name" });
    expect(input).toHaveValue("");
    expect(focused()).toBe(input);
    expect(within(screen.getByRole("tree")).getByRole("textbox", { name: "New file name" })).toBe(input);
    expect(item("src")).toHaveAttribute("aria-expanded", "true");
    // Right under the folder, above its first child.
    expect(rowOf(input).style.top).toBe(`${FILE_TREE_ROW_HEIGHT}px`);
    expect(item("components").style.top).toBe(`${FILE_TREE_ROW_HEIGHT * 2}px`);
    // No field above the tree any more.
    expect(screen.queryByRole("textbox", { name: /path/ })).not.toBeInTheDocument();
  });

  it("creates the name inside that folder", async () => {
    const { onCreateFile } = renderTree();
    fireEvent.contextMenu(item("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }));
    const input = screen.getByRole("textbox", { name: "New file name" });
    fireEvent.change(input, { target: { value: "new.ts" } });
    await submit(input);

    expect(onCreateFile).toHaveBeenCalledWith("src/new.ts");
    expect(screen.queryByRole("textbox", { name: "New file name" })).not.toBeInTheDocument();
  });

  it("New Folder on a file creates it beside the file", async () => {
    const { onCreateFolder } = renderTree();
    fireEvent.contextMenu(item("src"));
    fireEvent.keyDown(focused(), { key: "Escape" });
    fireEvent.click(item("src"));
    fireEvent.contextMenu(item("index.ts"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New Folder" }));

    const input = screen.getByRole("textbox", { name: "New folder name" });
    fireEvent.change(input, { target: { value: "lib" } });
    await submit(input);
    expect(onCreateFolder).toHaveBeenCalledWith("src/lib");
  });

  it("a typed sub-path still makes the folders on the way", async () => {
    const { onCreateFile } = renderTree();
    fireEvent.contextMenu(item("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }));
    const input = screen.getByRole("textbox", { name: "New file name" });
    fireEvent.change(input, { target: { value: "a/b.ts" } });
    await submit(input);
    expect(onCreateFile).toHaveBeenCalledWith("src/a/b.ts");
  });

  it("the toolbar button with nothing selected creates at the root, as the first row", async () => {
    const { onCreateFile } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "New file" }));

    const input = screen.getByRole("textbox", { name: "New file name" });
    expect(rowOf(input).style.top).toBe("0px");
    fireEvent.change(input, { target: { value: "x.ts" } });
    await submit(input);
    expect(onCreateFile).toHaveBeenCalledWith("x.ts");
  });

  it("the toolbar button creates in the selected folder, or beside the selected file", async () => {
    const { onCreateFolder } = renderTree();
    act(() => item("src").focus());
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(item("src")).toHaveAttribute("aria-expanded", "true");
    const input = screen.getByRole("textbox", { name: "New folder name" });
    fireEvent.change(input, { target: { value: "hooks" } });
    await submit(input);
    expect(onCreateFolder).toHaveBeenCalledWith("src/hooks");

    act(() => item("README.md").focus());
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const second = screen.getByRole("textbox", { name: "New folder name" });
    fireEvent.change(second, { target: { value: "docs" } });
    await submit(second);
    expect(onCreateFolder).toHaveBeenLastCalledWith("docs");
  });

  it("Escape cancels and returns to the folder row", () => {
    const { onCreateFile } = renderTree();
    fireEvent.contextMenu(item("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New file name" }), { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "New file name" })).not.toBeInTheDocument();
    expect(focused()).toBe(item("src"));
    expect(onCreateFile).not.toHaveBeenCalled();
  });

  it("clicking away cancels an empty field but keeps a typed one", () => {
    renderTree();
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    fireEvent.blur(screen.getByRole("textbox", { name: "New file name" }));
    expect(screen.queryByRole("textbox", { name: "New file name" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New file name" }), { target: { value: "half" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "New file name" }));
    expect(screen.getByRole("textbox", { name: "New file name" })).toHaveValue("half");
  });

  it("shows a bad name, and a failed create, right under the field", async () => {
    const onCreateFile = vi.fn().mockRejectedValue(new Error("Path already exists"));
    renderTree({ onCreateFile });
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const input = screen.getByRole("textbox", { name: "New file name" });

    fireEvent.change(input, { target: { value: "../x.ts" } });
    await submit(input);
    expect(within(rowOf(input)).getByText("Use a path inside this workspace")).toBeInTheDocument();
    expect(onCreateFile).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "README.md" } });
    await submit(input);
    expect(within(rowOf(input)).getByText(/Path already exists/)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    // The rows below make room for the message.
    expect(item("src").style.top).not.toBe(`${FILE_TREE_ROW_HEIGHT}px`);
  });

  it("clears a filter first, so the field has a real folder to sit in", () => {
    renderTree();
    fireEvent.change(screen.getByRole("textbox", { name: "Search files" }), { target: { value: "read" } });
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    expect(screen.getByRole("textbox", { name: "Search files" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "New file name" })).toBeInTheDocument();
  });

  it("↑↓ in the tree skip the field", () => {
    renderTree();
    fireEvent.click(item("src"));
    fireEvent.contextMenu(item("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New file name" }), { target: { value: "keep" } });

    item("src").focus();
    fireEvent.keyDown(item("src"), { key: "ArrowDown" });
    expect(focused()).toBe(item("components"));
  });
});

describe("FileTree requests from outside the tree (launcher, palette)", () => {
  it("a new create request opens the name field where the toolbar button would", () => {
    const view = render(
      <FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} onCreateFile={vi.fn()} createRequest={null} />,
    );
    expect(screen.queryByRole("textbox", { name: "New file name" })).not.toBeInTheDocument();

    view.rerender(
      <FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} onCreateFile={vi.fn()} createRequest={{ kind: "file", nonce: 1 }} />,
    );
    expect(screen.getByRole("textbox", { name: "New file name" })).toHaveFocus();
  });

  it("a new reveal request reveals the active file", () => {
    const props = { rootDir, entries, activeFilePath: "/workspace/project/src/index.ts", onOpenFile: vi.fn() };
    const view = render(<FileTree {...props} revealActiveRequest={0} />);
    fireEvent.click(item("src"));
    expect(screen.queryByRole("treeitem", { name: "index.ts" })).not.toBeInTheDocument();

    view.rerender(<FileTree {...props} revealActiveRequest={1} />);
    expect(focused()).toBe(item("index.ts"));
  });
});
