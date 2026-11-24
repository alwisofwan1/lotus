import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const usage = (account: string, inUse = false) => ({ provider: "claude", account, plan: null, inUse, windows: [], error: null });
const api = vi.hoisted(() => ({
  getUsageSnapshot: vi.fn(),
  listAccounts: vi.fn(async () => [] as unknown[]),
  getPaneAgentTitle: vi.fn(),
}));
vi.mock("@/lib/tauri-api", () => api);
const order: string[] = [];
vi.mock("@/modules/codespace/services/terminal-session-registry", () => ({
  closeTerminalSession: (id: string) => order.push(`close ${id}`),
}));

import { PaneAccountChip, PaneLimitStrip } from "../PaneAccountChip";

describe("PaneAccountChip", () => {
  it("restarts the pane on another account with --resume, after a confirm, closing its PTY first", async () => {
    api.getUsageSnapshot.mockResolvedValue([usage("acme", true), usage("globex")]);
    api.getPaneAgentTitle.mockResolvedValue({ sessionKey: "/h/.claude/projects/-repo/4f1c.jsonl", hasPrompt: true });
    const onMove = vi.fn((account: string, command: string) => order.push(`move ${account} ${command}`));
    render(<PaneAccountChip paneId="p1" account={undefined} command="claude --dangerously-skip-permissions" name="Nara" busy={false} onMove={onMove} />);

    fireEvent.click(await screen.findByRole("button", { name: "Nara runs on acme" }));
    fireEvent.click(screen.getByRole("button", { name: /globex/ }));
    expect(await screen.findByRole("alertdialog", { name: "Restart Nara on globex? The conversation continues there." })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    await waitFor(() => expect(onMove).toHaveBeenCalled());
    expect(order).toEqual(["close p1", "move globex claude --dangerously-skip-permissions --resume 4f1c"]);
  });

  it("offers the least-used other account after a limit and restarts there with --resume", async () => {
    order.length = 0;
    api.getUsageSnapshot.mockResolvedValue([usage("acme", true), usage("globex")]);
    api.getPaneAgentTitle.mockResolvedValue({ sessionKey: "/h/.claude/projects/-repo/4f1c.jsonl", hasPrompt: true });
    const onMove = vi.fn((account: string, command: string) => order.push(`move ${account} ${command}`));
    render(<PaneLimitStrip paneId="p1" account={undefined} command="claude" limit="You've hit your 5-hour limit · resets 2:20pm" onMove={onMove} />);

    expect(await screen.findByText(/resets 2:20pm/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Continue on globex" }));

    await waitFor(() => expect(onMove).toHaveBeenCalled());
    expect(order).toEqual(["close p1", "move globex claude --resume 4f1c"]);
  });

  it("cannot be used mid-turn", async () => {
    api.getUsageSnapshot.mockResolvedValue([usage("acme", true), usage("globex")]);
    api.getPaneAgentTitle.mockResolvedValue(null);
    render(<PaneAccountChip paneId="p1" account="globex" command="claude" name="Nara" busy onMove={vi.fn()} />);
    expect(((await screen.findByRole("button", { name: "Nara runs on globex" })) as HTMLButtonElement).disabled).toBe(true);
  });
});
