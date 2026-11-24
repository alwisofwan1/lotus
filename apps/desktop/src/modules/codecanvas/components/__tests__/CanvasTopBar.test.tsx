import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { CanvasTopBar } from "../CanvasTopBar";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";

function proj(id: string, rootDir: string, alias: string | null = null): CodeCanvasProjectMeta {
  return { id, rootDir, alias, position: 0, updatedAt: 0, lastOpenedAt: 0 };
}

describe("CanvasTopBar settings control", () => {
  it("opens settings via a button rather than a route link", () => {
    const onOpenSettings = vi.fn();
    render(<CanvasTopBar projectName="/Users/me/proj" onOpenSettings={onOpenSettings} />);

    const gear = screen.getByRole("button", { name: "Canvas settings" });
    fireEvent.click(gear);

    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(gear.closest("a")).toBeNull();
  });

  it("opens the canvases browser from the project menu (the grid button is the Frame overview now)", () => {
    const onOpenCanvases = vi.fn();
    render(<CanvasTopBar projectName="/Users/me/proj" onOpenSettings={() => {}} onOpenCanvases={onOpenCanvases} />);

    expect(screen.queryByRole("button", { name: "Browse canvases" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /all projects/i }));
    expect(onOpenCanvases).toHaveBeenCalledOnce();
  });

  it("no longer renders the worktree-isolation or save-as-template controls", () => {
    render(<CanvasTopBar projectName="/Users/me/proj" onOpenSettings={() => {}} onOpenCanvases={() => {}} />);

    expect(screen.queryByRole("button", { name: /isolate agents/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /save canvas as template/i })).toBeNull();
  });

  it("no longer renders the command-palette, notifications, or Swarm chrome (slimmed header)", () => {
    render(<CanvasTopBar projectName="/Users/me/proj" onOpenSettings={() => {}} onOpenCanvases={() => {}} />);

    // ⌘K palette is now keyboard-only; Swarm lives on the homepage CodeSwarm card.
    expect(screen.queryByRole("button", { name: "Open canvas command palette" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open Swarm command center" })).toBeNull();
  });

  it("flags the dev build so it is not confused with a release window", () => {
    render(<CanvasTopBar projectName="/Users/me/proj" onOpenSettings={() => {}} />);
    // vitest runs with NODE_ENV != "production", so the dev badge is shown.
    expect(screen.getByRole("img", { name: "Development build" })).toHaveClass("canvas-topbar-dev");
  });

  it("carries no workflow-editing controls — workflow-on-canvas was retired with CodeSwarm", () => {
    render(<CanvasTopBar projectName="/Users/me/proj" onOpenSettings={() => {}} />);

    expect(screen.queryByText("Editing Workflow")).not.toBeInTheDocument();
    for (const name of ["Save workflow", "Save workflow as copy", "Exit workflow editing"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});

describe("CanvasTopBar project switcher", () => {
  const projects = [
    proj("p1", "/Users/me/alpha"),
    proj("p2", "/Users/me/beta", "Beta"),
  ];

  function renderMenu(overrides: Partial<Parameters<typeof CanvasTopBar>[0]> = {}) {
    const handlers = {
      onSelectProject: vi.fn(),
      onNewProject: vi.fn(),
      onCloseProject: vi.fn(),
      onOpenCanvases: vi.fn(),
    };
    render(
      <CanvasTopBar
        projectName="/Users/me/beta"
        onOpenSettings={() => {}}
        projects={projects}
        activeProjectId="p2"
        {...handlers}
        {...overrides}
      />,
    );
    return handlers;
  }

  it("shows the active project name in the trigger (no more 'CodeCanvas' label)", () => {
    renderMenu();
    expect(screen.queryByText("CodeCanvas")).toBeNull();
    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Beta");
  });

  it("shows a restoring project label during boot instead of no project", () => {
    renderMenu({ projects: [], activeProjectId: null, projectName: "", projectRestoring: true });

    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Restoring…");
    expect(screen.queryByText("No project")).not.toBeInTheDocument();
  });

  it("opens a dropdown listing every project and switches on click", () => {
    const { onSelectProject } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));

    expect(screen.getByRole("menuitemradio", { name: "alpha" })).toBeInTheDocument();
    const active = screen.getByRole("menuitemradio", { name: "Beta" });
    expect(active).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "alpha" }));
    expect(onSelectProject).toHaveBeenCalledWith("p1");
  });

  it("exposes browse, new-project, and close-project actions", () => {
    const { onNewProject, onCloseProject, onOpenCanvases } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));

    fireEvent.click(screen.getByRole("menuitem", { name: /All projects/ }));
    expect(onOpenCanvases).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New project/ }));
    expect(onNewProject).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Close project/ }));
    expect(onCloseProject).toHaveBeenCalledOnce();
  });
});

describe("the machine a remote project lives on", () => {
  const machine = {
    label: "devbox-vps",
    host: "devbox-vps",
    tunnel: { state: "open" as const, ports: [9877] },
    hooks: { state: "ready" as const },
    onRetry: () => {},
    onRecheck: () => Promise.resolve(),
    onDisconnect: () => {},
  };

  it("says nothing at all for a project on this machine", () => {
    render(<CanvasTopBar projectName="/Users/me/proj" onOpenSettings={() => {}} />);
    expect(screen.queryByTitle(/melapor balik|jalan pulang/)).toBeNull();
  });

  /// The status rules themselves are pinned in `services/__tests__/machine-status.test.ts`.
  it("names the machine and shows the way home is up", () => {
    render(<CanvasTopBar projectName="/srv/devbox/api" onOpenSettings={() => {}} machine={machine} />);

    const chip = screen.getByRole("button", { name: "devbox-vps" });
    expect(chip.getAttribute("data-tone")).toBe("ok");
    expect(chip.getAttribute("title")).toMatch(/bisa melapor balik/);
  });
});
