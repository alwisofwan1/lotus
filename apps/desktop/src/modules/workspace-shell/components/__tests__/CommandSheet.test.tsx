import React from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnifiedComposer } from "../UnifiedComposer";
import { useCommandSheet } from "@/modules/workspace-shell/hooks/useCommandSheet";
import type { CommandItem } from "@/modules/workspace-shell/services/command-items";

const run = vi.fn();

const ITEMS: CommandItem[] = [
  { id: "launch-claude", title: "Claude Code", detail: "claude --dangerously-skip-permissions", keywords: "agent cli", group: "launch", tag: "AGENT", kind: "terminal", run },
  { id: "launch-grok", title: "grok", detail: "grok · not found on this machine", keywords: "agent cli", group: "launch", tag: "AGENT", kind: "terminal", disabled: true, run },
  { id: "create-thread", title: "Thread", detail: "agent yang dibaca", keywords: "pane baru", group: "create", tag: "PANE", kind: "thread", run },
];

/** ⌘K is wired in `CodeMode`; here the shortcut's one effect — `openBrowse` — is a button. */
function Harness({ items = ITEMS, onSubmit = vi.fn() }: { items?: CommandItem[]; onSubmit?: () => void }) {
  const sheet = useCommandSheet(items);
  return (
    <>
      <button type="button" onClick={sheet.openBrowse}>cmd-k</button>
      <UnifiedComposer target={null} placeholder="Type" onSubmit={onSubmit} sheet={sheet} />
    </>
  );
}

const field = () => screen.getByLabelText("Write a message") as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const commandK = () => fireEvent.click(screen.getByRole("button", { name: "cmd-k" }));

describe("the command sheet in the composer", () => {
  it("opens on ⌘K and on nothing else", () => {
    render(<Harness />);
    expect(document.querySelector(".ws-sheet")).toBeNull();
    // A slash is an ordinary character now, and must stay one: it is wanted for other things.
    type("/");
    type("/claude");
    expect(document.querySelector(".ws-sheet")).toBeNull();

    commandK();
    expect(document.querySelector(".ws-sheet")).not.toBeNull();
    expect(screen.getByText("Claude Code")).toBeTruthy();
  });

  it("stashes a half-written message and gives it back on Escape", () => {
    render(<Harness />);
    type("a half-written message");
    commandK();
    expect(field().value).toBe("");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().value).toBe("a half-written message");
  });

  it("says which mode the field is in, since the text no longer shows it", () => {
    render(<Harness />);
    commandK();
    expect(screen.getByText("Command")).toBeTruthy();
    expect(field().getAttribute("placeholder")).toMatch(/Search agents/);
  });

  it("is a combobox, not a dialog — focus stays in the field", () => {
    render(<Harness />);
    commandK();
    expect(field().getAttribute("role")).toBe("combobox");
    expect(field().getAttribute("aria-expanded")).toBe("true");
    expect(field().getAttribute("aria-activedescendant")).toBe("ws-command-row-launch-claude");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows the sections while browsing and drops them once ranked", () => {
    render(<Harness />);
    commandK();
    expect(screen.getByText("Launch agent")).toBeTruthy();
    type("thread");
    expect(screen.queryByText("Launch agent")).toBeNull();
    expect(screen.getByText("Thread")).toBeTruthy();
  });

  it("runs the active row on Enter instead of sending it as a message", () => {
    run.mockClear();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    commandK();
    type("claude");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field().value).toBe("");
  });

  it("moves with the arrows and wraps", () => {
    render(<Harness />);
    commandK();
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(field().getAttribute("aria-activedescendant")).toBe("ws-command-row-launch-grok");
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(field().getAttribute("aria-activedescendant")).toBe("ws-command-row-launch-claude");
  });

  it("closes on Escape and gives the field back", () => {
    render(<Harness />);
    commandK();
    type("claude");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(document.querySelector(".ws-sheet")).toBeNull();
    expect(field().value).toBe("");
  });

  it("slides one cursor to the active row and counts each section", () => {
    render(<Harness />);
    commandK();
    expect(document.querySelectorAll(".ws-sheet-cursor")).toHaveLength(1);
    expect(document.querySelector(".ws-sheet-section-count")?.textContent).toBe("2");
    expect(document.querySelector('[data-active="true"] .ws-sheet-enter')?.getAttribute("title")).toBe("AGENT");
  });

  it("says so when nothing matches, rather than showing an empty box", () => {
    render(<Harness />);
    commandK();
    type("zzzz");
    expect(screen.getByText(/No commands match/)).toBeTruthy();
  });
});

describe("useCommandSheet", () => {
  it("will not run a CLI this machine does not have", () => {
    run.mockClear();
    const { result } = renderHook(() => useCommandSheet(ITEMS));
    act(() => { result.current.openBrowse(); });
    act(() => { result.current.onInput("grok"); });
    let handled = true;
    act(() => { handled = result.current.runActive(); });
    expect(handled).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("asks the field for focus when ⌘K opens it", () => {
    const { result } = renderHook(() => useCommandSheet(ITEMS));
    const before = result.current.focusSignal;
    act(() => { result.current.openBrowse(); });
    expect(result.current.open).toBe(true);
    expect(result.current.focusSignal).toBe(before + 1);
  });

  it("ignores typing while it is closed, so a message can never drift into command mode", () => {
    const { result } = renderHook(() => useCommandSheet(ITEMS));
    act(() => { result.current.onInput("claude"); });
    expect(result.current.open).toBe(false);
    expect(result.current.query).toBe("");
  });

  it("never points past the end when the list shrinks under it", () => {
    const { result } = renderHook(() => useCommandSheet(ITEMS));
    act(() => { result.current.openBrowse(); });
    act(() => { result.current.onMove(2); });
    expect(result.current.activeIndex).toBe(2);
    act(() => { result.current.onInput("claude"); });
    expect(result.current.activeIndex).toBe(0);
  });
});
