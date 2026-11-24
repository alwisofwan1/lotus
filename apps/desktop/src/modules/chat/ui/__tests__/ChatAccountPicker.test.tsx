import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri-api", () => ({ getUsageSnapshot: async () => [] }));

import type { UsageAccount } from "@/modules/workspace-shell/services/usage";
import { ChatAccountPicker } from "../ChatAccount";

const acct = (account: string, inUse = false, session = 4, error: string | null = null): UsageAccount => ({
  provider: "claude",
  account,
  plan: "team",
  inUse,
  windows: [
    { kind: "session", group: "session", usedPercent: session, resetsAtMs: null, windowMinutes: 300 },
    { kind: "weekly_all", group: "weekly", usedPercent: 13, resetsAtMs: null, windowMinutes: 10080 },
  ],
  error,
});

describe("ChatAccountPicker", () => {
  it("says which account this chat runs on, marks the default, and switches", async () => {
    const onPick = vi.fn(async () => {});
    render(<ChatAccountPicker accounts={[acct("initech", true), acct("acme")]} current="acme" disabled={false} onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "This chat runs on acme" }));
    expect(screen.getByText("default")).toBeTruthy();
    expect(screen.getAllByText("87% left")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /initech/ }));
    expect(onPick).toHaveBeenCalledWith("initech");
  });

  it("ranks by the tightest window and locks rows that cannot take a message", () => {
    render(
      <ChatAccountPicker
        accounts={[acct("acme"), acct("globex", false, 100), acct("old", false, 0, "sign-in is stale — start `ccs old` once to refresh it")]}
        current="acme"
        disabled={false}
        onPick={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "This chat runs on acme" }));
    expect((screen.getByRole("button", { name: /globex/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Full")).toBeTruthy();
    expect((screen.getByRole("button", { name: /old/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Signed out")).toBeTruthy();
  });

  it("keeps a rate-limited or offline account pickable, and re-reads accounts on open", () => {
    const onPick = vi.fn(async () => {});
    const onOpen = vi.fn();
    render(
      <ChatAccountPicker
        accounts={[acct("acme"), acct("initech", false, 4, "Anthropic is rate-limiting usage checks — try again in a few minutes")]}
        current="acme"
        disabled={false}
        onPick={onPick}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "This chat runs on acme" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Signed out")).toBeNull();
    expect(screen.getByText("Limits unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /initech/ }));
    expect(onPick).toHaveBeenCalledWith("initech");
  });

  it("is locked while a reply runs", () => {
    render(<ChatAccountPicker accounts={[acct("initech"), acct("acme")]} current="acme" disabled onPick={vi.fn()} />);
    expect((screen.getByRole("button", { name: "This chat runs on acme" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
