import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { CanvasBehaviorTab } from "../CanvasBehaviorTab";
import { SETTINGS_SECTIONS } from "@/modules/lotus-settings/settings-sections";
import {
  getCanvasBehaviorSettings,
  resetCanvasBehaviorStoreForTests,
} from "@/modules/codecanvas/hooks/useCanvasBehaviorSettings";

describe("CanvasBehaviorTab", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCanvasBehaviorStoreForTests();
  });

  it("is registered as the Canvas section of the Canvas group", () => {
    const section = SETTINGS_SECTIONS.find((s) => s.id === "canvas");
    expect(section?.group).toBe("canvas");
    expect(section?.title).toBe("Canvas");
  });

  it("renders a switch for each behaviour, reflecting current default state", () => {
    render(<CanvasBehaviorTab />);
    expect(screen.getByRole("switch", { name: "Let agents move the canvas & focus" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "Auto-focus new nodes" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Restore viewport on open" })).toHaveAttribute("aria-checked", "true");
    expect((screen.getByRole("combobox", { name: "Tidy nodes" }) as HTMLSelectElement).value).toBe("open");
  });

  it("groups rows into Layout, Agents and Behavior, in that order", () => {
    render(<CanvasBehaviorTab />);
    const [layout, agents, behavior] = ["Layout", "Agents", "Behavior"].map((t) => screen.getByText(t));
    expect(layout.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(agents.compareDocumentPosition(behavior) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("no longer renders the rows that moved or were removed", () => {
    render(<CanvasBehaviorTab />);
    for (const name of [
      "Shift+Enter inserts a newline",
      "Auto-close after each command",
      "Narrate agent work aloud",
      "Elevate node on select",
      "Tidy when a node opens",
      "Tidy when a node closes",
      "Auto-arrange notes",
    ]) {
      expect(screen.queryByRole("switch", { name })).toBeNull();
    }
  });

  it("changing Tidy nodes updates the shared store", () => {
    render(<CanvasBehaviorTab />);
    fireEvent.change(screen.getByRole("combobox", { name: "Tidy nodes" }), { target: { value: "open-close" } });
    expect(getCanvasBehaviorSettings().tidyMode).toBe("open-close");
  });

  it("shows the Left toolbar switch on (today's default)", () => {
    render(<CanvasBehaviorTab />);
    expect(screen.getByRole("switch", { name: "Left toolbar" })).toHaveAttribute("aria-checked", "true");
  });

  it("toggling Left toolbar updates the shared store", () => {
    render(<CanvasBehaviorTab />);
    fireEvent.click(screen.getByRole("switch", { name: "Left toolbar" }));
    expect(getCanvasBehaviorSettings().showToolRail).toBe(false);
  });

  it("shows Top controls as a segmented control defaulting to Top bar", () => {
    render(<CanvasBehaviorTab />);
    const group = screen.getByRole("group", { name: "Top controls" });
    const topBar = within(group).getByRole("button", { name: "Top bar" });
    const inBar = within(group).getByRole("button", { name: "In command bar" });
    expect(topBar).toHaveAttribute("aria-pressed", "true");
    expect(inBar).toHaveAttribute("aria-pressed", "false");
  });

  it("choosing In command bar updates the shared store", () => {
    render(<CanvasBehaviorTab />);
    const group = screen.getByRole("group", { name: "Top controls" });
    fireEvent.click(within(group).getByRole("button", { name: "In command bar" }));
    expect(getCanvasBehaviorSettings().topControls).toBe("command-bar");
  });

  it("shows Command bar as a segmented control defaulting to Solid bar", () => {
    render(<CanvasBehaviorTab />);
    const group = screen.getByRole("group", { name: "Command bar" });
    const solid = within(group).getByRole("button", { name: "Solid bar (default)" });
    const strip = within(group).getByRole("button", { name: "Bottom strip" });
    expect(solid).toHaveAttribute("aria-pressed", "true");
    expect(strip).toHaveAttribute("aria-pressed", "false");
  });

  it("choosing Bottom strip updates the shared store", () => {
    render(<CanvasBehaviorTab />);
    const group = screen.getByRole("group", { name: "Command bar" });
    fireEvent.click(within(group).getByRole("button", { name: "Bottom strip" }));
    expect(getCanvasBehaviorSettings().commandBarRest).toBe("veil");
  });

  it("lets the user keep completion notifications until manually dismissed", () => {
    render(<CanvasBehaviorTab />);
    const toggle = screen.getByRole("switch", { name: "Auto-dismiss completion notifications" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);

    expect(getCanvasBehaviorSettings().completionToastAutoDismiss).toBe(false);
  });

  it("renders the completion-toast position selector defaulting to bottom-right", () => {
    render(<CanvasBehaviorTab />);
    const select = screen.getByRole("combobox", { name: "Completion toast position" }) as HTMLSelectElement;
    expect(select.value).toBe("bottom-right");
  });

  it("changing the completion-toast position updates the shared store", () => {
    render(<CanvasBehaviorTab />);
    fireEvent.change(screen.getByRole("combobox", { name: "Completion toast position" }), {
      target: { value: "top-left" },
    });
    expect(getCanvasBehaviorSettings().toastPosition).toBe("top-left");
  });

  it("toggling a switch updates the shared store", () => {
    render(<CanvasBehaviorTab />);
    fireEvent.click(screen.getByRole("switch", { name: "Let agents move the canvas & focus" }));
    expect(getCanvasBehaviorSettings().allowAgentCanvasControl).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Let agents draw & generate diagrams" }));
    expect(getCanvasBehaviorSettings().allowAgentCanvasDraw).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Auto-focus new nodes" }));
    expect(getCanvasBehaviorSettings().autoFocusNewNodes).toBe(false);
  });
});
