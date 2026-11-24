import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(focused(), { key, ...init });

describe("FileTree keyboard and ARIA (E17)", () => {
  it("is a tree of treeitems with level, expanded and one tab stop", () => {
    render(<FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} />);

    const tree = screen.getByRole("tree", { name: "Files" });
    const rows = within(tree).getAllByRole("treeitem");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["src", "README.md"]);

    expect(item("src")).toHaveAttribute("aria-expanded", "false");
    expect(item("src")).toHaveAttribute("aria-level", "1");
    expect(item("README.md")).not.toHaveAttribute("aria-expanded");
    expect(item("src")).toHaveAttribute("aria-posinset", "1");
    expect(item("src")).toHaveAttribute("aria-setsize", "2");

    // Roving tabindex: exactly one row is in the tab order.
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    expect(item("src").tabIndex).toBe(0);
  });

  it("moves with ↑↓ and marks the row it is on as selected", () => {
    render(<FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} />);

    item("src").focus();
    press("ArrowDown");
    expect(focused()).toBe(item("README.md"));
    expect(item("README.md")).toHaveAttribute("aria-selected", "true");
    expect(item("README.md").tabIndex).toBe(0);
    expect(item("src").tabIndex).toBe(-1);
    expect(item("src")).toHaveAttribute("aria-selected", "false");

    press("ArrowDown"); // last row: stays
    expect(focused()).toBe(item("README.md"));
    press("ArrowUp");
    expect(focused()).toBe(item("src"));
    press("ArrowUp"); // first row: stays
    expect(focused()).toBe(item("src"));
  });

  it("→ opens a folder, then goes to its first child; ← closes it, then goes to the parent", () => {
    render(<FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} />);

    item("src").focus();
    press("ArrowRight");
    expect(item("src")).toHaveAttribute("aria-expanded", "true");
    expect(focused()).toBe(item("src"));

    press("ArrowRight");
    expect(focused()).toBe(item("components"));
    expect(item("components")).toHaveAttribute("aria-level", "2");

    press("ArrowDown");
    expect(focused()).toBe(item("index.ts"));
    press("ArrowLeft"); // a file: go to its folder
    expect(focused()).toBe(item("src"));
    press("ArrowLeft"); // an open folder: close it
    expect(item("src")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: "index.ts" })).not.toBeInTheDocument();
    expect(focused()).toBe(item("src"));
  });

  it("Enter opens a file and toggles a folder", () => {
    const onOpenFile = vi.fn();
    render(<FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={onOpenFile} />);

    item("src").focus();
    press("Enter");
    expect(item("src")).toHaveAttribute("aria-expanded", "true");

    item("README.md").focus();
    press("Enter");
    expect(onOpenFile).toHaveBeenCalledWith("/workspace/project/README.md", { preview: false });
  });

  it("Delete opens the delete confirmation for the row, Escape returns to the row", () => {
    const onDeleteEntry = vi.fn();
    render(
      <FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} onDeleteEntry={onDeleteEntry} />,
    );

    item("README.md").focus();
    press("Delete");
    const dialog = screen.getByRole("dialog", { name: "Delete README.md confirmation" });
    // Safe default: focus lands on Cancel, not on Delete.
    expect(focused()).toBe(within(dialog).getByRole("button", { name: "Cancel" }));

    fireEvent.keyDown(focused(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(focused()).toBe(item("README.md"));
    expect(onDeleteEntry).not.toHaveBeenCalled();
  });

  it("⌘⌫ also opens the delete confirmation (Mac keyboards have no Delete key)", () => {
    render(
      <FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} onDeleteEntry={vi.fn()} />,
    );

    item("README.md").focus();
    press("Backspace");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    press("Backspace", { metaKey: true });
    expect(screen.getByRole("dialog", { name: "Delete README.md confirmation" })).toBeInTheDocument();
  });

  it("F2 renames the row in place; Enter saves inside the same folder", async () => {
    const onRenameEntry = vi.fn().mockResolvedValue(undefined);
    render(
      <FileTree
        rootDir={rootDir}
        entries={entries}
        activeFilePath="/workspace/project/src/index.ts"
        onOpenFile={vi.fn()}
        onRenameEntry={onRenameEntry}
      />,
    );

    item("index.ts").focus();
    press("F2");
    const input = screen.getByRole("textbox", { name: "Rename index.ts" });
    expect(focused()).toBe(input);
    expect(input).toHaveValue("index.ts");

    fireEvent.change(input, { target: { value: "main.ts" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onRenameEntry).toHaveBeenCalledWith("src/index.ts", "src/main.ts", "file");
    expect(screen.queryByRole("textbox", { name: "Rename index.ts" })).not.toBeInTheDocument();
  });

  it("F2 then Escape leaves the name alone and returns to the row", () => {
    const onRenameEntry = vi.fn();
    render(
      <FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} onRenameEntry={onRenameEntry} />,
    );

    item("README.md").focus();
    press("F2");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename README.md" }), { key: "Escape" });
    expect(onRenameEntry).not.toHaveBeenCalled();
    expect(focused()).toBe(item("README.md"));
  });

  it("keeps a failed rename open with the error", async () => {
    const onRenameEntry = vi.fn().mockRejectedValue(new Error("already exists"));
    render(
      <FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} onRenameEntry={onRenameEntry} />,
    );

    item("README.md").focus();
    press("F2");
    const input = screen.getByRole("textbox", { name: "Rename README.md" });
    fireEvent.change(input, { target: { value: "docs.md" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(screen.getByRole("textbox", { name: "Rename README.md" })).toBeInTheDocument();
    expect(screen.getByText(/already exists/)).toBeInTheDocument();
  });

  it("F2 does nothing when renaming is not offered", () => {
    render(<FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} />);
    item("README.md").focus();
    press("F2");
    expect(screen.queryByRole("textbox", { name: /Rename/ })).not.toBeInTheDocument();
  });

  it("clicking a row makes it the tab stop", () => {
    render(<FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} />);
    fireEvent.click(item("README.md"));
    expect(item("README.md").tabIndex).toBe(0);
    expect(item("README.md")).toHaveAttribute("aria-selected", "true");
  });

  it("marks a folder that is loading as busy", () => {
    render(
      <FileTree
        rootDir={rootDir}
        entries={[{ path: "/workspace/project/src", kind: "directory" }]}
        activeFilePath={null}
        onOpenFile={vi.fn()}
        loadedDirectories={new Set([rootDir])}
        loadingDirectories={new Set(["/workspace/project/src"])}
        onLoadDirectory={vi.fn()}
      />,
    );
    fireEvent.click(item("src"));
    expect(item("src")).toHaveAttribute("aria-busy", "true");
  });
});

describe("FileTree virtual rows (E14)", () => {
  const ROW = FILE_TREE_ROW_HEIGHT;
  const VIEWPORT = 260; // 10 rows
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

  it("puts only the visible rows plus a small overscan in the DOM", () => {
    render(<FileTree rootDir={rootDir} entries={many} activeFilePath={null} onOpenFile={vi.fn()} />);

    const rows = screen.getAllByRole("treeitem");
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.length).toBeLessThanOrEqual(30);
    expect(item("file-0000.ts")).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "file-1999.ts" })).not.toBeInTheDocument();
    // The whole list still has its real height, so the scrollbar is honest.
    const spacer = document.querySelector<HTMLElement>(".codespace-filetree-rows")!;
    expect(spacer.style.height).toBe(`${2000 * ROW}px`);
    // Screen readers still hear where a row sits in the full list.
    expect(item("file-0000.ts")).toHaveAttribute("aria-setsize", "2000");
  });

  it("renders the rows around the scroll position", () => {
    render(<FileTree rootDir={rootDir} entries={many} activeFilePath={null} onOpenFile={vi.fn()} />);

    const scroller = document.querySelector<HTMLElement>(".codespace-filetree-scroll")!;
    scroller.scrollTop = 1000 * ROW;
    fireEvent.scroll(scroller);

    expect(item("file-1000.ts")).toBeInTheDocument();
    expect(item("file-1000.ts").style.top).toBe(`${1000 * ROW}px`);
    expect(screen.queryByRole("treeitem", { name: "file-0100.ts" })).not.toBeInTheDocument();
    // The first row still holds the tree's tab stop, so it stays; nothing else far away does.
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(30);
  });

  it("scrolls a row reached by keyboard into view and keeps focus on it", () => {
    render(<FileTree rootDir={rootDir} entries={many} activeFilePath={null} onOpenFile={vi.fn()} />);

    const scroller = document.querySelector<HTMLElement>(".codespace-filetree-scroll")!;
    item("file-0000.ts").focus();
    press("End");
    expect(focused()).toBe(item("file-1999.ts"));
    expect(scroller.scrollTop).toBe(2000 * ROW - VIEWPORT);

    press("Home");
    expect(focused()).toBe(item("file-0000.ts"));
    expect(scroller.scrollTop).toBe(0);
  });

  it("keeps the focused row in the DOM after it is scrolled away", () => {
    render(<FileTree rootDir={rootDir} entries={many} activeFilePath={null} onOpenFile={vi.fn()} />);

    item("file-0003.ts").focus();
    press("ArrowDown");
    const scroller = document.querySelector<HTMLElement>(".codespace-filetree-scroll")!;
    scroller.scrollTop = 1500 * ROW;
    fireEvent.scroll(scroller);

    expect(item("file-0004.ts")).toBeInTheDocument();
    expect(focused()).toBe(item("file-0004.ts"));
    press("ArrowDown");
    expect(focused()).toBe(item("file-0005.ts"));
  });
});
