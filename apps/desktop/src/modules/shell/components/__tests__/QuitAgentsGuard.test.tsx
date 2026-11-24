import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: () => true,
  tauriInvoke: invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));

import { QuitAgentsGuard } from "../QuitAgentsGuard";

function ask() {
  const cb = listeners.get("lotus://quit-agents-running");
  expect(cb).toBeDefined();
  act(() => cb!({ payload: [{ agent: "claude", cwd: "/w/lotus" }, { agent: "codex", cwd: "/w/acme" }] }));
}

describe("QuitAgentsGuard", () => {
  beforeEach(() => {
    listeners.clear();
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => (cmd === "take_kept_agents" ? 0 : cmd === "take_sessiond_fallback" ? false : undefined));
  });

  it("asks when a quit was stopped, and sends the answer with the remember flag", async () => {
    render(<QuitAgentsGuard />);
    await waitFor(() => expect(listeners.size).toBe(3));
    ask();

    expect(screen.getByText("2 agents are still running")).toBeTruthy();
    expect(screen.getByText("w/acme")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Remember my choice" }));
    fireEvent.click(screen.getByText("Keep running"));

    expect(invoke).toHaveBeenCalledWith("quit_with_agents", { choice: "keep", remember: true });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Escape cancels: Lotus stays open and nothing is remembered", async () => {
    render(<QuitAgentsGuard />);
    await waitFor(() => expect(listeners.size).toBe(3));
    ask();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(invoke).toHaveBeenCalledWith("quit_with_agents", { choice: null, remember: false });
  });

  it("a click outside the dialog cancels; a click inside does not", async () => {
    render(<QuitAgentsGuard />);
    await waitFor(() => expect(listeners.size).toBe(3));
    ask();
    fireEvent.mouseDown(screen.getByRole("alertdialog"));
    expect(invoke).not.toHaveBeenCalledWith("quit_with_agents", expect.anything());
    fireEvent.mouseDown(screen.getByRole("alertdialog").parentElement!);
    expect(invoke).toHaveBeenCalledWith("quit_with_agents", { choice: null, remember: false });
  });

  it("Stop all sends stop", async () => {
    render(<QuitAgentsGuard />);
    await waitFor(() => expect(listeners.size).toBe(3));
    ask();
    fireEvent.click(screen.getByText("Stop all"));
    expect(invoke).toHaveBeenCalledWith("quit_with_agents", { choice: "stop", remember: false });
  });

  it("tells, once, how many kept agents are still running", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "take_kept_agents" ? 2 : undefined));
    render(<QuitAgentsGuard />);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("2 agents are still running"));
  });

  it("warns that in-process agents will stop: Cancel is focused and keeps Lotus open", async () => {
    render(<QuitAgentsGuard />);
    await waitFor(() => expect(listeners.size).toBe(3));
    act(() => listeners.get("lotus://quit-agents-will-stop")!({ payload: [{ agent: "claude", cwd: "/w/lotus" }] }));

    expect(screen.getByText("1 agent will stop")).toBeTruthy();
    expect(screen.getByText("w/lotus")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByText("Cancel"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(invoke).toHaveBeenCalledWith("quit_with_agents", { choice: null, remember: false });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Quit anyway stops them and never saves the choice", async () => {
    render(<QuitAgentsGuard />);
    await waitFor(() => expect(listeners.size).toBe(3));
    act(() => listeners.get("lotus://quit-agents-will-stop")!({ payload: [{ agent: "codex", cwd: "/w/a" }, { agent: "claude", cwd: "/w/b" }] }));
    expect(screen.getByText("2 agents will stop")).toBeTruthy();
    fireEvent.click(screen.getByText("Quit anyway"));
    expect(invoke).toHaveBeenCalledWith("quit_with_agents", { choice: "stop", remember: false });
  });

  it("tells once when the session service is down, also when the connect gives up after mount", async () => {
    let fellBack = false;
    invoke.mockImplementation(async (cmd: string) => (cmd === "take_sessiond_fallback" ? fellBack : cmd === "take_kept_agents" ? 0 : undefined));
    render(<QuitAgentsGuard />);
    await waitFor(() => expect(listeners.size).toBe(3));
    expect(screen.queryByRole("status")).toBeNull();

    fellBack = true;
    act(() => listeners.get("lotus://sessiond-fallback")!({ payload: null }));
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("Agents will stop when Lotus quits");
    expect(toast.textContent).toContain("Session service unavailable");
  });

  it("shows nothing at start when no agent was kept", async () => {
    render(<QuitAgentsGuard />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("take_kept_agents"));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
