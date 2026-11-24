import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const usage = (account: string, inUse = false) => ({ provider: "claude", account, plan: null, inUse, windows: [], error: null });
vi.mock("@/lib/tauri-api", () => ({
  getUsageSnapshot: vi.fn(async () => [usage("acme", true), usage("globex")]),
  listAccounts: vi.fn(async () => []),
}));

import { LaunchAccountTag } from "../ChatAccount";

describe("LaunchAccountTag", () => {
  it("names the default by its real account, and a press switches without running the row", async () => {
    const onCycle = vi.fn();
    const row = vi.fn();
    render(<div onClick={row} onPointerDown={row}><LaunchAccountTag account={null} onCycle={onCycle} /></div>);
    const tag = await screen.findByRole("button", { name: "Launches on acme. Tab switches account" });
    fireEvent.pointerDown(tag);
    fireEvent.click(tag);
    expect(onCycle).toHaveBeenCalledTimes(1);
    expect(row).not.toHaveBeenCalled();
  });
});
