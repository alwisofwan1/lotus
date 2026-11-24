import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CanvasProjectEmptyState } from "../CanvasProjectEmptyState";
import type { RecentProject } from "../../services/recent-projects";

const RECENTS: RecentProject[] = [
  { id: "a", name: "lotus", path: "~/workspace/experiments" },
  { id: "b", name: "orbit-vault", path: "~/workspace" },
];

describe("CanvasProjectEmptyState", () => {
  it("labels the region so screen readers announce the empty state", () => {
    render(<CanvasProjectEmptyState onOpen={() => {}} />);
    expect(screen.getByRole("region", { name: /no project open/i })).toBeInTheDocument();
  });

  it("opens the native folder picker via the primary action", () => {
    const onOpen = vi.fn();
    render(<CanvasProjectEmptyState onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /open a project/i }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("opens the picker on the ⌘O / Ctrl+O shortcut", () => {
    const onOpen = vi.fn();
    render(<CanvasProjectEmptyState onOpen={onOpen} />);
    fireEvent.keyDown(window, { key: "o", metaKey: true });
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("collapses to a single action when there is no history", () => {
    render(<CanvasProjectEmptyState onOpen={() => {}} recents={[]} />);
    // Only the primary action button exists — no recent rows.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("renders recent projects and opens one on click", () => {
    const onSelectRecent = vi.fn();
    render(<CanvasProjectEmptyState onOpen={() => {}} recents={RECENTS} onSelectRecent={onSelectRecent} />);
    fireEvent.click(screen.getByRole("button", { name: /open orbit-vault/i }));
    expect(onSelectRecent).toHaveBeenCalledWith("b");
  });

  it("opens the nth recent on the ⌘n shortcut", () => {
    const onSelectRecent = vi.fn();
    render(<CanvasProjectEmptyState onOpen={() => {}} recents={RECENTS} onSelectRecent={onSelectRecent} />);
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(onSelectRecent).toHaveBeenCalledWith("a");
  });

  it("ignores a ⌘n beyond the available history", () => {
    const onSelectRecent = vi.fn();
    render(<CanvasProjectEmptyState onOpen={() => {}} recents={RECENTS} onSelectRecent={onSelectRecent} />);
    fireEvent.keyDown(window, { key: "5", metaKey: true });
    expect(onSelectRecent).not.toHaveBeenCalled();
  });
});
