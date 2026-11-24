import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerminalSearchBar } from "../TerminalSearchBar";

describe("TerminalSearchBar", () => {
  it("renders search input and navigation buttons", () => {
    render(
      <TerminalSearchBar
        onFind={vi.fn()}
        onFindPrev={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/next/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/prev/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/close/i)).toBeInTheDocument();
  });

  it("does not clear search decorations on initial empty mount", () => {
    const onClearSearch = vi.fn();
    render(
      <TerminalSearchBar
        onFind={vi.fn()}
        onFindPrev={vi.fn()}
        onClose={vi.fn()}
        onClearSearch={onClearSearch}
      />
    );

    expect(onClearSearch).not.toHaveBeenCalled();
  });

  it("runs live search as the query changes", async () => {
    const onFind = vi.fn();
    const onLiveFind = vi.fn();
    render(
      <TerminalSearchBar
        onFind={onFind}
        onFindPrev={vi.fn()}
        onClose={vi.fn()}
        onLiveFind={onLiveFind}
      />
    );

    const input = screen.getByPlaceholderText(/search/i);
    await userEvent.type(input, "hello");

    expect(onLiveFind).toHaveBeenLastCalledWith("hello");
    expect(onFind).not.toHaveBeenCalled();
  });

  it("calls onFind when pressing Enter", async () => {
    const onFind = vi.fn();
    render(
      <TerminalSearchBar
        onFind={onFind}
        onFindPrev={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/search/i);
    await userEvent.type(input, "hello{Enter}");

    expect(onFind).toHaveBeenCalledWith("hello");
  });

  it("calls onFindPrev when pressing Shift+Enter", async () => {
    const onFindPrev = vi.fn();
    render(
      <TerminalSearchBar
        onFind={vi.fn()}
        onFindPrev={onFindPrev}
        onClose={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/search/i);
    await userEvent.type(input, "hello");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(onFindPrev).toHaveBeenCalledWith("hello");
  });

  it("calls onClose when pressing Escape", async () => {
    const onClose = vi.fn();
    render(
      <TerminalSearchBar
        onFind={vi.fn()}
        onFindPrev={vi.fn()}
        onClose={onClose}
      />
    );

    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });
});
