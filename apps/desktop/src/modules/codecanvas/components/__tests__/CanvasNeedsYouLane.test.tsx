import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasNeedsYouLane } from "../CanvasNeedsYouLane";
import type { NeedsYouEntry } from "../../services/needs-you-queue";

const entry = (over: Partial<NeedsYouEntry> = {}): NeedsYouEntry => ({
  id: "n1",
  paneId: "canvas:cp_1:n1",
  name: "Atlas",
  waitingMs: 8_000,
  ...over,
});

describe("CanvasNeedsYouLane", () => {
  it("names every agent that is waiting, in the order it was given", () => {
    render(
      <CanvasNeedsYouLane
        entries={[entry(), entry({ id: "n2", name: "Mira", waitingMs: 200 })]}
        onFocusNode={() => {}}
      />,
    );

    const names = screen.getAllByTestId("needs-you-name").map((n) => n.textContent);
    expect(names).toEqual(["Atlas", "Mira"]);
  });

  it("shows how long each ask has waited", () => {
    render(<CanvasNeedsYouLane entries={[entry({ waitingMs: 125_000 })]} onFocusNode={() => {}} />);

    expect(screen.getByText("2m")).toBeTruthy();
  });

  it("counts the queue in the header", () => {
    render(
      <CanvasNeedsYouLane
        entries={[entry(), entry({ id: "n2", name: "Mira" })]}
        onFocusNode={() => {}}
      />,
    );

    expect(screen.getByTestId("needs-you-count").textContent).toBe("2");
  });

  it("focuses the node when a row is clicked", () => {
    const onFocusNode = vi.fn();
    render(<CanvasNeedsYouLane entries={[entry()]} onFocusNode={onFocusNode} />);

    screen.getByRole("button", { name: /Atlas/ }).click();

    expect(onFocusNode).toHaveBeenCalledWith("n1");
  });

  it("advertises the jump shortcut while there is something to jump to", () => {
    render(<CanvasNeedsYouLane entries={[entry()]} onFocusNode={() => {}} jumpHint="⌘J" />);

    expect(screen.getByTestId("needs-you-jump-hint").textContent).toBe("⌘J");
  });

  describe("when nothing needs a human", () => {
    it("stays present as a collapsed header, so the row below never shifts", () => {
      // The deciding argument for keeping it mounted: a lane that appears from nowhere moves every
      // row beneath it at the exact moment the operator is reaching for one.
      render(<CanvasNeedsYouLane entries={[]} onFocusNode={() => {}} />);

      expect(screen.getByTestId("needs-you-lane")).toBeTruthy();
      expect(screen.getByTestId("needs-you-count").textContent).toBe("0");
    });

    it("lists no rows", () => {
      render(<CanvasNeedsYouLane entries={[]} onFocusNode={() => {}} />);

      expect(screen.queryAllByTestId("needs-you-name")).toHaveLength(0);
    });

    it("drops the jump hint, because there is nothing to jump to", () => {
      render(<CanvasNeedsYouLane entries={[]} onFocusNode={() => {}} jumpHint="⌘J" />);

      expect(screen.queryByTestId("needs-you-jump-hint")).toBeNull();
    });

    it("marks itself empty so the styling can recede without a second source of truth", () => {
      render(<CanvasNeedsYouLane entries={[]} onFocusNode={() => {}} />);

      expect(screen.getByTestId("needs-you-lane").getAttribute("data-empty")).toBe("true");
    });
  });

  it("tells a screen reader how many agents are waiting", () => {
    // The lane is the one thing on this panel a blind operator must not have to hunt for.
    render(<CanvasNeedsYouLane entries={[entry()]} onFocusNode={() => {}} />);

    expect(screen.getByRole("region", { name: /1 agent waiting/i })).toBeTruthy();
  });

  it("says nothing about a wait it does not know", () => {
    render(<CanvasNeedsYouLane entries={[entry({ waitingMs: undefined })]} onFocusNode={() => {}} />);

    expect(screen.queryByTestId("needs-you-age")).toBeNull();
  });

  describe("the headline on a waiting row", () => {
    it("says what the agent was doing when it stopped to ask", () => {
      // "Atlas needs you" alone still sends the operator to the terminal to find out what for —
      // the same argument that put the tool detail in the honest-status lane mockup.
      render(
        <CanvasNeedsYouLane
          entries={[entry({ headline: "writing · tmp" })]}
          onFocusNode={() => {}}
        />,
      );

      expect(screen.getByTestId("needs-you-headline").textContent).toBe("writing · tmp");
    });

    it("renders the row without one rather than reserving empty space", () => {
      // The composer returns null for an agent that has run no tools. A blank line would make the
      // lane's rows two different heights for no reason.
      render(<CanvasNeedsYouLane entries={[entry()]} onFocusNode={() => {}} />);

      expect(screen.queryByTestId("needs-you-headline")).toBeNull();
    });

    it("keeps the headline out of the focus label, which already names the wait", () => {
      // The accessible name is "Focus Atlas, waiting 8s". Appending the headline would make the
      // label read as a sentence and bury the action.
      render(
        <CanvasNeedsYouLane
          entries={[entry({ headline: "writing · tmp" })]}
          onFocusNode={() => {}}
        />,
      );

      expect(screen.getByRole("button", { name: /^Focus Atlas, waiting 8s$/ })).toBeTruthy();
    });
  });
});
