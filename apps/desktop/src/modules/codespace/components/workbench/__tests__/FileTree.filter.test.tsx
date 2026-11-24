import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree } from "../FileTree";

// The tree has only read the root; the index knows every file.
const rootDir = "/workspace/project";
const shallow = [
  { path: "/workspace/project/src", kind: "directory" as const },
  { path: "/workspace/project/docs", kind: "directory" as const },
  { path: "/workspace/project/README.md", kind: "file" as const },
];
const index = [
  "/workspace/project/README.md",
  "/workspace/project/docs/guide.md",
  "/workspace/project/src/index.ts",
  "/workspace/project/src/components/FileTree.tsx",
  "/workspace/project/src/components/App.tsx",
];

const search = () => screen.getByRole("textbox", { name: "Search files" });
const item = (name: string) => screen.getByRole("treeitem", { name });
const shown = () => screen.queryAllByRole("treeitem").map((row) => row.getAttribute("aria-label") ?? row.textContent);

function type(value: string) {
  fireEvent.change(search(), { target: { value } });
}

function settle() {
  act(() => {
    vi.advanceTimersByTime(200);
  });
}

describe("FileTree filter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ranks the whole index as Go to file does and opens every folder above a hit", () => {
    render(<FileTree rootDir={rootDir} entries={shallow} searchFiles={index} activeFilePath={null} onOpenFile={vi.fn()} />);

    type("fltr");
    settle();

    expect(item("FileTree.tsx")).toBeInTheDocument();
    expect(item("src")).toHaveAttribute("aria-expanded", "true");
    expect(item("components")).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("treeitem", { name: "docs" })).toBeNull();
    expect(screen.queryByRole("treeitem", { name: "App.tsx" })).toBeNull();
  });

  it("searches the loaded entries while the index is still being read", () => {
    render(<FileTree rootDir={rootDir} entries={shallow} searchFiles={null} activeFilePath={null} onOpenFile={vi.fn()} />);
    type("rdm");
    settle();
    expect(item("README.md")).toBeInTheDocument();
  });

  it("waits for a pause before filtering again after the first letter", () => {
    render(<FileTree rootDir={rootDir} entries={shallow} searchFiles={index} activeFilePath={null} onOpenFile={vi.fn()} />);

    type("g");
    expect(item("guide.md")).toBeInTheDocument();

    type("gu");
    type("gui");
    type("guix");
    // Still the result for "g": the later letters have not settled.
    expect(item("guide.md")).toBeInTheDocument();

    settle();
    expect(screen.getByText("No matching files.")).toBeInTheDocument();
  });

  it("gives back the folders' open and closed state when the filter is cleared", () => {
    const tree = [
      ...shallow,
      { path: "/workspace/project/src/index.ts", kind: "file" as const },
      { path: "/workspace/project/docs/guide.md", kind: "file" as const },
    ];
    render(<FileTree rootDir={rootDir} entries={tree} searchFiles={index} activeFilePath={null} onOpenFile={vi.fn()} />);
    fireEvent.click(item("docs"));
    expect(shown()).toEqual(["docs", "guide.md", "src", "README.md"]);

    type("tsx");
    settle();
    // Closing a folder in the results does not reach the tree without a filter.
    fireEvent.click(item("src"));
    expect(item("src")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Clear file search" }));

    expect(shown()).toEqual(["docs", "guide.md", "src", "README.md"]);
    expect(item("src")).toHaveAttribute("aria-expanded", "false");
    expect(item("docs")).toHaveAttribute("aria-expanded", "true");
  });

  it("a new query opens the folders above its hits again", () => {
    render(<FileTree rootDir={rootDir} entries={shallow} searchFiles={index} activeFilePath={null} onOpenFile={vi.fn()} />);
    type("tsx");
    settle();
    fireEvent.click(item("src"));

    type("app");
    settle();

    expect(item("src")).toHaveAttribute("aria-expanded", "true");
    expect(item("App.tsx")).toBeInTheDocument();
  });
});
