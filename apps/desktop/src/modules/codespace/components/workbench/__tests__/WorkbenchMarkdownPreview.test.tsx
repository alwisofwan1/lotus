import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchMarkdownPreview } from "../WorkbenchMarkdownPreview";

describe("WorkbenchMarkdownPreview", () => {
  it("does not render executable script tags from markdown content", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<WorkbenchMarkdownPreview content={'hello\n\n<script>alert("x")</script>'} />);

    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByText(/alert/)).toBeNull();
    expect(screen.getByText(/hello/)).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("script tag"));
    consoleError.mockRestore();
  });

  it("renders leading skill frontmatter as a metadata table", () => {
    render(
      <WorkbenchMarkdownPreview
        content={`---\nname: frontend-design\ndescription: Create distinctive interfaces\nlicense: Complete terms in LICENSE.txt\n---\n\n## Design Thinking`}
      />,
    );

    expect(screen.getByRole("region", { name: /document metadata/i })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "name" })).toBeInTheDocument();
    expect(screen.getByText("frontend-design")).toBeInTheDocument();
    expect(screen.queryByText("---")).not.toBeInTheDocument();
  });

  it("renders explicit metadata when backend already stripped frontmatter from content", () => {
    render(
      <WorkbenchMarkdownPreview
        content="## Design Thinking"
        metadata={[
          { key: "name", value: "frontend-design" },
          { key: "license", value: "Complete terms in LICENSE.txt" },
        ]}
      />,
    );

    expect(screen.getByRole("region", { name: /document metadata/i })).toBeInTheDocument();
    expect(screen.getByText("frontend-design")).toBeInTheDocument();
    expect(screen.getByText("Complete terms in LICENSE.txt")).toBeInTheDocument();
  });

  it("can preserve single-newline command lists for skill docs", () => {
    render(
      <WorkbenchMarkdownPreview
        preserveSoftBreaks
        content={"`agent-browser open <url>` # Navigate\n`agent-browser close` # Close browser"}
      />,
    );

    expect(document.querySelectorAll("br")).toHaveLength(1);
    expect(screen.getByText("agent-browser open <url>")).toBeInTheDocument();
    expect(screen.getByText("agent-browser close")).toBeInTheDocument();
  });

  it("does not hard-break normal wrapped prose when soft break preservation is enabled", () => {
    render(<WorkbenchMarkdownPreview preserveSoftBreaks content={"A normal sentence wraps\nonto another source line."} />);

    expect(document.querySelectorAll("br")).toHaveLength(0);
  });

  it("renders bullet, ordered, nested, and task lists as real list markup", () => {
    render(
      <WorkbenchMarkdownPreview
        content={"- Alpha\n  - Nested\n\n1. First\n2. Second\n\n- [x] Done"}
      />,
    );

    expect(screen.getByText("Alpha").closest("ul")).toBeInTheDocument();
    expect(screen.getByText("Nested").closest("ul")).toBeInTheDocument();
    expect(screen.getByText("First").closest("ol")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("renders fenced code blocks even when no language is provided", () => {
    render(<WorkbenchMarkdownPreview content={"```\nagent-browser open <url>\n```"} />);

    expect(document.querySelector(".wbmd-code-block")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
    expect(screen.getByText(/agent-browser open/)).toBeInTheDocument();
  });

  it("wraps GFM tables in an accessible scroll region", () => {
    render(<WorkbenchMarkdownPreview content={"| Command | Notes |\n| --- | --- |\n| open | Navigate |"} />);

    expect(screen.getByRole("region", { name: /markdown table/i })).toHaveClass("wbmd-table-wrap");
  });
});

describe("WorkbenchMarkdownPreview images and links on disk", () => {
  it("loads a relative image from the file's folder and opens a linked file in the editor", async () => {
    URL.createObjectURL = vi.fn(() => "blob:md-1");
    URL.revokeObjectURL = vi.fn();
    const loadFile = vi.fn(async () => new ArrayBuffer(4));
    const onOpenFile = vi.fn();
    render(
      <WorkbenchMarkdownPreview
        content={"![Logo](../assets/logo.png)\n\n[Guide](./guide.md) [Site](https://lotus.dev)\n\n![Gone](missing.txt)"}
        filePath="/repo/docs/README.md"
        rootDir="/repo"
        loadFile={loadFile}
        onOpenFile={onOpenFile}
      />,
    );
    expect(await screen.findByRole("img", { name: "Logo" })).toHaveAttribute("src", "blob:md-1");
    expect(loadFile).toHaveBeenCalledWith("/repo/assets/logo.png");
    // Not an image file: its alt text stands in, and it is not read.
    await waitFor(() => expect(screen.getByText("Gone")).toBeInTheDocument());
    expect(loadFile).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("link", { name: "Guide" }));
    expect(onOpenFile).toHaveBeenCalledWith("/repo/docs/guide.md");
    expect(screen.getByRole("link", { name: "Site" })).toHaveAttribute("target", "_blank");
  });

  it("keeps code blocks, links and images mounted across a re-render with new callbacks", () => {
    // An idle parent re-render must not remount them: an image would fall back to its loading box and the page jump.
    const content = "```js\nx\n```\n\n[Guide](guide.md)\n\n![Pic](pic.png)";
    const view = () => (
      <WorkbenchMarkdownPreview content={content} filePath="/repo/a.md" rootDir="/repo" loadFile={() => new Promise<ArrayBuffer>(() => {})} onOpenFile={() => {}} />
    );
    const { container, rerender } = render(view());
    const nodes = () => [".wbmd-code-block", "a", ".wbmd-image-loading"].map((s) => container.querySelector(s));
    const before = nodes();
    expect(before.every(Boolean)).toBe(true);
    rerender(view());
    expect(nodes()).toEqual(before);
    nodes().forEach((node, i) => expect(node).toBe(before[i]));
  });

  it("calls the latest onOpenFile after a re-render", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(<WorkbenchMarkdownPreview content="[Guide](guide.md)" filePath="/repo/a.md" rootDir="/repo" onOpenFile={first} />);
    rerender(<WorkbenchMarkdownPreview content="[Guide](guide.md)" filePath="/repo/a.md" rootDir="/repo" onOpenFile={latest} />);
    fireEvent.click(screen.getByRole("link", { name: "Guide" }));
    expect(latest).toHaveBeenCalledWith("/repo/guide.md");
    expect(first).not.toHaveBeenCalled();
  });
});
