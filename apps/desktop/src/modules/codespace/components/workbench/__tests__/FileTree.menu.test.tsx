import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_TREE_ROW_HEIGHT, FileTree } from "../FileTree";

const rootDir = "/workspace/project";
const entries = [
  { path: "/workspace/project/src", kind: "directory" as const },
  { path: "/workspace/project/src/components", kind: "directory" as const },
  { path: "/workspace/project/src/index.ts", kind: "file" as const },
  { path: "/workspace/project/src/components/App.tsx", kind: "file" as const },
  { path: "/workspace/project/README.md", kind: "file" as const },
];

const item = (name: string) => screen.getByRole("treeitem", { name });
const focused = () => document.activeElement as HTMLElement;
const menuItems = () => within(screen.getByRole("menu")).getAllByRole("menuitem").map((entry) => entry.textContent);

function renderTree(props: Partial<Parameters<typeof FileTree>[0]> = {}) {
  return render(
    <FileTree
      rootDir={rootDir}
      entries={entries}
      activeFilePath="/workspace/project/src/index.ts"
      onOpenFile={vi.fn()}
      onCreateFile={vi.fn()}
      onCreateFolder={vi.fn()}
      onDeleteEntry={vi.fn()}
      onRenameEntry={vi.fn()}
      onRevealEntry={vi.fn()}
      {...props}
    />,
  );
}

describe("FileTree context menu (E18)", () => {
  const writeText = vi.fn();
  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  });

  it("right-click opens seven actions for the row", () => {
    renderTree();
    fireEvent.contextMenu(item("index.ts"), { clientX: 40, clientY: 60 });

    expect(menuItems()).toEqual([
      "New File",
      "New Folder",
      "Rename",
      "Delete",
      "Copy Path",
      "Copy Relative Path",
      "Reveal in Finder",
    ]);
    expect(screen.getByRole("menu", { name: "Actions for index.ts" })).toBeInTheDocument();
    expect(focused()).toHaveTextContent("New File");
  });

  it("copies the path relative to the root, and the absolute path", () => {
    renderTree();
    fireEvent.contextMenu(item("index.ts"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Relative Path" }));
    expect(writeText).toHaveBeenLastCalledWith("src/index.ts");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(item("index.ts"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Path" }));
    expect(writeText).toHaveBeenLastCalledWith("/workspace/project/src/index.ts");
  });

  it("Rename starts the in-place rename, Delete the confirmation", () => {
    renderTree();
    fireEvent.contextMenu(item("README.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(screen.getByRole("textbox", { name: "Rename README.md" })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename README.md" }), { key: "Escape" });
    fireEvent.contextMenu(item("README.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Delete README.md confirmation" })).toBeInTheDocument();
  });

  it("New File on a folder opens a name field inside that folder", () => {
    renderTree();
    fireEvent.contextMenu(item("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }));
    expect(screen.getByRole("textbox", { name: "New file name" })).toHaveValue("");
    expect(item("src")).toHaveAttribute("aria-expanded", "true");
  });

  it("New Folder on a file opens a name field in the file's folder", () => {
    renderTree();
    fireEvent.contextMenu(item("index.ts"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New Folder" }));
    expect(screen.getByRole("textbox", { name: "New folder name" })).toHaveValue("");
  });

  it("Reveal in Finder hands the relative path over", () => {
    const onRevealEntry = vi.fn();
    renderTree({ onRevealEntry });
    fireEvent.contextMenu(item("index.ts"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));
    expect(onRevealEntry).toHaveBeenCalledWith("src/index.ts");
  });

  it("leaves out actions the workspace cannot do", () => {
    renderTree({ onRevealEntry: undefined, onRenameEntry: undefined, onCreateFolder: undefined });
    fireEvent.contextMenu(item("index.ts"));
    expect(menuItems()).toEqual(["New File", "Delete", "Copy Path", "Copy Relative Path"]);
  });

  it("↑↓ move inside the menu; Escape closes it and returns to the row", () => {
    renderTree();
    fireEvent.contextMenu(item("README.md"));
    fireEvent.keyDown(focused(), { key: "ArrowDown" });
    expect(focused()).toHaveTextContent("New Folder");
    fireEvent.keyDown(focused(), { key: "ArrowUp" });
    fireEvent.keyDown(focused(), { key: "ArrowUp" });
    expect(focused()).toHaveTextContent("Reveal in Finder");

    fireEvent.keyDown(focused(), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(focused()).toBe(item("README.md"));
  });

  it("Shift+F10 and the menu key open it from the keyboard", () => {
    renderTree();
    item("README.md").focus();
    fireEvent.keyDown(item("README.md"), { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "Actions for README.md" })).toBeInTheDocument();
    fireEvent.keyDown(focused(), { key: "Escape" });

    fireEvent.keyDown(item("README.md"), { key: "ContextMenu" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("a click elsewhere closes it", () => {
    renderTree();
    fireEvent.contextMenu(item("README.md"));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("FileTree reveal active file (E20)", () => {
  it("marks the active file's row", () => {
    renderTree();
    expect(item("index.ts")).toHaveAttribute("aria-current", "page");
    expect(item("index.ts")).toHaveClass("codespace-workbench-tree-row-active");
  });

  it("opens the parent folders again and focuses the row", () => {
    renderTree({ activeFilePath: "/workspace/project/src/components/App.tsx" });
    fireEvent.click(item("src")); // collapse the auto-opened parent
    expect(screen.queryByRole("treeitem", { name: "App.tsx" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reveal active file" }));

    expect(item("App.tsx")).toBeInTheDocument();
    expect(focused()).toBe(item("App.tsx"));
    expect(item("src")).toHaveAttribute("aria-expanded", "true");
  });

  it("has no reveal button when no file is open", () => {
    renderTree({ activeFilePath: null });
    expect(screen.queryByRole("button", { name: "Reveal active file" })).not.toBeInTheDocument();
  });

  describe("in a long list", () => {
    const VIEWPORT = 260;
    const many = Array.from({ length: 2000 }, (_, index) => ({
      path: `/workspace/project/file-${String(index).padStart(4, "0")}.ts`,
      kind: "file" as const,
    }));
    let restore: () => void;
    beforeEach(() => {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains("codespace-filetree-scroll") ? VIEWPORT : 0;
        },
      });
      restore = () => {
        if (original) Object.defineProperty(HTMLElement.prototype, "clientHeight", original);
      };
    });
    afterEach(() => restore());

    it("scrolls the active row into view", () => {
      renderTree({ entries: many, activeFilePath: "/workspace/project/file-1500.ts" });

      fireEvent.click(screen.getByRole("button", { name: "Reveal active file" }));

      const scroller = document.querySelector<HTMLElement>(".codespace-filetree-scroll")!;
      expect(scroller.scrollTop).toBe(1501 * FILE_TREE_ROW_HEIGHT - VIEWPORT);
      expect(focused()).toBe(item("file-1500.ts"));
    });
  });
});

describe("FileTree Send to Thread (LOT2-60)", () => {
  it("is offered first when the pane can send, and hands on the row's relative path", () => {
    const onSendEntryToThread = vi.fn();
    renderTree({ onSendEntryToThread });
    fireEvent.contextMenu(item("index.ts"), { clientX: 40, clientY: 60 });
    expect(menuItems()[0]).toBe("Send to Thread");

    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Send to Thread" }));
    expect(onSendEntryToThread).toHaveBeenCalledWith("src/index.ts", "file");
  });

  it("sends a folder as a folder", () => {
    const onSendEntryToThread = vi.fn();
    renderTree({ onSendEntryToThread });
    fireEvent.contextMenu(item("components"), { clientX: 40, clientY: 60 });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Send to Thread" }));
    expect(onSendEntryToThread).toHaveBeenCalledWith("src/components", "directory");
  });
});
