import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChatTimeline } from "../ChatTimeline";
import { TimelineRowView } from "../TimelineRowView";

describe("ChatTimeline", () => {
  it("shows the history rail from three prompts, one labelled mark each", () => {
    const user = (id: string) => ({ kind: "user" as const, id, turnId: id, text: `ask ${id}`, clientRequestId: id, attachments: [] });
    const { rerender } = render(<ChatTimeline rows={[user("a"), user("b")]} working={null} />);
    expect(screen.queryByRole("navigation", { name: "Prompts in this chat" })).toBeNull();
    rerender(<ChatTimeline rows={[user("a"), user("b"), user("c")]} working={null} />);
    const rail = screen.getByRole("navigation", { name: "Prompts in this chat" });
    expect([...rail.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Prompt 1: ask a", "Prompt 2: ask b", "Prompt 3: ask c"]);
  });

  it("is one Tab stop; focus opens the list, arrows and Home/End move, Escape closes", () => {
    const user = (id: string) => ({ kind: "user" as const, id, turnId: id, text: id, clientRequestId: id, attachments: [] });
    render(<ChatTimeline rows={[user("a"), user("b"), user("c")]} working={null} />);
    const rail = screen.getByRole("navigation", { name: "Prompts in this chat" });
    const marks = [...rail.querySelectorAll("button")];
    expect(marks.map((m) => m.tabIndex)).toEqual([0, -1, -1]);
    act(() => marks[0].focus());
    expect(rail.hasAttribute("data-open")).toBe(true);
    fireEvent.keyDown(marks[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(marks[1]);
    fireEvent.keyDown(marks[1], { key: "End" });
    expect(document.activeElement).toBe(marks[2]);
    fireEvent.keyDown(marks[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(marks[2]);
    fireEvent.keyDown(marks[2], { key: "Home" });
    expect(document.activeElement).toBe(marks[0]);
    fireEvent.keyDown(marks[0], { key: "Escape" });
    expect(rail.hasAttribute("data-open")).toBe(false);
  });

  it("shows what the running turn is doing under the last row", () => {
    const { rerender } = render(<ChatTimeline rows={[]} working="Thinking" />);
    expect(screen.getByRole("status").textContent).toBe("Thinking");
    rerender(<ChatTimeline rows={[]} working={null} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows no working row under a finished reply while the turn runs: the reply's caret says it", () => {
    const reply = { kind: "assistant" as const, id: "a", turnId: "u1", text: "Done.", streaming: false };
    render(<ChatTimeline rows={[reply]} working="Finishing" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  describe("following the end", () => {
    const reply = (id: string) => ({ kind: "assistant" as const, id, turnId: "u1", text: "x", streaming: false });
    // JSDOM has no layout: give the timeline a size and a scroll position it keeps.
    const sized = (el: HTMLElement) => {
      const box = { height: 1000, top: 0 };
      Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.height });
      Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 400 });
      Object.defineProperty(el, "scrollTop", { configurable: true, get: () => box.top, set: (v: number) => (box.top = v) });
      return box;
    };

    it("keeps following when a scroll event was not the user's (a pin, rows measured since)", () => {
      const { container, rerender } = render(<ChatTimeline rows={[reply("a")]} working={null} />);
      const el = container.querySelector<HTMLElement>(".chat-timeline")!;
      const box = sized(el);
      box.top = 200; // the end is now 400px away, past the slack
      fireEvent.scroll(el);
      box.height = 1400;
      rerender(<ChatTimeline rows={[reply("a"), reply("b")]} working={null} />);
      expect(box.top).toBe(1400);
    });

    it("puts the end back at once when something other than the user scrolls it, nothing resized", () => {
      const { container } = render(<ChatTimeline rows={[reply("a")]} working={null} />);
      const el = container.querySelector<HTMLElement>(".chat-timeline")!;
      const box = sized(el);
      box.top = 578; // 22px off the end, as measured live while typing in the composer
      fireEvent.scroll(el);
      expect(box.top).toBe(1000);
      expect(el.hasAttribute("data-fade-bottom")).toBe(false);
    });

    it("stops following once the user scrolls up", () => {
      const { container, rerender } = render(<ChatTimeline rows={[reply("a")]} working={null} />);
      const el = container.querySelector<HTMLElement>(".chat-timeline")!;
      const box = sized(el);
      fireEvent.wheel(el);
      box.top = 200;
      fireEvent.scroll(el);
      box.height = 1400;
      rerender(<ChatTimeline rows={[reply("a"), reply("b")]} working={null} />);
      expect(box.top).toBe(200);
    });

    it("offers a way back once the user is more than a screen above the end, and takes them there", () => {
      const { container, rerender } = render(<ChatTimeline rows={[reply("a")]} working={null} />);
      const el = container.querySelector<HTMLElement>(".chat-timeline")!;
      const box = sized(el);
      fireEvent.wheel(el);
      box.top = 500; // 100px above the end: still reading nearby
      fireEvent.scroll(el);
      expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
      fireEvent.wheel(el);
      box.top = 100; // 500px above the end, more than the 400px screen
      fireEvent.scroll(el);
      rerender(<ChatTimeline rows={[reply("a")]} working="Thinking" />);
      const jump = screen.getByRole("button", { name: "Jump to latest" });
      expect(jump.textContent).toContain("Thinking");
      fireEvent.click(jump);
      expect(box.top).toBe(1000);
      expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
      // Following again: new text keeps the end in view.
      box.height = 1400;
      rerender(<ChatTimeline rows={[reply("a"), reply("b")]} working="Thinking" />);
      expect(box.top).toBe(1400);
    });

    it("goes back to the end when the user sends, wherever they were reading", () => {
      const user = { kind: "user" as const, id: "u2", turnId: "t2", text: "next", clientRequestId: "r", attachments: [] };
      const { container, rerender } = render(<ChatTimeline rows={[reply("a")]} working={null} />);
      const el = container.querySelector<HTMLElement>(".chat-timeline")!;
      const box = sized(el);
      fireEvent.wheel(el);
      box.top = 100;
      fireEvent.scroll(el);
      box.height = 1200;
      rerender(<ChatTimeline rows={[reply("a"), user]} working={null} />);
      expect(box.top).toBe(1200);
    });
  });

  it("folds the context a continued chat was handed into a card above the user's words", () => {
    const text = '<lotus-handoff chat="c1" from="claude">\nThis continues the chat "Fix login".\n</lotus-handoff>\n\nship it';
    const user = { kind: "user" as const, id: "u", turnId: "t1", text, clientRequestId: "r", attachments: [] };
    render(<TimelineRowView row={user} expanded={false} onToggle={() => {}} />);
    expect(screen.getByText("Continued from a Claude chat")).toBeTruthy();
    expect(screen.getByText("ship it").className).toBe("chat-bubble");
    expect(screen.queryByText(/lotus-handoff/)).toBeNull();
  });
});
