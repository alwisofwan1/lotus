import { useContext } from "react";
import { createPortal } from "react-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaneCard, PaneHeaderSlot } from "@/modules/workspace-shell/components/PaneCard";

/**
 * The header is one strip, and what it must never do is drop information to get there.
 *
 * Every check below is about that trade: the handle leads, the generated title moves right instead
 * of being replaced, and nothing is printed twice.
 */
describe("PaneCard header", () => {
  it("drags from the header, never from a control inside it", () => {
    const onHeaderPointerDown = vi.fn();
    render(
      <PaneCard kind="terminal" title="Shell" meta="" onHeaderPointerDown={onHeaderPointerDown} onClose={() => {}}>
        <div />
      </PaneCard>,
    );
    const header = screen.getByText("Shell").closest("header")!;
    fireEvent.pointerDown(header.querySelector("button")!);
    expect(onHeaderPointerDown).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByText("Shell"));
    expect(onHeaderPointerDown).toHaveBeenCalledTimes(1);
  });

  it("opens the pane menu on a right-click anywhere on the header", () => {
    const onHeaderContextMenu = vi.fn();
    render(
      <PaneCard kind="terminal" title="Shell" meta="" onHeaderContextMenu={onHeaderContextMenu}>
        <div />
      </PaneCard>,
    );
    fireEvent.contextMenu(screen.getByText("Shell"));
    expect(onHeaderContextMenu).toHaveBeenCalledTimes(1);
  });

  it("leads with the agent's handle and keeps the title beside it", () => {
    render(
      <PaneCard
        kind="terminal"
        title="Check empty pages"
        meta="lotus · claude --dangerously-skip-permissions"
        persona="Nara"
        runner={{ provider: "claude", label: "Claude", mark: { kind: "logo", src: "/assets/ai-logo/Claude.svg" } }}
      >
        <div />
      </PaneCard>,
    );

    expect(screen.getByText("Nara")).toBeTruthy();
    expect(screen.getByText("Check empty pages")).toBeTruthy();
  });

  /**
   * The folder and the launch command are NOT drawn.
   *
   * They were the longest thing in the strip and the least read: the folder is what the rail groups
   * by, and the command is a flag list nobody scans a header for. What the header answers is who is
   * in this pane and what they are doing — a handle and a title. The rest moves to the hover text,
   * so it is a pointer away rather than gone.
   */
  it("keeps the folder and the launch command out of the strip, and in reach", () => {
    const { container } = render(
      <PaneCard
        kind="terminal"
        title="Task blocked with unclear goal"
        meta="interview-hss · claude --dangerously-skip-permissions"
        persona="Faye"
      >
        <div />
      </PaneCard>,
    );

    const header = container.querySelector(".ws-pane-header");
    expect(header?.textContent).not.toContain("interview-hss");
    expect(header?.textContent).not.toContain("--dangerously-skip-permissions");
    expect(container.querySelector(".ws-pane-meta")?.getAttribute("title"))
      .toContain("interview-hss · claude --dangerously-skip-permissions");
  });

  /**
   * A plain shell has no handle, so its folder takes the name slot and there is nothing left to put
   * beside it — the header is one word. That is the honest shape: the second slot exists to say what
   * an agent is DOING, and a shell is not doing anything it can name.
   */
  it("falls back to the title as the name when no agent has been named", () => {
    const { container } = render(
      <PaneCard kind="terminal" title="desktop" meta="zsh">
        <div />
      </PaneCard>,
    );

    expect(screen.getByText("desktop")).toBeTruthy();
    expect(container.querySelector(".ws-pane-meta")).toBeNull();
    // One word on screen, but the shell it is running is still a hover away — and this pane has no
    // second slot to hang that hover on, so it has to live on the name.
    expect(container.querySelector(".ws-pane-title")?.getAttribute("title")).toContain("zsh");
  });

  /** A handle that equals the title would otherwise read "Nara · Nara". */
  it("never prints the same fact twice", () => {
    render(
      <PaneCard kind="terminal" title="Nara" meta="Nara" persona="Nara">
        <div />
      </PaneCard>,
    );

    expect(screen.getAllByText("Nara")).toHaveLength(1);
  });

  it("draws the runner's own mark instead of the kind glyph when an agent is running", () => {
    const { container } = render(
      <PaneCard
        kind="terminal"
        title="t"
        meta=""
        runner={{ provider: "codex", label: "Codex", mark: { kind: "logo", src: "/assets/ai-logo/ChatGPT.svg" } }}
      >
        <div />
      </PaneCard>,
    );

    const mark = container.querySelector<HTMLElement>(".ws-pane-runner-mark");
    expect(mark?.dataset.runner).toBe("codex");
    expect(mark?.style.getPropertyValue("--ws-runner-logo")).toBe('url("/assets/ai-logo/ChatGPT.svg")');
  });

  it("draws no badge; the state rides on the pane for the underline, and in words for a screen reader (07e)", () => {
    const { container } = render(
      <PaneCard kind="terminal" title="t" meta="" activity="working">
        <div />
      </PaneCard>,
    );
    expect(container.querySelector(".ws-activity")).toBeNull();
    expect(container.querySelector(".ws-pane")?.getAttribute("data-activity")).toBe("working");
    expect(container.querySelector(".ws-pane-header .sr-only")?.textContent).toBeTruthy();
  });

  it("draws no state at all for a pane with nothing running behind it", () => {
    const { container } = render(
      <PaneCard kind="browser" title="example.com" meta="browser">
        <div />
      </PaneCard>,
    );
    expect(container.querySelector(".ws-activity")).toBeNull();
  });
});

/**
 * A finished turn nobody has looked at yet: the S11 contract. It is drawn on the pane, with words,
 * and it gives way to the two states that ask something of a human.
 */
describe("PaneCard unread result", () => {
  it("marks a pane whose finished turn has not been opened", () => {
    const { container } = render(
      <PaneCard kind="terminal" title="Claude Code" meta="" activity="idle" unread>
        <div />
      </PaneCard>,
    );

    expect(container.querySelector(".ws-pane")?.getAttribute("data-unread")).toBe("true");
    expect(screen.getByText("done · new")).toBeTruthy();
  });

  it("returns to the quiet dot once the result is read", () => {
    const { container } = render(
      <PaneCard kind="terminal" title="Claude Code" meta="" activity="idle">
        <div />
      </PaneCard>,
    );

    expect(container.querySelector(".ws-pane")?.hasAttribute("data-unread")).toBe(false);
    expect(screen.queryByText("done · new")).toBeNull();
  });

  it("lets an ask outrank an unread result — they are separate states", () => {
    const { container } = render(
      <PaneCard kind="terminal" title="Claude Code" meta="" activity="needs-you" unread>
        <div />
      </PaneCard>,
    );

    expect(container.querySelector(".ws-pane")?.hasAttribute("data-unread")).toBe(false);
    expect(screen.queryByText("done · new")).toBeNull();
  });
});

describe("PaneCard header slot", () => {
  function Done() {
    const slot = useContext(PaneHeaderSlot);
    return slot ? createPortal(<button type="button">Done</button>, slot) : null;
  }

  it("lets what the pane runs put a control in the header, before Maximize and Close", () => {
    const { container } = render(
      <PaneCard kind="thread" title="Fix the flaky test" meta="" onClose={() => {}}>
        <Done />
      </PaneCard>,
    );
    const header = container.querySelector(".ws-pane-header")!;
    const buttons = [...header.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(buttons).toEqual(["Done", "Maximize Fix the flaky test", "Close Fix the flaky test"]);
    expect(screen.getByRole("button", { name: "Done" }).closest(".ws-pane-body")).toBeNull();
  });
});
