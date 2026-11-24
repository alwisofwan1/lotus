import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MoveOffCcs } from "../sections/MoveOffCcs";

const before = {
  backup: "/s/backups/ccs-2026-11-13.tar.gz",
  merges: [{ from: "/h/.ccs/shared/context-groups/default/projects", to: "/h/.claude/projects", collisions: 10 }],
  relinks: [
    { link: "/h/.ccs/instances/work/projects", to: "/h/.claude/projects" },
    { link: "/h/.ccs/instances/work/odd", to: null },
  ],
  defaultAccount: "work",
  mcpEntries: [{ file: "/h/.claude.json", name: "ccs-websearch" }],
};
const after = { ...before, relinks: [{ link: "/h/.ccs/instances/work/odd", to: null }], defaultAccount: null, mcpEntries: [] };

const api = vi.hoisted(() => ({
  planCcsMigration: vi.fn(),
  runCcsMigration: vi.fn(),
  removeCcsMcpEntries: vi.fn(async () => []),
}));
vi.mock("@/lib/tauri-api", () => api);

afterEach(() => vi.clearAllMocks());

describe("MoveOffCcs", () => {
  it("shows nothing on a machine without ccs", async () => {
    api.planCcsMigration.mockResolvedValue(null);
    const { container } = render(<MoveOffCcs />);
    await waitFor(() => expect(api.planCcsMigration).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("previews the move, runs it only on the second click, then lists what is left", async () => {
    api.planCcsMigration.mockResolvedValueOnce(before).mockResolvedValue(after);
    api.runCcsMigration.mockResolvedValue(before);
    render(<MoveOffCcs />);
    expect(await screen.findByText("1 links re-pointed to ~/.claude")).toBeTruthy();
    expect(screen.getByText(/starts new work as work/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Move off ccs…" }));
    expect(api.runCcsMigration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move now?" }));
    expect(await screen.findByText(/Left for you: uninstall ccs/)).toBeTruthy();
    expect(api.runCcsMigration).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Backup: \/s\/backups/)).toBeTruthy();
    expect(screen.getByText(/Not moved .*odd/)).toBeTruthy();
  });

  it("removes ccs MCP servers only on confirm", async () => {
    api.planCcsMigration.mockResolvedValue(before);
    render(<MoveOffCcs />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove…" }));
    expect(api.removeCcsMcpEntries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove them?" }));
    await waitFor(() => expect(api.removeCcsMcpEntries).toHaveBeenCalledTimes(1));
  });

  it("asks another machine's Lotus Host with its target", async () => {
    api.planCcsMigration.mockResolvedValue(before);
    api.runCcsMigration.mockResolvedValue(before);
    render(<MoveOffCcs target="alwi@devbox-vps:22" />);
    fireEvent.click(await screen.findByRole("button", { name: "Move off ccs…" }));
    fireEvent.click(screen.getByRole("button", { name: "Move now?" }));
    await waitFor(() => expect(api.runCcsMigration).toHaveBeenCalledWith("alwi@devbox-vps:22"));
    expect(api.planCcsMigration).toHaveBeenCalledWith("alwi@devbox-vps:22");
  });
});
