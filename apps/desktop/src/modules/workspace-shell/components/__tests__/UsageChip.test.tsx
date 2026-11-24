import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineUsage, UsageAccount } from "@/modules/workspace-shell/services/usage";

const snapshot = vi.fn<() => Promise<UsageAccount[]>>();
const remote = vi.fn<() => Promise<MachineUsage[]>>(async () => []);
const choose = vi.fn<(account: string | null, provider?: string) => Promise<void>>();
const remoteDefault = vi.fn(async (_target: string, _id: string | null) => {});
vi.mock("@/lib/tauri-api", () => ({
  getUsageSnapshot: () => snapshot(),
  getRemoteUsage: () => remote(),
  chooseUsageAccount: (account: string | null, provider?: string) => choose(account, provider),
  listAccounts: async () => [{ id: "work", loginCommand: "CLAUDE_CONFIG_DIR='/w' claude auth login" }],
  listRemoteAccounts: async () => ({ machine: "vmi1", accounts: [{ id: "ops", loginCommand: "CLAUDE_CONFIG_DIR='/vps/ops' claude auth login" }] }),
  setRemoteDefaultAccount: (target: string, id: string | null) => remoteDefault(target, id),
}));
const openSettings = vi.fn();
vi.mock("@/modules/lotus-settings/lotus-settings-context", () => ({
  useLotusSettings: () => ({ open: false, openSettings, closeSettings: () => {} }),
}));

import { UsageChip } from "../UsageChip";
import { onSignInPaneRequest } from "@/modules/workspace-shell/services/sign-in-pane";

const weekly = { kind: "weekly_all", group: "weekly", usedPercent: 15, resetsAtMs: null, windowMinutes: 10080 };
const ACCOUNTS: UsageAccount[] = [
  { provider: "claude", account: "initech", plan: "team", inUse: true, windows: [weekly], error: null, identity: { email: "me@x.io", org: "Acme" } },
  { provider: "claude", account: "work", plan: "team", inUse: false, windows: [], error: "sign-in expired — run `ccs work` once" },
];

describe("UsageChip", () => {
  beforeEach(() => {
    localStorage.clear();
    snapshot.mockResolvedValue(ACCOUNTS);
    remote.mockResolvedValue([]);
    choose.mockResolvedValue();
  });

  it("switches new work to another Claude account and reloads", async () => {
    render(<UsageChip />);
    fireEvent.click(await screen.findByRole("button", { name: /initech/ }));
    expect(screen.queryByRole("button", { name: "Make initech the default" })).toBeNull();
    expect(screen.getByText("Default")).toBeTruthy();
    const calls = snapshot.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Make work the default" }));
    expect(choose).toHaveBeenCalledWith("work", "claude");
    await vi.waitFor(() => expect(snapshot.mock.calls.length).toBe(calls + 1));
  });

  it("shows the in-use account's weekly figure, and every account on click", async () => {
    render(<UsageChip />);
    const chip = await screen.findByRole("button", { name: /initech/ });
    expect(chip.textContent).toContain("15%this week");

    fireEvent.click(chip);
    expect(screen.getByRole("dialog", { name: "Subscription limits" })).toBeTruthy();
    expect(screen.getByText("sign-in expired — run `ccs work` once")).toBeTruthy();
  });

  it("puts the full name and weekly reset in the chip's tooltip", async () => {
    const resetsAtMs = Date.now() + 3 * 86_400_000;
    snapshot.mockResolvedValue([{ ...ACCOUNTS[0], windows: [{ ...weekly, resetsAtMs }] }]);
    render(<UsageChip />);
    const title = (await screen.findByRole("button", { name: /initech/ })).getAttribute("title") ?? "";
    expect(title).toMatch(/^initech · weekly resets /);
  });

  it("hides an account and remembers it", async () => {
    render(<UsageChip />);
    fireEvent.click(await screen.findByRole("button", { name: /initech/ }));
    fireEvent.click(screen.getByRole("button", { name: "Hide work" }));

    expect(screen.queryByText(/ccs work/)).toBeNull();
    expect(JSON.parse(localStorage.getItem("lotus.usage.hidden") ?? "[]")).toEqual(["claude:work"]);
    expect(screen.getByRole("button", { name: "1 hidden" })).toBeTruthy();
  });

  it("keeps a way back when every account is hidden", async () => {
    localStorage.setItem("lotus.usage.hidden", JSON.stringify(["claude:initech", "claude:work"]));
    render(<UsageChip />);
    fireEvent.click(await screen.findByRole("button", { name: /Limits/ }));
    fireEvent.click(screen.getByRole("button", { name: "2 hidden" }));
    expect(screen.getByText("sign-in expired — run `ccs work` once")).toBeTruthy();
  });

  it("draws nothing when the snapshot fails", async () => {
    snapshot.mockRejectedValue(new Error("Tauri IPC unavailable"));
    const { container } = render(<UsageChip />);
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
  });

  it("names who is signed in, and signs a signed-out account in through a pane", async () => {
    const heard: string[] = [];
    const off = onSignInPaneRequest((command) => (heard.push(command), true));
    // An expired login keeps its identity in .claude.json; it still needs the button.
    const idle = { ...ACCOUNTS[1], account: "idle", error: "idle — not used in the last 8 h; numbers update on its next use" };
    snapshot.mockResolvedValue([ACCOUNTS[0], { ...ACCOUNTS[1], identity: { email: "w@x.io", org: null } }, idle]);
    render(<UsageChip />);
    fireEvent.click(await screen.findByRole("button", { name: /initech/ }));
    expect(screen.getByText("me@x.io")).toBeTruthy();
    expect(screen.getByText("Acme · team")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in initech" })).toBeNull();
    // Idle is a token that lapsed from non-use; the CLI refreshes it on next use.
    expect(screen.queryByRole("button", { name: "Sign in idle" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in work" }));
    await vi.waitFor(() => expect(heard).toEqual(["CLAUDE_CONFIG_DIR='/w' claude auth login"]));
    off();
  });

  it("opens Settings › Accounts when no pane can be opened, and from Manage accounts", async () => {
    render(<UsageChip />);
    fireEvent.click(await screen.findByRole("button", { name: /initech/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in work" }));
    await vi.waitFor(() => expect(openSettings).toHaveBeenCalledWith({ section: "accounts" }));
    openSettings.mockClear();
    fireEvent.click(await screen.findByRole("button", { name: /initech/ }));
    fireEvent.click(screen.getByRole("button", { name: "Manage…" }));
    expect(openSettings).toHaveBeenCalledWith({ section: "accounts" });
  });

  it("says no account was found, with a way to add one", async () => {
    snapshot.mockResolvedValue([]);
    render(<UsageChip />);
    fireEvent.click(await screen.findByRole("button", { name: /Limits/ }));
    expect(screen.getByText("No subscription account found.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add account" })).toBeTruthy();
  });

  it("groups by machine, shows a shared login once, and offers no actions on a machine not connected", async () => {
    remote.mockResolvedValue([
      {
        target: "devbox-vps",
        machine: "vmi1",
        state: "not-connected",
        asOfMs: Date.now() - 60_000,
        error: null,
        accounts: [
          { provider: "claude", account: "main", plan: "max", inUse: true, windows: [weekly], error: null, identity: { email: "me@x.io", org: "Acme" } },
          { provider: "claude", account: "ops", plan: "max", inUse: false, windows: [], error: "not signed in" },
        ],
      },
    ]);
    render(<UsageChip />);
    fireEvent.click(await screen.findByRole("button", { name: /initech/ }));
    expect(await screen.findByText("devbox-vps")).toBeTruthy();
    expect(screen.getByText("This Mac")).toBeTruthy();
    expect(screen.getByText(/not connected/)).toBeTruthy();
    // Live here beats saved there: the shared login stays on This Mac, named on both.
    expect(screen.queryByText("main")).toBeNull();
    expect(screen.getByText("signed in on This Mac · devbox-vps")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make ops the default" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in ops" })).toBeNull();
  });

  it("keeps another machine's login when its twin here is hidden", async () => {
    localStorage.setItem("lotus.usage.hidden", JSON.stringify(["claude:initech"]));
    remote.mockResolvedValue([
      {
        target: "devbox-vps",
        machine: "vmi1",
        state: "live",
        asOfMs: null,
        error: null,
        accounts: [{ provider: "claude", account: "hss", plan: "team", inUse: false, windows: [weekly], error: null, identity: { email: "me@x.io", org: "Acme" } }],
      },
    ]);
    render(<UsageChip />);
    fireEvent.click(await screen.findByRole("button", { name: /work|Limits/ }));
    expect(await screen.findByText("hss")).toBeTruthy();
  });

  it("sets the default and signs in on a connected machine, in a pane on that machine", async () => {
    remote.mockResolvedValue([
      {
        target: "devbox-vps",
        machine: "vmi1",
        state: "live",
        asOfMs: null,
        error: null,
        accounts: [{ provider: "claude", account: "ops", plan: "max", inUse: false, windows: [], error: "not signed in" }],
      },
    ]);
    const heard: [string, string | null][] = [];
    const off = onSignInPaneRequest((command, target) => (heard.push([command, target]), true));
    render(<UsageChip />);
    fireEvent.click(await screen.findByRole("button", { name: /initech/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Make ops the default" }));
    expect(remoteDefault).toHaveBeenCalledWith("devbox-vps", "ops");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in ops" }));
    await vi.waitFor(() => expect(heard).toEqual([["CLAUDE_CONFIG_DIR='/vps/ops' claude auth login", "devbox-vps"]]));
    off();
  });

  it("groups by provider, shows each reset beside its bar, and sets the Codex default", async () => {
    const resetsAtMs = Date.now() + 3 * 86_400_000;
    snapshot.mockResolvedValue([
      ACCOUNTS[0],
      { provider: "codex", account: "dawa", plan: "ChatGPT Business", inUse: false, windows: [], error: "no numbers yet", identity: { email: "a@b.io", org: null } },
      { provider: "antigravity", account: "default", plan: null, inUse: false, windows: [{ kind: "gemini", group: "weekly", usedPercent: 22, resetsAtMs, windowMinutes: 10080, scope: "Gemini" }], error: null, identity: { email: "g@x.io", org: null } },
    ]);
    render(<UsageChip />);
    fireEvent.click(await screen.findByRole("button", { name: /initech/ }));
    expect(screen.getByRole("heading", { name: "Antigravity" })).toBeTruthy();
    expect(screen.getByText(/^resets /)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make default the default" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Make dawa the default" }));
    expect(choose).toHaveBeenCalledWith("dawa", "codex");
  });
});
