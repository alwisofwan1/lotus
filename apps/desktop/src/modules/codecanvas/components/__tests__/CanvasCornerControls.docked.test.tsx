import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../CanvasZoomControl", async (orig) => ({
  ...(await orig<typeof import("../CanvasZoomControl")>()),
  useCanvasZoomActions: () => ({ zoom: 0.5, handleFitAll: vi.fn(), handleZoomIn: vi.fn(), handleZoomOut: vi.fn() }),
}));
vi.mock("../../hooks/useCodeCanvasProjectMemory", () => ({
  useCodeCanvasProjectMemory: () => ({ items: [{}, {}], refresh: vi.fn() }),
}));
vi.mock("../../hooks/useCanvasSessions", () => ({ useCanvasSessions: () => ({ sessions: [{}], refresh: vi.fn(async () => {}) }) }));
vi.mock("../memory/CanvasProjectMemoryPanel", () => ({ CanvasProjectMemoryPanel: () => <div>memory panel</div> }));
vi.mock("../sessions/CanvasSessionsPanel", () => ({
  CanvasSessionsPanel: (p: { confirm?: { text: string } | null; onClose: () => void }) => (
    <div>
      sessions panel
      {p.confirm ? <button onClick={p.onClose}>{p.confirm.text}</button> : null}
    </div>
  ),
}));

vi.mock("@xyflow/react", () => ({ Panel: ({ children }: { children: React.ReactNode }) => <div data-testid="corner">{children}</div> }));

import { CanvasCornerControls } from "../CanvasCornerControls";

const rows = () => Array.from(document.querySelectorAll('[role^="menuitem"]'), (i) => i.textContent);

type Confirm = React.ComponentProps<typeof CanvasCornerControls>["sessionConfirm"];

function Harness({ projectId = "p1", sessionConfirm }: { projectId?: string | null; sessionConfirm?: Confirm }) {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  return (
    <>
      <span data-testid="bar" ref={setBar} />
      <div role="menu" ref={setMenu} />
      <CanvasCornerControls bounds={{ minZoom: 0.04, maxZoom: 1.25 }} nodeCount={3} projectId={projectId} onDispatchSession={vi.fn()} sessionConfirm={sessionConfirm} docked={{ bar, menu }} />
    </>
  );
}

describe("CanvasCornerControls docked into the command bar", () => {
  it("keeps zoom in the corner and moves Memory/Sessions into the ⋯ menu, popovers above the bar", () => {
    render(<Harness />);
    const corner = screen.getByTestId("corner");
    expect(corner).toHaveTextContent("50%");
    expect(screen.getByRole("button", { name: /fit all canvas nodes/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /project memory/i })).toBeNull();
    expect(rows()).toEqual(["Memory2", "Sessions1"]);

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Memory/ }));
    expect(screen.getByTestId("bar")).toHaveTextContent("memory panel");
    expect(screen.getByRole("menuitemcheckbox", { name: /Memory/ })).toHaveAttribute("aria-checked", "true");
  });

  it("adds no menu rows without a project", () => {
    render(<Harness projectId={null} />);
    expect(rows()).toEqual([]);
  });

  // A switch held for an answer (from the list, ⌘K or a hotkey) opens the list to ask it there, and
  // closing the list answers Stay.
  it("opens Sessions to ask a held switch, and closing it answers Stay", () => {
    const settle = vi.fn();
    const session = { id: "s1", nodeId: "n1" } as NonNullable<Confirm>["session"];
    render(<Harness sessionConfirm={{ session, settle }} />);
    fireEvent.click(screen.getByRole("button", { name: /waiting for your answer/ }));
    expect(settle).toHaveBeenCalledWith(false);
  });
});
