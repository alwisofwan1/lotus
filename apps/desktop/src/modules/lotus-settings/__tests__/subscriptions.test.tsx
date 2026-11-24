import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AntigravityLogin, Subscriptions } from "../sections/Subscriptions";
import type { AccountView } from "@/lib/tauri-api";
import { onSignInPaneRequest } from "@/modules/workspace-shell/services/sign-in-pane";

const api = vi.hoisted(() => ({
  listAccounts: vi.fn(async (): Promise<AccountView[]> => [
    { id: "default", source: "default", dir: "/h/.claude", identity: { email: "me@x.io", org: "Acme" }, inUse: true, loginCommand: "env -u CLAUDE_CONFIG_DIR claude auth login" },
    { id: "work", source: "lotus", dir: "/s/accounts/claude/work", identity: null, inUse: false, loginCommand: "CLAUDE_CONFIG_DIR='/s/accounts/claude/work' claude auth login", context: "shared" },
  ]),
  createAccount: vi.fn(async (name: string) => ({ id: name, source: "lotus", dir: `/s/accounts/claude/${name}`, identity: null, inUse: false, loginCommand: `login ${name}` })),
  removeAccount: vi.fn(async () => {}),
  unhideAccount: vi.fn(async () => {}),
  accountRemovalCheck: vi.fn(async () => ({ running: [] as string[], ownHistory: false })),
  chooseUsageAccount: vi.fn(async () => {}),
  listRemoteAccounts: vi.fn(async (): Promise<{ machine: string; accounts: AccountView[] }> => ({
    machine: "vmi1",
    accounts: [{ id: "default", source: "default", dir: "/home/a/.claude", identity: null, inUse: true, loginCommand: "env -u CLAUDE_CONFIG_DIR claude auth login" }],
  })),
  createRemoteAccount: vi.fn(async (_t: string, name: string) => ({ id: name, source: "lotus", dir: `/v/${name}`, identity: null, inUse: false, loginCommand: `vps login ${name}` })),
  setRemoteDefaultAccount: vi.fn(async () => {}),
  removeRemoteAccount: vi.fn(async () => {}),
  getAntigravityLogin: vi.fn(async (): Promise<{ signedIn: boolean; email: string | null; loginCommand: string } | null> => null),
}));
vi.mock("@/lib/tauri-api", () => api);
vi.mock("../lotus-settings-context", () => ({ useLotusSettings: () => ({ closeSettings: () => {} }) }));

afterEach(() => vi.clearAllMocks());

describe("Subscriptions", () => {
  it("titles each account by who is signed in, marks the default, and keeps the folder in its drawer", async () => {
    render(<Subscriptions />);
    expect(await screen.findByText("me@x.io")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("work")).toBeTruthy();
    expect(screen.getByText("Not signed in")).toBeTruthy();
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.queryByText("/s/accounts/claude/work")).toBeNull();
    // The default for new work is never removed; a Lotus-made account is deleted.
    fireEvent.click(screen.getByRole("button", { name: "More for default" }));
    expect(screen.getByText("/h/.claude")).toBeTruthy();
    expect(screen.getByText(/Claude's own folder/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /(Remove|Delete) default/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More for work" }));
    expect(screen.getByText(/Made in Lotus · shared chats and memory/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete work" })).toBeTruthy();
  });

  it("flags a second folder signed in as the same login, and makes another login the default", async () => {
    api.listAccounts.mockResolvedValue([
      { id: "default", source: "default", dir: "/h/.claude", identity: { email: "a@x.io", org: "Acme" }, inUse: true, loginCommand: "x" },
      { id: "acme", source: "ccs", dir: "/h/.ccs/instances/acme", identity: { email: "a@x.io", org: "Acme" }, inUse: false, loginCommand: "y" },
    ]);
    render(<Subscriptions />);
    expect(await screen.findByText(/Same login as default/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make acme the default" }));
    await waitFor(() => expect(api.chooseUsageAccount).toHaveBeenCalledWith("acme", "claude"));
    api.listAccounts.mockReset();
  });

  it("opens a sign-in pane when the Code shell answers, else shows the command to copy", async () => {
    render(<Subscriptions />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in work" }));
    expect(screen.getByText("CLAUDE_CONFIG_DIR='/s/accounts/claude/work' claude auth login")).toBeTruthy();

    const heard: string[] = [];
    const off = onSignInPaneRequest((command) => (heard.push(command), true));
    fireEvent.click(screen.getByRole("button", { name: "Sign in work" }));
    off();
    expect(heard).toEqual(["CLAUDE_CONFIG_DIR='/s/accounts/claude/work' claude auth login"]);
    // A signed-in row has nothing to sign in; an expired one is re-signed from the popover.
    expect(screen.queryByRole("button", { name: "Sign in default" })).toBeNull();
  });

  it("lists Codex accounts by CODEX_HOME, with no shared-context switch, and calls with provider codex", async () => {
    api.listAccounts.mockResolvedValueOnce([
      { id: "default", source: "default", dir: "/h/.codex", identity: { email: "me@x.io", org: "ChatGPT Plus" }, inUse: true, loginCommand: "env -u CODEX_HOME codex login" },
      { id: "env-x", source: "env", dir: "/x", identity: null, inUse: false, loginCommand: "CODEX_HOME='/x' codex login" },
    ]);
    render(<Subscriptions provider="codex" />);
    expect(await screen.findByText("ChatGPT Plus")).toBeTruthy();
    expect(api.listAccounts).toHaveBeenCalledWith("codex");
    expect(screen.getByText("Codex")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More for default" }));
    expect(screen.getByText("Codex's own folder")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More for env-x" }));
    expect(screen.getByText("From CODEX_HOME")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.change(screen.getByLabelText("New account name"), { target: { value: "work" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with browser" }));
    await waitFor(() => expect(api.createAccount).toHaveBeenCalledWith("work", false, "codex"));
  });

  it("shows Antigravity's one login with no Add, a Sign in only when signed out, and nothing when agy is missing", async () => {
    const { container, unmount } = render(<AntigravityLogin />);
    await waitFor(() => expect(api.getAntigravityLogin).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    unmount();
    api.getAntigravityLogin.mockResolvedValueOnce({ signedIn: true, email: "me@gmail.com", loginCommand: "agy" });
    const signedIn = render(<AntigravityLogin />);
    expect(await screen.findByText("me@gmail.com")).toBeTruthy();
    expect(screen.getByText("One login per Mac")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add|Sign in/ })).toBeNull();
    signedIn.unmount();
    api.getAntigravityLogin.mockResolvedValueOnce({ signedIn: false, email: null, loginCommand: "agy" });
    render(<AntigravityLogin />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in Antigravity" }));
    expect(screen.getByText("agy")).toBeTruthy();
  });

  it("clears an earlier error once the list loads", async () => {
    api.listRemoteAccounts.mockRejectedValueOnce("not connected to alwi@devbox-vps:22 — open a terminal there first");
    const { rerender } = render(<Subscriptions target="alwi@devbox-vps:22" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    rerender(<Subscriptions target="alwi@devbox-vps:2222" />);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("names a machine as the operator does, without user or the default port", async () => {
    render(<Subscriptions target="alwi@devbox-vps:22" />);
    expect(await screen.findByText(/runs on, on devbox-vps\./)).toBeTruthy();
  });

  it("adds an account and asks for its sign-in pane", async () => {
    const heard: string[] = [];
    const off = onSignInPaneRequest((command) => (heard.push(command), true));
    render(<Subscriptions />);
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New account name" }), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with browser" }));
    await waitFor(() => expect(heard).toEqual(["login test"]));
    off();
    expect(api.createAccount).toHaveBeenCalledWith("test", false, "claude");
    expect(await screen.findByText("test")).toBeTruthy();
  });

  it("says which accounts share context, and keeps a new one separate on request", async () => {
    render(<Subscriptions />);
    fireEvent.click(await screen.findByRole("button", { name: "More for work" }));
    expect(screen.getByText(/shared chats and memory/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New account name" }), { target: { value: "client" } });
    fireEvent.click(screen.getByRole("switch", { name: "Keep chats and memory separate" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in with browser" }));
    await waitFor(() => expect(api.createAccount).toHaveBeenCalledWith("client", true, "claude"));
  });

  it("deletes a Lotus account after its confirm", async () => {
    render(<Subscriptions />);
    fireEvent.click(await screen.findByRole("button", { name: "More for work" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete work" }));
    expect(api.removeAccount).not.toHaveBeenCalled();
    expect(screen.getByText(/signs it out/)).toBeTruthy();
    const [first] = await api.listAccounts();
    api.listAccounts.mockResolvedValueOnce([first]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("work")).toBeNull());
    expect(api.removeAccount).toHaveBeenCalledWith("work", false, "claude");
  });

  it("removes a ccs account from Lotus, and deletes its folder only when the box is ticked", async () => {
    api.listAccounts.mockResolvedValue([
      { id: "default", source: "default", dir: "/h/.claude", identity: null, inUse: true, loginCommand: "x" },
      { id: "globex", source: "ccs", dir: "/h/.ccs/instances/globex", identity: { email: "m@x.io", org: null }, inUse: false, loginCommand: "y" },
    ]);
    render(<Subscriptions />);
    fireEvent.click(await screen.findByRole("button", { name: "More for globex" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove globex" }));
    expect(screen.getByText(/files and login stay/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.removeAccount).toHaveBeenCalledWith("globex", false, "claude"));

    fireEvent.click(screen.getByRole("button", { name: "More for globex" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove globex" }));
    fireEvent.click(screen.getByRole("switch", { name: "Also delete its folder and sign out" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.removeAccount).toHaveBeenCalledWith("globex", true, "claude"));
    api.listAccounts.mockReset();
  });

  it("blocks a folder delete while something runs on it, and asks for the name when chats live only there", async () => {
    api.listAccounts.mockResolvedValue([
      { id: "default", source: "default", dir: "/h/.claude", identity: null, inUse: true, loginCommand: "x" },
      { id: "hss", source: "ccs", dir: "/h/.ccs/instances/hss", identity: null, inUse: false, loginCommand: "y" },
    ]);
    api.accountRemovalCheck.mockResolvedValueOnce({ running: ["48770 claude"], ownHistory: true });
    render(<Subscriptions />);
    fireEvent.click(await screen.findByRole("button", { name: "More for hss" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove hss" }));
    fireEvent.click(screen.getByRole("switch", { name: "Also delete its folder and sign out" }));
    // Names what runs, without the PID.
    expect(await screen.findByText(/claude still runs on hss\./)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    // Hiding takes nothing from the running agent, so it stays possible.
    fireEvent.click(screen.getByRole("switch", { name: "Also delete its folder and sign out" }));
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    api.accountRemovalCheck.mockResolvedValueOnce({ running: [], ownHistory: true });
    fireEvent.click(screen.getByRole("button", { name: "Remove hss" }));
    fireEvent.click(screen.getByRole("switch", { name: "Also delete its folder and sign out" }));
    const name = await screen.findByRole("textbox", { name: "Type hss to confirm" });
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: "hss" } });
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false);
    api.listAccounts.mockReset();
  });

  it("lists removed accounts apart, and shows one again", async () => {
    api.listAccounts.mockResolvedValue([
      { id: "default", source: "default", dir: "/h/.claude", identity: null, inUse: true, loginCommand: "x" },
      { id: "globex", source: "ccs", dir: "/h/.ccs/instances/globex", identity: null, inUse: false, loginCommand: "y", hidden: true },
    ]);
    render(<Subscriptions />);
    expect(await screen.findByText("1 removed from Lotus")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More for globex" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    fireEvent.click(screen.getByRole("button", { name: "Show globex again" }));
    await waitFor(() => expect(api.unhideAccount).toHaveBeenCalledWith("globex", "claude"));
    api.listAccounts.mockReset();
  });

  it("manages another machine's accounts through its host, with sign-in panes on that machine", async () => {
    const heard: [string, string | null][] = [];
    const off = onSignInPaneRequest((command, target) => (heard.push([command, target]), true));
    render(<Subscriptions target="devbox-vps" />);
    expect(await screen.findByText(/on devbox-vps\./)).toBeTruthy();
    expect(api.listRemoteAccounts).toHaveBeenCalledWith("devbox-vps");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New account name" }), { target: { value: "ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with browser" }));
    await waitFor(() => expect(heard).toEqual([["vps login ops", "devbox-vps"]]));
    off();
    expect(api.createRemoteAccount).toHaveBeenCalledWith("devbox-vps", "ops", false);
    expect(api.listAccounts).not.toHaveBeenCalled();
  });

  it("makes another machine's login its default through its host", async () => {
    api.listRemoteAccounts.mockResolvedValueOnce({
      machine: "vmi1",
      accounts: [
        { id: "default", source: "default", dir: "/home/a/.claude", identity: { email: "a@x.io", org: null }, inUse: true, loginCommand: "x" },
        { id: "ops", source: "lotus", dir: "/v/ops", identity: { email: "o@x.io", org: null }, inUse: false, loginCommand: "y" },
      ],
    });
    render(<Subscriptions target="devbox-vps" />);
    fireEvent.click(await screen.findByRole("button", { name: "Make ops the default on devbox-vps" }));
    await waitFor(() => expect(api.setRemoteDefaultAccount).toHaveBeenCalledWith("devbox-vps", "ops"));
  });

  it("deletes a Lotus account on another machine through its host", async () => {
    api.listRemoteAccounts.mockResolvedValueOnce({
      machine: "vmi1",
      accounts: [{ id: "ops", source: "lotus", dir: "/v/ops", identity: null, inUse: false, loginCommand: "vps login ops" }],
    });
    render(<Subscriptions target="devbox-vps" />);
    fireEvent.click(await screen.findByRole("button", { name: "More for ops" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete ops" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.removeRemoteAccount).toHaveBeenCalledWith("devbox-vps", "ops"));
    expect(api.removeAccount).not.toHaveBeenCalled();
    // That machine's processes are not visible from here.
    expect(api.accountRemovalCheck).not.toHaveBeenCalled();
  });
});
