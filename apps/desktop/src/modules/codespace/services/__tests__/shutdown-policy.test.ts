import { describe, expect, it, vi } from "vitest";
import {
  createRecentPaneCloseRequestSuppressor,
  formatCloseConfirmation,
  formatTerminalShutdownConfirmation,
  handleTerminalShutdownCloseRequest,
  terminatePtySessions,
} from "@/modules/codespace/services/shutdown-policy";

describe("shutdown-policy", () => {
  it("suppresses exactly one native close request shortly after a pane close shortcut", () => {
    let now = 1000;
    const suppressor = createRecentPaneCloseRequestSuppressor({ now: () => now, windowMs: 500 });

    expect(suppressor.shouldSuppressCloseRequest()).toBe(false);
    suppressor.recordPaneCloseShortcut();
    expect(suppressor.shouldSuppressCloseRequest()).toBe(true);
    expect(suppressor.shouldSuppressCloseRequest()).toBe(false);

    suppressor.recordPaneCloseShortcut();
    now = 1601;
    expect(suppressor.shouldSuppressCloseRequest()).toBe(false);
  });

  it("formats singular and plural confirmation messages", () => {
    expect(formatTerminalShutdownConfirmation(1)).toBe(
      "1 terminal session is still running in this window. Close it and terminate them?",
    );
    expect(formatTerminalShutdownConfirmation(2)).toBe(
      "2 terminal sessions are still running in this window. Close it and terminate them?",
    );
  });

  it("terminates all known PTY sessions", async () => {
    const killSession = vi.fn(() => Promise.resolve());

    await terminatePtySessions([
      { id: "session-1", cwd: "/tmp/a" },
      { id: "session-2", cwd: "/tmp/b" },
    ], killSession);

    expect(killSession).toHaveBeenCalledWith("session-1");
    expect(killSession).toHaveBeenCalledWith("session-2");
  });

  it("allows close immediately when there are no running terminal sessions", async () => {
    const event = { preventDefault: vi.fn() };
    const allowClose = vi.fn();
    const closeWindow = vi.fn(() => Promise.resolve());

    await handleTerminalShutdownCloseRequest(event, {
      listSessions: vi.fn(() => Promise.resolve([])),
      killSession: vi.fn(),
      confirm: vi.fn(),
      closeWindow,
      isCloseAllowed: () => false,
      allowClose,
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(allowClose).toHaveBeenCalledOnce();
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it("suppresses native close requests that came from a pane-level Cmd+W shortcut", async () => {
    const event = { preventDefault: vi.fn() };
    const closeWindow = vi.fn();
    const confirm = vi.fn();

    await handleTerminalShutdownCloseRequest(event, {
      listSessions: vi.fn(() => Promise.resolve([{ id: "session-1", cwd: "/tmp/a" }])),
      killSession: vi.fn(),
      confirm,
      closeWindow,
      isCloseAllowed: () => false,
      allowClose: vi.fn(),
      shouldSuppressCloseRequest: () => true,
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("keeps the app open when user cancels quit with running terminals", async () => {
    const event = { preventDefault: vi.fn() };
    const killSession = vi.fn();
    const closeWindow = vi.fn();

    await handleTerminalShutdownCloseRequest(event, {
      listSessions: vi.fn(() => Promise.resolve([{ id: "session-1", cwd: "/tmp/a" }])),
      killSession,
      confirm: vi.fn(() => Promise.resolve(false)),
      closeWindow,
      isCloseAllowed: () => false,
      allowClose: vi.fn(),
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(killSession).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("terminates running terminals before allowing confirmed quit", async () => {
    const event = { preventDefault: vi.fn() };
    const allowClose = vi.fn();
    const closeWindow = vi.fn(() => Promise.resolve());
    const killSession = vi.fn(() => Promise.resolve());

    await handleTerminalShutdownCloseRequest(event, {
      listSessions: vi.fn(() => Promise.resolve([
        { id: "session-1", cwd: "/tmp/a" },
        { id: "session-2", cwd: "/tmp/b" },
      ])),
      killSession,
      confirm: vi.fn(() => Promise.resolve(true)),
      closeWindow,
      isCloseAllowed: () => false,
      allowClose,
    });

    expect(killSession).toHaveBeenCalledWith("session-1");
    expect(killSession).toHaveBeenCalledWith("session-2");
    expect(allowClose).toHaveBeenCalledOnce();
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it("does not intercept when close has already been allowed", async () => {
    const event = { preventDefault: vi.fn() };

    await handleTerminalShutdownCloseRequest(event, {
      listSessions: vi.fn(),
      killSession: vi.fn(),
      confirm: vi.fn(),
      closeWindow: vi.fn(),
      isCloseAllowed: () => true,
      allowClose: vi.fn(),
    });

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  describe("unsaved editor files", () => {
    const deps = (overrides: Partial<Parameters<typeof handleTerminalShutdownCloseRequest>[1]> = {}) => ({
      listSessions: vi.fn(() => Promise.resolve([])),
      killSession: vi.fn(() => Promise.resolve()),
      confirm: vi.fn(() => Promise.resolve(false)),
      closeWindow: vi.fn(() => Promise.resolve()),
      isCloseAllowed: () => false,
      allowClose: vi.fn(),
      countUnsavedFiles: () => 2,
      ...overrides,
    });

    it("asks before closing a window that holds unsaved files, and stays open on cancel", async () => {
      const d = deps();
      await handleTerminalShutdownCloseRequest({ preventDefault: vi.fn() }, d);

      expect(d.confirm).toHaveBeenCalledWith(
        "2 files have unsaved changes in this window. Close it and lose the changes?",
        { title: "Discard unsaved changes?", kind: "warning" },
      );
      expect(d.allowClose).not.toHaveBeenCalled();
      expect(d.closeWindow).not.toHaveBeenCalled();
    });

    it("closes once the loss is confirmed, dropping the hot-exit copies first", async () => {
      const order: string[] = [];
      const d = deps({
        confirm: vi.fn(() => Promise.resolve(true)),
        discardUnsavedFiles: vi.fn(async () => { order.push("discard"); }),
        allowClose: vi.fn(() => { order.push("allow"); }),
      });
      await handleTerminalShutdownCloseRequest({ preventDefault: vi.fn() }, d);
      expect(d.allowClose).toHaveBeenCalledOnce();
      expect(d.closeWindow).toHaveBeenCalledOnce();
      expect(order).toEqual(["discard", "allow"]);
    });

    it("keeps the copies when the user cancels, and still closes when dropping them fails", async () => {
      const kept = deps({ discardUnsavedFiles: vi.fn(async () => {}) });
      await handleTerminalShutdownCloseRequest({ preventDefault: vi.fn() }, kept);
      expect(kept.discardUnsavedFiles).not.toHaveBeenCalled();

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const failing = deps({
        confirm: vi.fn(() => Promise.resolve(true)),
        discardUnsavedFiles: vi.fn(() => Promise.reject(new Error("disk full"))),
      });
      await handleTerminalShutdownCloseRequest({ preventDefault: vi.fn() }, failing);
      warn.mockRestore();
      expect(failing.closeWindow).toHaveBeenCalledOnce();
    });

    it("still asks when the terminal list cannot be read", async () => {
      const d = deps({ listSessions: vi.fn(() => Promise.reject(new Error("ipc down"))) });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await handleTerminalShutdownCloseRequest({ preventDefault: vi.fn() }, d);
      warn.mockRestore();
      expect(d.confirm).toHaveBeenCalledOnce();
      expect(d.closeWindow).not.toHaveBeenCalled();
    });

    it("asks one question for unsaved files and running terminals together", () => {
      expect(formatCloseConfirmation(1, 1)).toBe(
        "1 file has unsaved changes in this window. 1 terminal session is also still running. Close it and lose the changes?",
      );
      expect(formatCloseConfirmation(2, 0)).toBe(formatTerminalShutdownConfirmation(2));
    });
  });
});
