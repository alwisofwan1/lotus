import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { AgentMarkdownBlock } from "../nodes/AgentMarkdownBlock";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentMarkdownBlock", () => {
  it("renders prose text as markdown", () => {
    render(<AgentMarkdownBlock text="Hello **world**" />);
    expect(screen.getByText("world")).toBeInTheDocument();
  });

  it("shows a copy button and language label for fenced code blocks", () => {
    render(<AgentMarkdownBlock text={"```typescript\nconst x = 1;\n```"} />);
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
    expect(screen.getByText("typescript")).toBeInTheDocument();
  });

  it("calls navigator.clipboard.writeText with the code text when copy is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<AgentMarkdownBlock text={"```\nconst x = 1;\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const x = 1;"));
  });

  it("falls back to execCommand('copy') when the clipboard API is absent", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      value: execCommand,
      configurable: true,
      writable: true,
    });

    render(<AgentMarkdownBlock text={"```\nhello\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
  });

  it("shows 'Copied' label after a successful copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<AgentMarkdownBlock text={"```\ncode\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
  });

  it("opens links in a new tab with safe rel attributes", () => {
    render(<AgentMarkdownBlock text="[Visit](https://example.com)" />);
    const link = screen.getByRole("link", { name: "Visit" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("wraps tables in a scrollable region", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const { container } = render(<AgentMarkdownBlock text={md} />);
    expect(container.querySelector(".agent-md-table-wrap")).toBeInTheDocument();
  });

  it("labels the table region for accessibility", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    render(<AgentMarkdownBlock text={md} />);
    expect(screen.getByRole("region", { name: /table/i })).toBeInTheDocument();
  });
});
