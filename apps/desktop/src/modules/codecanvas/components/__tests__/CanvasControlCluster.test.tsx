import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasControlCluster } from "../CanvasControlCluster";
import { CanvasTopBar } from "../CanvasTopBar";

const chip = (n: number) => ({ frameId: `f${n}`, index: n, label: `0${n}`, name: `Frame ${n}`, status: "idle" as const, tone: "idle" as const, needsYou: false });
const frameSwitcher = { chips: [chip(1), chip(2)], overflow: [], onGoToFrame: vi.fn(), onCreateFrame: vi.fn(), activeFrameId: "f1" };
const nav = {
  projects: [],
  activeProjectId: null,
  fallbackName: "/repo",
  onSelectProject: vi.fn(),
  onOpenCanvases: vi.fn(),
  onOpenSettings: vi.fn(),
  onNewProject: vi.fn(),
  onCloseProject: vi.fn(),
  onToggleDock: vi.fn(),
  onToggleFrameOverview: vi.fn(),
};

describe("CanvasControlCluster", () => {
  it("renders the project, then one group of Frame chips, Overview, Dock and Settings", () => {
    const { container } = render(<CanvasControlCluster nav={nav} frameSwitcher={frameSwitcher} placement="up" />);
    const groups = container.querySelectorAll(".canvas-cc-group");
    expect(groups).toHaveLength(2);
    expect(within(groups[0] as HTMLElement).getByRole("button", { name: "Switch project" })).toBeInTheDocument();
    expect(within(groups[1] as HTMLElement).getByTestId("frame-switcher")).toBeInTheDocument();
    expect(within(groups[1] as HTMLElement).getByRole("button", { name: "Frame overview" })).toBeInTheDocument();
    expect(within(groups[1] as HTMLElement).getByRole("button", { name: "Show the Dock" })).toBeInTheDocument();
    expect(within(groups[1] as HTMLElement).getByRole("button", { name: "Canvas settings" })).toBeInTheDocument();
    expect(container.querySelectorAll(".canvas-cc-div")).toHaveLength(1);
  });

  it("wires the Dock and Settings and reflects pressed state", () => {
    const onToggleDock = vi.fn();
    const onOpenSettings = vi.fn();
    render(<CanvasControlCluster nav={{ ...nav, onToggleDock, onOpenSettings, dockOpen: true, dockChord: "⌘B" }} placement="down" />);
    const dock = screen.getByRole("button", { name: "Hide the Dock" });
    expect(dock).toHaveAttribute("aria-pressed", "true");
    expect(dock).toHaveAttribute("title", "Dock · on · ⌘B");
    fireEvent.click(dock);
    fireEvent.click(screen.getByRole("button", { name: "Canvas settings" }));
    expect(onToggleDock).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("has no Fleet button: Fleet lives on the Dock's rail now", () => {
    render(<CanvasControlCluster nav={nav} placement="up" />);
    expect(screen.queryByRole("button", { name: /fleet/i })).toBeNull();
  });

  it("badges the Dock with the sum of what waits, and names each app in the tooltip", () => {
    const dockWaiting = [
      { app: "automation" as const, label: "Automation", count: 2 },
      { app: "automation" as const, label: "Tasks", count: 1 },
    ];
    render(<CanvasControlCluster nav={{ ...nav, dockWaiting, dockChord: "⌘B" }} placement="up" />);
    const dock = screen.getByRole("button", { name: "Show the Dock, 3 waiting" });
    expect(dock).toHaveTextContent("3");
    expect(dock).toHaveAttribute("title", "Dock · Automation 2 · Tasks 1 · ⌘B");
  });

  it("shows no badge when nothing waits", () => {
    const { container } = render(<CanvasControlCluster nav={nav} placement="up" />);
    expect(container.querySelector(".canvas-dock-badge")).toBeNull();
  });

  it("renders the project adornment inside the project group", () => {
    const { container } = render(<CanvasControlCluster nav={nav} placement="down" projectAdornment={<span data-testid="adorn" />} />);
    expect(container.querySelector(".canvas-cc-group")).toContainElement(screen.getByTestId("adorn"));
  });
});

describe("CanvasTopBar shares the cluster", () => {
  it("shows Frame chips, Overview, the Dock and Settings in top-bar mode", () => {
    render(
      <CanvasTopBar
        projectName="/repo"
        onOpenSettings={() => {}}
        frameSwitcher={frameSwitcher}
        dock={{ onToggleDock: () => {} }}
        onToggleFrameOverview={() => {}}
      />,
    );
    expect(screen.getByTestId("frame-switcher")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Frame overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the Dock" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Canvas settings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
  });
});
