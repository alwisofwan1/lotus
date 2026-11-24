import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { CanvasFleetPanel } from "../CanvasFleetPanel";
import { createAgentStatusRegistry } from "../../services/agent-status-registry";
import { createAgentHeadlineStore } from "../../services/agent-headline-store";

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as unknown as Node;

const agent = (id: string, name: string) => node(id, "agent", { name, model: "claude-sonnet" });

function panel(nodes: Node[], over: Partial<Parameters<typeof CanvasFleetPanel>[0]> = {}) {
  const registry = createAgentStatusRegistry();
  const headlines = createAgentHeadlineStore();
  const props = {
    nodes,
    onFocusNode: vi.fn(),
    onCloseNode: vi.fn(),
    registry,
    headlines,
    ...over,
  };
  return { ...render(<CanvasFleetPanel {...props} />), props, registry, headlines };
}

describe("CanvasFleetPanel", () => {
  it("restores and reports the project's Fleet scroll position", () => {
    const onRailScrollTopChange = vi.fn();
    const { container } = panel(
      Array.from({ length: 8 }, (_, index) => agent(`a${index}`, `Agent ${index}`)),
      { railScrollTop: 128, onRailScrollTopChange },
    );
    const scroll = container.querySelector(".canvas-fleet-scroll") as HTMLDivElement;

    expect(scroll.scrollTop).toBe(128);
    scroll.scrollTop = 216;
    fireEvent.scroll(scroll);

    expect(onRailScrollTopChange).toHaveBeenCalledWith(216);
  });

  it("names itself and counts the board", () => {
    panel([agent("a1", "Atlas"), node("t1", "terminal", { cwd: "/repo" })]);

    expect(screen.getByText("Fleet")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-count")).toHaveTextContent("2");
  });

  it("counts cells, not sections", () => {
    // The count answers "how much is on this board", so it includes the blocked agents pinned in the
    // needs-you lane above — which the section list deliberately leaves out.
    const { registry } = panel([agent("a1", "Atlas"), agent("a2", "Bima")]);
    act(() => registry.publish({ id: "a1", name: "Atlas", status: "needs-you" }));

    expect(screen.getByTestId("fleet-count")).toHaveTextContent("2");
  });

  it("shows a row's name and what it is doing", () => {
    const headlines = createAgentHeadlineStore();
    headlines.record("a1", { text: "perbaiki judul agent", key: "prompt|perbaiki judul agent" });
    panel([agent("a1", "Atlas")], { headlines });

    expect(screen.getByText("Atlas")).toBeInTheDocument();
    expect(screen.getByText("perbaiki judul agent")).toBeInTheDocument();
  });

  it("leaves the headline in its own case", () => {
    // The reference design uppercases both lines, and gets away with it because its headlines are
    // short model-written imperatives. Ours is the operator's raw prompt — often a whole sentence,
    // and materially harder to read shouted. The NAME is short and takes uppercase well; the CSS
    // does that, so the DOM keeps the true text either way.
    const headlines = createAgentHeadlineStore();
    headlines.record("a1", { text: "perbaiki judul agent", key: "k" });
    panel([agent("a1", "Atlas")], { headlines });

    expect(screen.getByTestId("fleet-detail-a1").textContent).toBe("perbaiki judul agent");
  });

  it("groups under section headings", () => {
    panel([agent("a1", "Atlas"), node("t1", "terminal", { cwd: "/repo" }), node("n1", "note")]);

    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Windows")).toBeInTheDocument();
    expect(screen.getByText("Cards")).toBeInTheDocument();
  });

  it("focuses the node when a row is clicked", async () => {
    const { props } = panel([agent("a1", "Atlas")]);

    await userEvent.click(screen.getByRole("button", { name: /Focus Atlas/i }));

    // The clicked button travels with the id so the caller can blur it if the node cannot take focus.
    expect(props.onFocusNode).toHaveBeenCalledWith("a1", expect.any(HTMLButtonElement));
  });

  it("keeps a way to close a cell", async () => {
    // The reference has no close button. Dropping one to match a screenshot removes a capability the
    // operator has today, which is the worse trade.
    const { props } = panel([agent("a1", "Atlas")]);

    await userEvent.click(screen.getByRole("button", { name: /Close Atlas/i }));

    expect(props.onCloseNode).toHaveBeenCalledWith("a1");
  });

  it("renames a terminal inline without focusing the row", async () => {
    const onRenameNode = vi.fn();
    const { props } = panel(
      [node("t1", "terminal", { cwd: "/repo/Lotus", terminalNumber: 2 })],
      { onRenameNode },
    );

    await userEvent.click(screen.getByRole("button", { name: "Rename Terminal 2" }));
    const input = screen.getByRole("textbox", { name: "Terminal name" });
    await userEvent.clear(input);
    await userEvent.type(input, "API server{Enter}");

    expect(onRenameNode).toHaveBeenCalledWith("t1", "API server");
    expect(props.onFocusNode).not.toHaveBeenCalled();
  });

  it("repaints when an agent's status changes", () => {
    const { registry } = panel([agent("a1", "Atlas")]);

    act(() => registry.publish({ id: "a1", name: "Atlas", status: "running" }));

    expect(screen.getByTestId("fleet-dot-a1")).toHaveClass("cth-dot--running");
  });

  it("repaints when a headline arrives", () => {
    const { headlines } = panel([agent("a1", "Atlas")]);

    act(() => headlines.record("a1", { text: "jalankan test", key: "prompt|jalankan test" }));

    expect(screen.getByText("jalankan test")).toBeInTheDocument();
  });

  it("says the board is empty rather than showing a bare header", () => {
    panel([]);

    expect(screen.getByTestId("fleet-empty")).toBeInTheDocument();
  });

  it("offers one action on an empty board: a new terminal", () => {
    const onAddTerminal = vi.fn();
    panel([], { onAddTerminal });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(onAddTerminal).toHaveBeenCalledTimes(1);
  });

  it("offers nothing it cannot do when the host gives no add action", () => {
    panel([]);
    expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
  });

  it("says what an agent is doing on its own line, asked or not", () => {
    // What the operator actually sees on a freshly spawned board. The rows shipped blank here: the
    // descriptor's fallback is the model, and a bare launch has none.
    const { registry } = panel([agent("a1", "Atlas")]);
    act(() => registry.publish({ id: "a1", name: "Atlas", status: "running" }));

    expect(screen.getByTestId("fleet-state-a1")).toHaveTextContent("working");
  });

  it("keeps reporting the state after an instruction arrives", () => {
    // The regression this pins: the two used to share one slot and take turns, so the moment an
    // agent was given something to do it stopped saying whether it was doing it.
    const { registry, headlines } = panel([agent("a1", "Atlas")]);
    act(() => registry.publish({ id: "a1", name: "Atlas", status: "running" }));
    act(() => headlines.record("a1", { text: "jalankan test", key: "prompt|jalankan test" }));

    expect(screen.getByTestId("fleet-detail-a1")).toHaveTextContent("jalankan test");
    expect(screen.getByTestId("fleet-state-a1")).toHaveTextContent("working");
  });

  it("marks an instruction apart from an identity", () => {
    // Both land in the context slot. Rendered identically a cwd reads as something the operator
    // typed, so the kind travels with the text and the CSS treats them differently.
    const { headlines } = panel([node("t1", "terminal", { cwd: "/repo" }), agent("a2", "Bima")]);
    act(() => headlines.record("a2", { text: "jalankan test", key: "prompt|jalankan test" }));

    expect(screen.getByTestId("fleet-detail-t1")).toHaveAttribute("data-kind", "identity");
    expect(screen.getByTestId("fleet-detail-a2")).toHaveAttribute("data-kind", "ask");
  });

  it("prefers the instruction once there is one", () => {
    const { registry, headlines } = panel([agent("a1", "Atlas")]);
    act(() => registry.publish({ id: "a1", name: "Atlas", status: "running" }));

    act(() => headlines.record("a1", { text: "perbaiki judul", key: "prompt|perbaiki judul" }));

    expect(screen.getByTestId("fleet-detail-a1")).toHaveTextContent("perbaiki judul");
  });

  it("puts both lines in one hover title, since both ellipsize", () => {
    const headlines = createAgentHeadlineStore();
    headlines.record("a1", { text: "perbaiki judul agent yang beku", key: "k" });
    panel([agent("a1", "Atlas")], { headlines });

    expect(screen.getByRole("button", { name: /Focus Atlas/i })).toHaveAttribute(
      "title",
      "Atlas — perbaiki judul agent yang beku",
    );
  });

  it("renders no second line rather than an empty one", () => {
    // A note with nothing in it: `describeCanvasNode` returns the type word, which the label and the
    // icon already say. An empty element would still take its line box.
    panel([node("n1", "note")]);

    expect(screen.queryByTestId("fleet-detail-n1")).not.toBeInTheDocument();
  });

  it("marks the row you are already looking at", () => {
    // Carried on the row itself rather than by a word. An earlier version printed "FOCUS", which
    // restated what the row's own lift, brighter name and inset bar already say.
    const { container } = panel([agent("a1", "Atlas"), agent("a2", "Bima")], { heroId: "a1" });

    const rows = [...container.querySelectorAll(".canvas-fleet-row")];
    expect(rows.filter((r) => r.getAttribute("data-hero") === "true")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Focus Atlas/i }).closest(".canvas-fleet-row"))
      .toHaveAttribute("data-hero", "true");
  });

  it("keeps the status dot on the hero's row", () => {
    // The badge used to replace it, so the one agent under the operator's nose was the only one
    // whose state the list did not show. Marking presence must not cost information.
    const { registry } = panel([agent("a1", "Atlas")], { heroId: "a1" });
    act(() => registry.publish({ id: "a1", name: "Atlas", status: "running" }));

    expect(screen.getByTestId("fleet-dot-a1")).toHaveClass("cth-dot--running");
  });

  it("says how long a resting agent has been resting", () => {
    const NOW = 1_700_000_000_000;
    const registry = createAgentStatusRegistry(() => NOW - 42 * 60_000);
    registry.publish({ id: "a1", name: "Atlas", status: "stalled" });

    panel([agent("a1", "Atlas")], { registry, now: () => NOW });

    expect(screen.getByTestId("fleet-state-a1")).toHaveTextContent("quiet · 42m");
  });
});

/**
 * Layout revamp (`plans/canvas-fleet-panel/` — rail layout + material).
 *
 * The rail moved out of the sidebar but kept the sidebar's measurements: a 26px row, a name in
 * capitals at 10.5px, and status marked by a 5px dot at the edge furthest from the name it
 * describes. These two are the parts that live in the DOM rather than in CSS.
 */
describe("CanvasFleetPanel — rail layout", () => {
  it("carries each row's status, for the stripe on its leading edge", () => {
    const { registry } = panel([agent("a1", "Atlas")]);
    act(() => registry.publish({ id: "a1", name: "Atlas", status: "running" }));

    expect(screen.getByRole("button", { name: /Focus Atlas/ }).closest(".canvas-fleet-row"))
      .toHaveAttribute("data-status", "running");
  });

  // The heading earns its line only when there is another band to tell it apart from.
  it("drops the section heading when there is only one band", () => {
    panel([agent("a1", "Atlas"), agent("a2", "Bayu")]);

    expect(screen.queryByText("Agents")).not.toBeInTheDocument();
    expect(screen.getByText("Atlas")).toBeInTheDocument();
  });

  it("keeps the headings as soon as a second band exists", () => {
    panel([agent("a1", "Atlas"), node("t1", "terminal", { cwd: "/repo" })]);

    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Windows")).toBeInTheDocument();
  });

  /**
   * The beat.
   *
   * The travelling segment on a row's status edge runs once per `data-beat` instead of looping, and
   * the whole value of that choice is what it makes VISIBLE: a row that has stopped producing is
   * motionless while its status still reads `running`. A loop would have shown a hung agent
   * sweeping exactly as cheerfully as a working one.
   */
  describe("beat", () => {
    const row = (name: string) =>
      screen.getByRole("button", { name: new RegExp(`Focus ${name}`) }).closest(".canvas-fleet-row");

    it("does not beat on the first line it ever sees", () => {
      // Otherwise every row pulses the moment the panel opens, which reads as the whole fleet
      // starting work at once.
      const headlines = createAgentHeadlineStore();
      headlines.record("a1", { text: "jalankan test", key: "k1" });
      panel([agent("a1", "Atlas")], { headlines });

      expect(row("Atlas")).not.toHaveAttribute("data-beat");
    });

    it("beats when the displayed line changes, and stops on its own", () => {
      vi.useFakeTimers();
      try {
        const { headlines } = panel([agent("a1", "Atlas")]);
        act(() => headlines.record("a1", { text: "jalankan test", key: "k1" }));
        expect(row("Atlas")).not.toHaveAttribute("data-beat");

        act(() => headlines.record("a1", { text: "perbaiki judul", key: "k2" }));
        expect(row("Atlas")).toHaveAttribute("data-beat", "true");

        // Released after one animation length. Held longer, a fast agent's next beat would find the
        // attribute already set and the animation would not restart.
        act(() => vi.advanceTimersByTime(1_000));
        expect(row("Atlas")).not.toHaveAttribute("data-beat");
      } finally {
        vi.useRealTimers();
      }
    });

    it("beats only the row that spoke", () => {
      const { headlines } = panel([agent("a1", "Atlas"), agent("a2", "Bayu")]);
      act(() => headlines.record("a1", { text: "satu", key: "k1" }));
      act(() => headlines.record("a2", { text: "satu", key: "k1" }));

      act(() => headlines.record("a1", { text: "dua", key: "k2" }));

      expect(row("Atlas")).toHaveAttribute("data-beat", "true");
      expect(row("Bayu")).not.toHaveAttribute("data-beat");
    });

    it("does not beat when the store holds a line that has not visibly changed", () => {
      // The store suppresses same-key offers itself — mid-turn tool flips carry no new information.
      // Pinned here because the beat's honesty depends entirely on that suppression: if the panel
      // ever pulsed per event rather than per visible change, it would be a loop with extra steps.
      const { headlines } = panel([agent("a1", "Atlas")]);
      act(() => headlines.record("a1", { text: "satu", key: "k1" }));
      act(() => headlines.record("a1", { text: "dua", key: "k1" }));

      expect(row("Atlas")).not.toHaveAttribute("data-beat");
    });
  });
});
