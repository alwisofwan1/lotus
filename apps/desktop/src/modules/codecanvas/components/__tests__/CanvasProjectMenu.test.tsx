import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CanvasProjectMenu } from "../CanvasProjectMenu";
import {
  __resetCanvasOcclusionForTests,
  getCanvasOcclusionBlockedSnapshot,
  getDockedOccluderRects,
} from "../../services/canvas-occlusion-store";

const baseProps = {
  projects: [],
  activeProjectId: null,
  fallbackName: "/repo/demo",
  onSelectProject: vi.fn(),
  onOpenCanvases: vi.fn(),
  onNewProject: vi.fn(),
  onCloseProject: vi.fn(),
};

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
  return screen.getByRole("menu", { name: "Projects" });
}

describe("CanvasProjectMenu placement", () => {
  it("opens downward by default", () => {
    render(<CanvasProjectMenu {...baseProps} />);
    const menu = openMenu();
    expect(menu.className).not.toContain("canvas-project-dropdown--up");
  });

  it("opens upward when placement is 'up' (docked in the bottom command bar)", () => {
    render(<CanvasProjectMenu {...baseProps} placement="up" />);
    const menu = openMenu();
    expect(menu.className).toContain("canvas-project-dropdown--up");
  });

  it("does not label boot restore as no project", () => {
    render(<CanvasProjectMenu {...baseProps} fallbackName="" restoring />);

    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Restoring…");
    expect(screen.queryByText("No project")).not.toBeInTheDocument();
  });
});

describe("CanvasProjectMenu hierarchy", () => {
  it("puts the chevron after the name in DOM order (name leads, chevron trails)", () => {
    render(<CanvasProjectMenu {...baseProps} />);
    const trigger = screen.getByRole("button", { name: "Switch project" });
    const children = Array.from(trigger.children);
    const nameIndex = children.findIndex((el) => el.classList.contains("canvas-project-trigger-name"));
    const chevIndex = children.findIndex((el) => el.classList.contains("canvas-project-trigger-chev"));
    expect(nameIndex).toBeGreaterThanOrEqual(0);
    expect(chevIndex).toBeGreaterThan(nameIndex);
  });

  it("head-trims a long project name for display but keeps the full name reachable via title", () => {
    render(<CanvasProjectMenu {...baseProps} fallbackName="/repo/orchids-claude-agent-teams" />);
    const trigger = screen.getByRole("button", { name: "Switch project" });

    // The display label drops the uninformative head, not the identifying tail.
    expect(trigger).toHaveTextContent("…claude-agent-teams");
    expect(trigger).not.toHaveTextContent("orchids-claude-agent-teams");
    // Hovering still reveals the full, untrimmed path.
    expect(trigger).toHaveAttribute("title", "/repo/orchids-claude-agent-teams");
  });
});

describe("CanvasProjectMenu occlusion", () => {
  beforeEach(() => __resetCanvasOcclusionForTests());

  it("registers as a docked occluder while open so the browser clips instead of parking (stays live)", () => {
    render(<CanvasProjectMenu {...baseProps} />);
    expect(getDockedOccluderRects()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));

    // A docked occluder (the browser clips its bounds around the menu) — NOT a
    // blocking lock, which would park the whole WebView and blank it to "Paused".
    const rects = getDockedOccluderRects();
    expect(rects).toHaveLength(1);
    // force: the clip must win even over a large browser (else the menu stays covered).
    expect(rects[0].force).toBe(true);
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(false);
  });

  it("unregisters the docked occluder when closed", () => {
    render(<CanvasProjectMenu {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    expect(getDockedOccluderRects()).toHaveLength(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(getDockedOccluderRects()).toHaveLength(0);
  });
});
