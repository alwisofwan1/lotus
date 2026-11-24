import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileTree } from "../FileTree";

describe("FileTree", () => {
  const rootDir = "/workspace/project";
  const entries = [
    { path: "/workspace/project/src", kind: "directory" as const },
    { path: "/workspace/project/src/components", kind: "directory" as const },
    { path: "/workspace/project/src/index.ts", kind: "file" as const },
    { path: "/workspace/project/src/components/App.tsx", kind: "file" as const },
    { path: "/workspace/project/README.md", kind: "file" as const },
  ];

  it("renders directories collapsed and expands on click", () => {
    const onOpenFile = vi.fn();
    render(
      <FileTree
        rootDir={rootDir}
        entries={entries}
        activeFilePath={null}
        onOpenFile={onOpenFile}
      />,
    );

    expect(screen.getByRole("treeitem", { name: "src" })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "index.ts" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("treeitem", { name: "src" }));

    const fileButton = screen.getByRole("treeitem", { name: "index.ts" });
    expect(fileButton).toBeInTheDocument();

    fireEvent.click(fileButton);
    expect(onOpenFile).toHaveBeenCalledWith("/workspace/project/src/index.ts", { preview: true });
  });

  it("opens a file as a preview on click and keeps it on double-click or Enter (LOT2-210)", () => {
    const onOpenFile = vi.fn();
    render(<FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={onOpenFile} />);
    const readme = screen.getByRole("treeitem", { name: "README.md" });
    fireEvent.click(readme);
    expect(onOpenFile).toHaveBeenLastCalledWith("/workspace/project/README.md", { preview: true });
    fireEvent.doubleClick(readme);
    expect(onOpenFile).toHaveBeenLastCalledWith("/workspace/project/README.md", { preview: false });
    fireEvent.keyDown(readme, { key: "Enter" });
    expect(onOpenFile).toHaveBeenLastCalledWith("/workspace/project/README.md", { preview: false });
  });

  it("says when a folder lists only its first entries (LOT2-211)", () => {
    render(
      <FileTree
        rootDir={rootDir}
        entries={entries}
        activeFilePath={null}
        onOpenFile={vi.fn()}
        truncatedDirectories={new Set(["/workspace/project/src"])}
      />,
    );
    expect(screen.queryByText(/first 10,000 entries/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("treeitem", { name: "src" }));
    const note = screen.getByText(/first 10,000 entries/);
    // Under the folder's last child, not between its rows.
    const lastChild = screen.getByRole("treeitem", { name: "index.ts" });
    expect(parseFloat(note.style.top)).toBeGreaterThan(parseFloat(lastChild.style.top));
    expect(parseFloat(note.style.top)).toBeLessThan(parseFloat(screen.getByRole("treeitem", { name: "README.md" }).style.top));
  });

  it("auto-expands parent directories for active file", () => {
    render(
      <FileTree
        rootDir={rootDir}
        entries={entries}
        activeFilePath="/workspace/project/src/components/App.tsx"
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByRole("treeitem", { name: "components" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "App.tsx" })).toBeInTheDocument();
  });

  it("allows manually collapsing directories that were auto-expanded for the active file", () => {
    render(
      <FileTree
        rootDir={rootDir}
        entries={entries}
        activeFilePath="/workspace/project/src/components/App.tsx"
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByRole("treeitem", { name: "App.tsx" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("treeitem", { name: "src" }));

    expect(screen.queryByRole("treeitem", { name: "components" })).not.toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "App.tsx" })).not.toBeInTheDocument();
  });

  it("renders empty directories from native entries", () => {
    render(
      <FileTree
        rootDir={rootDir}
        entries={[{ path: "/workspace/project/empty-folder", kind: "directory" }]}
        activeFilePath={null}
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByRole("treeitem", { name: "empty-folder" })).toBeInTheDocument();
  });

  it("shows git status actions for changed files", () => {
    const onStageFile = vi.fn();
    const onUnstageFile = vi.fn();
    render(
      <FileTree
        rootDir={rootDir}
        entries={[{ path: "/workspace/project/README.md", kind: "file" }]}
        activeFilePath={null}
        gitStatusByPath={new Map([
          ["/workspace/project/README.md", {
            path: "/workspace/project/README.md",
            relativePath: "README.md",
            staged: "modified",
            unstaged: "modified",
          }],
        ])}
        onStageFile={onStageFile}
        onUnstageFile={onUnstageFile}
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByText("M")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stage README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Unstage README.md" }));

    expect(onStageFile).toHaveBeenCalledWith("/workspace/project/README.md");
    expect(onUnstageFile).toHaveBeenCalledWith("/workspace/project/README.md");
  });

  it("creates files from the explorer toolbar", async () => {
    const onCreateFile = vi.fn().mockResolvedValue(undefined);
    render(
      <FileTree
        rootDir={rootDir}
        entries={entries}
        activeFilePath={null}
        onCreateFile={onCreateFile}
        onOpenFile={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New file name" }), {
      target: { value: "src/new-file.ts" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New file name" }), { key: "Enter" });

    await waitFor(() => {
      expect(onCreateFile).toHaveBeenCalledWith("src/new-file.ts");
    });
  });

  it("creates folders from the explorer toolbar", async () => {
    const onCreateFolder = vi.fn().mockResolvedValue(undefined);
    render(
      <FileTree
        rootDir={rootDir}
        entries={entries}
        activeFilePath={null}
        onCreateFolder={onCreateFolder}
        onOpenFile={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New folder name" }), {
      target: { value: "src/new-folder" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New folder name" }), { key: "Enter" });

    await waitFor(() => {
      expect(onCreateFolder).toHaveBeenCalledWith("src/new-folder");
    });
  });

  it("opens a confirmation popover before deleting files", async () => {
    const onDeleteEntry = vi.fn().mockResolvedValue(undefined);
    render(
      <FileTree
        rootDir={rootDir}
        entries={[{ path: "/workspace/project/README.md", kind: "file" }]}
        activeFilePath={null}
        onDeleteEntry={onDeleteEntry}
        onOpenFile={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("treeitem", { name: "README.md" }), { key: "Delete" });

    expect(screen.getByRole("dialog", { name: "Delete README.md confirmation" })).toBeInTheDocument();
    expect(onDeleteEntry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete README.md" }));

    await waitFor(() => {
      expect(onDeleteEntry).toHaveBeenCalledWith("README.md", "file");
    });
  });

  it("can cancel the delete confirmation popover", () => {
    const onDeleteEntry = vi.fn().mockResolvedValue(undefined);
    render(
      <FileTree
        rootDir={rootDir}
        entries={[{ path: "/workspace/project/README.md", kind: "file" }]}
        activeFilePath={null}
        onDeleteEntry={onDeleteEntry}
        onOpenFile={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("treeitem", { name: "README.md" }), { key: "Delete" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: "Delete README.md confirmation" })).not.toBeInTheDocument();
    expect(onDeleteEntry).not.toHaveBeenCalled();
  });

  it("opens a confirmation popover before deleting folders", async () => {
    const onDeleteEntry = vi.fn().mockResolvedValue(undefined);
    render(
      <FileTree
        rootDir={rootDir}
        entries={[{ path: "/workspace/project/src", kind: "directory" }]}
        activeFilePath={null}
        onDeleteEntry={onDeleteEntry}
        onOpenFile={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("treeitem", { name: "src" }), { key: "Delete" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete src" }));

    await waitFor(() => {
      expect(onDeleteEntry).toHaveBeenCalledWith("src", "directory");
    });
  });

  it("labels the sidebar button as Hide sidebar", () => {
    const onCollapse = vi.fn();
    render(<FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} onCollapse={onCollapse} />);

    const hide = screen.getByRole("button", { name: "Hide sidebar" });
    expect(hide).toHaveAttribute("title", "Hide sidebar");
    fireEvent.click(hide);
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("collapses every open folder, including the active file's parents", () => {
    render(
      <FileTree
        rootDir={rootDir}
        entries={entries}
        activeFilePath="/workspace/project/src/components/App.tsx"
        onOpenFile={vi.fn()}
      />,
    );
    expect(screen.getByRole("treeitem", { name: "App.tsx" })).toBeInTheDocument();

    const collapse = screen.getByRole("button", { name: "Collapse folders" });
    expect(collapse).toHaveAttribute("title", "Collapse folders");
    fireEvent.click(collapse);

    expect(screen.queryByRole("treeitem", { name: "index.ts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "App.tsx" })).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("treeitem", { name: "src" }));
    expect(screen.getByRole("treeitem", { name: "index.ts" })).toBeInTheDocument();
  });

  it("collapses folders while a filter is active", () => {
    render(<FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search files"), { target: { value: "App" } });
    expect(screen.getByRole("treeitem", { name: "App.tsx" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse folders" }));

    expect(screen.queryByRole("treeitem", { name: "App.tsx" })).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute("aria-expanded", "false");
  });

  it("refreshes files through onRefresh", () => {
    const onRefresh = vi.fn();
    render(<FileTree rootDir={rootDir} entries={entries} activeFilePath={null} onOpenFile={vi.fn()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh files" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("warns in the delete confirmation when the file has unsaved edits", () => {
    render(
      <FileTree
        rootDir={rootDir}
        entries={[{ path: "/workspace/project/README.md", kind: "file" }]}
        activeFilePath={null}
        unsavedPaths={["/workspace/project/README.md"]}
        onDeleteEntry={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("treeitem", { name: "README.md" }), { key: "Delete" });

    expect(screen.getByRole("dialog", { name: "Delete README.md confirmation" })).toHaveTextContent(
      "Unsaved edits in README.md will be lost.",
    );
  });

  it("counts unsaved files inside a folder being deleted, and says nothing for clean ones", () => {
    render(
      <FileTree
        rootDir={rootDir}
        entries={entries}
        activeFilePath={null}
        unsavedPaths={["/workspace/project/src/index.ts", "/workspace/project/src/components/App.tsx"]}
        onDeleteEntry={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("treeitem", { name: "src" }), { key: "Delete" });
    expect(screen.getByRole("dialog", { name: "Delete src confirmation" })).toHaveTextContent(
      "Unsaved edits in 2 files will be lost.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByRole("treeitem", { name: "README.md" }), { key: "Delete" });
    expect(screen.getByRole("dialog", { name: "Delete README.md confirmation" })).not.toHaveTextContent("Unsaved");
  });

  it("marks a file with unsaved edits in the tree, as its tab is marked (Theme 13)", () => {
    render(
      <FileTree
        rootDir={rootDir}
        entries={entries}
        activeFilePath={null}
        unsavedPaths={["/workspace/project/README.md"]}
        onOpenFile={vi.fn()}
      />,
    );

    expect(within(screen.getByRole("treeitem", { name: "README.md" })).getByLabelText("Unsaved changes")).toBeInTheDocument();
    expect(within(screen.getByRole("treeitem", { name: "src" })).queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
  });

  describe("folders that load when opened", () => {
    const shallow = [
      { path: "/workspace/project/src", kind: "directory" as const },
      { path: "/workspace/project/README.md", kind: "file" as const },
    ];

    it("asks for a folder's contents the first time it opens, and shows that it is loading", () => {
      const onLoadDirectory = vi.fn();
      const props = {
        rootDir,
        entries: shallow,
        activeFilePath: null,
        loadedDirectories: new Set([rootDir]),
        onLoadDirectory,
        onOpenFile: vi.fn(),
      };
      const { rerender } = render(<FileTree {...props} />);
      expect(onLoadDirectory).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("treeitem", { name: "src" }));
      expect(onLoadDirectory).toHaveBeenCalledTimes(1);
      expect(onLoadDirectory).toHaveBeenCalledWith("/workspace/project/src");

      rerender(<FileTree {...props} loadingDirectories={new Set(["/workspace/project/src"])} />);
      expect(screen.getByText("Loading…")).toBeInTheDocument();
      expect(onLoadDirectory).toHaveBeenCalledTimes(1);
    });

    it("asks again after the parent dropped its listings", () => {
      const onLoadDirectory = vi.fn();
      const props = {
        rootDir,
        entries: shallow,
        activeFilePath: null,
        onLoadDirectory,
        onOpenFile: vi.fn(),
      };
      const { rerender } = render(<FileTree {...props} loadedDirectories={new Set([rootDir])} />);
      fireEvent.click(screen.getByRole("treeitem", { name: "src" }));
      rerender(<FileTree {...props} loadedDirectories={new Set([rootDir])} loadingDirectories={new Set(["/workspace/project/src"])} />);
      rerender(<FileTree {...props} loadedDirectories={new Set([rootDir, "/workspace/project/src"])} />);
      expect(onLoadDirectory).toHaveBeenCalledTimes(1);

      rerender(<FileTree {...props} loadedDirectories={new Set([rootDir])} />);

      expect(onLoadDirectory).toHaveBeenCalledTimes(2);
    });

    it("asks for nothing while it has no way to load, and asks once it does", () => {
      const onLoadDirectory = vi.fn();
      const props = { rootDir, entries: shallow, activeFilePath: null, loadedDirectories: new Set([rootDir]), onOpenFile: vi.fn() };
      const { rerender } = render(<FileTree {...props} />);
      fireEvent.click(screen.getByRole("treeitem", { name: "src" }));

      rerender(<FileTree {...props} onLoadDirectory={onLoadDirectory} />);

      expect(onLoadDirectory).toHaveBeenCalledWith("/workspace/project/src");
    });

    it("asks again when a load was dropped before it finished", () => {
      const onLoadDirectory = vi.fn();
      const props = { rootDir, entries: shallow, activeFilePath: null, onLoadDirectory, onOpenFile: vi.fn() };
      const { rerender } = render(<FileTree {...props} loadedDirectories={new Set([rootDir])} />);
      fireEvent.click(screen.getByRole("treeitem", { name: "src" }));
      rerender(<FileTree {...props} loadedDirectories={new Set([rootDir])} loadingDirectories={new Set(["/workspace/project/src"])} />);
      expect(onLoadDirectory).toHaveBeenCalledTimes(1);

      rerender(<FileTree {...props} loadedDirectories={new Set([rootDir])} loadingDirectories={new Set()} />);

      expect(onLoadDirectory).toHaveBeenCalledTimes(2);
    });

    it("does not ask again for a folder that is already loaded", () => {
      const onLoadDirectory = vi.fn();
      render(
        <FileTree
          rootDir={rootDir}
          entries={entries}
          activeFilePath={null}
          loadedDirectories={new Set([rootDir, "/workspace/project/src"])}
          onLoadDirectory={onLoadDirectory}
          onOpenFile={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole("treeitem", { name: "src" }));

      expect(onLoadDirectory).not.toHaveBeenCalledWith("/workspace/project/src");
      expect(screen.getByRole("treeitem", { name: "index.ts" })).toBeInTheDocument();
    });

    it("loads the folders around the active file", () => {
      const onLoadDirectory = vi.fn();
      render(
        <FileTree
          rootDir={rootDir}
          entries={[
            { path: "/workspace/project/src", kind: "directory" },
            { path: "/workspace/project/src/components", kind: "directory" },
            { path: "/workspace/project/src/components/App.tsx", kind: "file" },
          ]}
          activeFilePath="/workspace/project/src/components/App.tsx"
          loadedDirectories={new Set([rootDir])}
          onLoadDirectory={onLoadDirectory}
          onOpenFile={vi.fn()}
        />,
      );

      expect(onLoadDirectory).toHaveBeenCalledWith("/workspace/project/src");
      expect(onLoadDirectory).toHaveBeenCalledWith("/workspace/project/src/components");
    });

    it("does not crawl every folder while a filter is typed", () => {
      const onLoadDirectory = vi.fn();
      render(
        <FileTree
          rootDir={rootDir}
          entries={shallow}
          activeFilePath={null}
          loadedDirectories={new Set([rootDir])}
          onLoadDirectory={onLoadDirectory}
          onOpenFile={vi.fn()}
        />,
      );

      fireEvent.change(screen.getByPlaceholderText("Search files"), { target: { value: "src" } });

      expect(onLoadDirectory).not.toHaveBeenCalled();
    });

    it("tells the parent when a filter starts, so it can load a deeper list to search", () => {
      const onSearchStart = vi.fn();
      render(<FileTree rootDir={rootDir} entries={shallow} activeFilePath={null} onSearchStart={onSearchStart} onOpenFile={vi.fn()} />);

      fireEvent.change(screen.getByPlaceholderText("Search files"), { target: { value: "s" } });
      fireEvent.change(screen.getByPlaceholderText("Search files"), { target: { value: "sr" } });

      expect(onSearchStart).toHaveBeenCalledTimes(1);
    });

    it("leaves out the file count when it is not known", () => {
      render(<FileTree rootDir={rootDir} entries={shallow} activeFilePath={null} fileCount={null} onOpenFile={vi.fn()} />);
      expect(screen.queryByText(/\d+ files?/)).toBeNull();
      expect(screen.queryByTitle(/files?$/)).toBeNull();
      expect(screen.getByTitle(rootDir)).toBeInTheDocument();
    });

    it("names the folder in one header row; the full path is its tooltip", () => {
      render(<FileTree rootDir={rootDir} entries={entries} activeFilePath={null} fileCount={3} onOpenFile={vi.fn()} />);
      const name = screen.getByText("project");
      expect(name).toHaveAttribute("title", `${rootDir} · 3 files`);
      expect(screen.queryByText(rootDir)).not.toBeInTheDocument();
      expect(name.closest(".codespace-filetree-header")).toContainElement(
        screen.getByRole("toolbar", { name: "File explorer actions" }),
      );
    });
  });
});
