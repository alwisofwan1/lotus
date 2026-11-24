import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JumpPalette } from "../JumpPalette";
import type { JumpSources } from "../../services/jump-items";

const sources = (): JumpSources => ({
  workspaces: [
    { id: "w1", name: "Lotus", folder: "/w/lotus", panes: [{ id: "nia", kind: "terminal", title: "claude", meta: "", persona: "Nia", activity: "needs-you" }] },
  ],
  threads: [],
  threadInPane: new Map(),
  recent: { w1: 5 },
});

describe("JumpPalette", () => {
  it("opens on what needs the user, moves with ↓, jumps with Enter", () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    render(<JumpPalette getSources={sources} onJump={onJump} onClose={onClose} />);
    const input = screen.getByRole("combobox");
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual([
      expect.stringContaining("Nia · claude"),
      expect.stringContaining("Lotus"),
    ]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
    expect(onJump).toHaveBeenCalledWith({ kind: "workspace", workspaceId: "w1" });
  });

  it("searches modes by name and closes on Escape", () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    render(<JumpPalette getSources={sources} onJump={onJump} onClose={onClose} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "chat" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onJump).toHaveBeenCalledWith({ kind: "mode", mode: "chat" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("titles the two Needs you groups and marks a Done row seen with ⌫, without opening it", () => {
    const onJump = vi.fn();
    const onMarkSeen = vi.fn();
    const withDone = (): JumpSources => ({
      ...sources(),
      workspaces: [
        {
          id: "w1",
          name: "Lotus",
          folder: "/w/lotus",
          panes: [
            { id: "nia", kind: "terminal", title: "claude", meta: "", persona: "Nia", activity: "needs-you" },
            { id: "kai", kind: "terminal", title: "codex", meta: "", persona: "Kai", activity: "idle", unread: true },
          ],
        },
      ],
    });
    render(<JumpPalette getSources={withDone} onJump={onJump} onMarkSeen={onMarkSeen} onClose={vi.fn()} />);
    const groups = () => [...document.querySelectorAll(".jp-group")].map((title) => title.textContent);
    expect(groups()).toEqual(["Waiting 1", "Done, not seen 1"]);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onMarkSeen).toHaveBeenCalledWith({ kind: "pane", paneId: "kai" });
    expect(onJump).not.toHaveBeenCalled();
    expect(groups()).toEqual(["Waiting 1"]);
  });
});
