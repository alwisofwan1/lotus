import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShellChrome } from "../ShellChrome";

describe("ShellChrome", () => {
  it("marks the current mode as the selected tab", () => {
    render(<ShellChrome mode="code" onModeChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("false");
  });

  it("offers Canvas from here even though Canvas keeps its own chrome", () => {
    const onModeChange = vi.fn();
    render(<ShellChrome mode="code" onModeChange={onModeChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    expect(onModeChange).toHaveBeenCalledWith("canvas");
  });

  it("only shows the rail toggle when something can act on it", () => {
    const { unmount } = render(<ShellChrome mode="chat" onModeChange={vi.fn()} />);
    expect(screen.queryByLabelText("Toggle rail")).toBeNull();
    unmount();

    const onToggleRail = vi.fn();
    render(<ShellChrome mode="chat" onModeChange={vi.fn()} onToggleRail={onToggleRail} />);
    fireEvent.click(screen.getByLabelText("Toggle rail"));
    expect(onToggleRail).toHaveBeenCalled();
  });

  it("says which way the rail toggle will go", () => {
    const { rerender } = render(<ShellChrome mode="code" onModeChange={vi.fn()} onToggleRail={vi.fn()} railVisible />);
    expect(screen.getByLabelText("Toggle rail").getAttribute("title")).toBe("Hide sidebar");
    rerender(<ShellChrome mode="code" onModeChange={vi.fn()} onToggleRail={vi.fn()} railVisible={false} />);
    expect(screen.getByLabelText("Toggle rail").getAttribute("title")).toBe("Show sidebar");
    // One glyph in one place: the state is in its side pane, not in a second icon.
    expect(screen.getByLabelText("Toggle rail").querySelectorAll("svg")).toHaveLength(1);
    expect(screen.getByLabelText("Toggle rail").querySelector("svg")?.getAttribute("data-open")).toBe("false");
  });
});

describe("ShellChrome Chat mark", () => {
  it("names ready chats on the Chat tab from another mode", () => {
    render(<ShellChrome mode="code" onModeChange={vi.fn()} chatMark={{ kind: "ready", count: 3 }} />);
    expect(screen.getByRole("tab", { name: "Chat, 3 ready" })).toHaveTextContent(/^Chat$/);
  });

  it("says when a chat is waiting for you", () => {
    render(<ShellChrome mode="code" onModeChange={vi.fn()} chatMark={{ kind: "waiting", count: 1 }} />);
    expect(screen.getByRole("tab", { name: "Chat, waiting for you" })).toBeTruthy();
  });

  it("draws nothing in Chat mode, where the rail says it", () => {
    render(<ShellChrome mode="chat" onModeChange={vi.fn()} chatMark={{ kind: "ready", count: 3 }} />);
    expect(screen.getByRole("tab", { name: "Chat" })).toBeTruthy();
  });
});
