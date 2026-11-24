import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorSearchQuery, EditorSearchResult } from "@/lib/tauri/codespace";
import { SearchPanel } from "@/modules/codespace/components/workbench/SearchPanel";

const io = vi.hoisted(() => ({
  editorSearchFor: vi.fn(),
  editorSearchCancel: vi.fn(async () => {}),
}));

vi.mock("@/lib/tauri/codespace", () => io);

const RESULT: EditorSearchResult = {
  files: [
    {
      path: "/repo/src/a.ts",
      matches: [
        { line: 3, column: 7, length: 6, preview: "const needle = 1;", previewStart: 6 },
        { line: 9, column: 1, length: 6, preview: "needle()", previewStart: 0 },
      ],
    },
    { path: "/repo/b.md", matches: [{ line: 1, column: 4, length: 6, preview: "# a needle", previewStart: 4 }] },
  ],
  matchCount: 3,
  truncated: false,
  cancelled: false,
};

function renderPanel(onOpenMatch = vi.fn()) {
  const user = userEvent.setup();
  const view = render(<SearchPanel searchId="pane-1" rootDir="/repo" onOpenMatch={onOpenMatch} />);
  return { user, onOpenMatch, ...view };
}

const lastQuery = () => io.editorSearchFor.mock.calls.at(-1)?.[2] as EditorSearchQuery;

describe("SearchPanel", () => {
  beforeEach(() => {
    io.editorSearchFor.mockReset().mockResolvedValue(RESULT);
    io.editorSearchCancel.mockClear();
  });

  it("searches after typing pauses, and shows matches grouped by file", async () => {
    const { user } = renderPanel();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "needle");
    await waitFor(() => expect(io.editorSearchFor).toHaveBeenCalledTimes(1));
    expect(io.editorSearchFor).toHaveBeenCalledWith(null, "/repo", expect.objectContaining({ pattern: "needle" }), "pane-1");
    expect(await screen.findByText("3 results in 2 files")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
    const marks = document.querySelectorAll("mark");
    expect([...marks].map((mark) => mark.textContent)).toEqual(["needle", "needle", "needle"]);
  });

  it("one character waits for Enter", async () => {
    const { user } = renderPanel();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "n");
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(io.editorSearchFor).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(io.editorSearchFor).toHaveBeenCalledTimes(1);
  });

  it("sends the toggles and the include and exclude globs", async () => {
    const { user } = renderPanel();
    await user.click(screen.getByRole("button", { name: "Match case" }));
    await user.click(screen.getByRole("button", { name: "Match whole word" }));
    await user.click(screen.getByRole("button", { name: "Use regular expression" }));
    await user.click(screen.getByRole("button", { name: "Files to include or exclude" }));
    await user.type(screen.getByRole("textbox", { name: "Files to include" }), "src/**");
    await user.type(screen.getByRole("textbox", { name: "Files to exclude" }), "*.md");
    await user.type(screen.getByRole("textbox", { name: "Search" }), "ne+dle{Enter}");
    expect(lastQuery()).toEqual({
      pattern: "ne+dle",
      caseSensitive: true,
      wholeWord: true,
      isRegex: true,
      include: "src/**",
      exclude: "*.md",
    });
    expect(screen.getByRole("button", { name: "Match case" })).toHaveAttribute("aria-pressed", "true");
  });

  it("a click opens the file at the match", async () => {
    const { user, onOpenMatch } = renderPanel();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "needle{Enter}");
    await user.click(await screen.findByTitle("src/a.ts:9:1"));
    expect(onOpenMatch).toHaveBeenCalledWith("/repo/src/a.ts", RESULT.files[0].matches[1]);
  });

  it("a file folds away, and Collapse all folds every file", async () => {
    const { user } = renderPanel();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "needle{Enter}");
    await screen.findByText("3 results in 2 files");
    await user.click(screen.getByRole("button", { name: /a\.ts/ }));
    expect(screen.queryByTitle("src/a.ts:3:7")).not.toBeInTheDocument();
    expect(screen.getByTitle("b.md:1:4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByTitle("b.md:1:4")).not.toBeInTheDocument();
  });

  it("an older search that answers late is ignored", async () => {
    let answerFirst: (value: EditorSearchResult) => void = () => {};
    io.editorSearchFor
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
      .mockResolvedValueOnce({ files: [], matchCount: 0, truncated: false, cancelled: false });
    const { user } = renderPanel();
    const input = screen.getByRole("textbox", { name: "Search" });
    await user.type(input, "needle{Enter}");
    await user.type(input, "s{Enter}");
    expect(await screen.findByText("No results")).toBeInTheDocument();
    // Each new search stops the one before it.
    expect(io.editorSearchCancel).toHaveBeenCalledWith("pane-1");
    await act(async () => answerFirst(RESULT));
    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
  });

  it("says when results were cut short, and shows an error as text", async () => {
    io.editorSearchFor.mockResolvedValueOnce({ ...RESULT, truncated: true });
    const { user } = renderPanel();
    const input = screen.getByRole("textbox", { name: "Search" });
    await user.type(input, "needle{Enter}");
    expect(await screen.findByText(/Only the first 3 results are shown/)).toBeInTheDocument();

    io.editorSearchFor.mockRejectedValueOnce("regex parse error: unclosed group");
    await user.type(input, "({Enter}");
    expect(await screen.findByText(/unclosed group/)).toBeInTheDocument();
  });

  it("a focus request focuses the query box", async () => {
    const onOpenMatch = vi.fn();
    const { rerender } = render(<SearchPanel searchId="p" rootDir="/repo" onOpenMatch={onOpenMatch} />);
    rerender(<SearchPanel searchId="p" rootDir="/repo" onOpenMatch={onOpenMatch} focusRequest={{ nonce: 1 }} />);
    expect(screen.getByRole("textbox", { name: "Search" })).toHaveFocus();
  });
});
