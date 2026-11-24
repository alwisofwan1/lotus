import { afterEach, describe, expect, it, vi } from "vitest";

const taps = new Map<string, (data: string) => void>();
let transcript = "";
vi.mock("@/modules/codespace/services/terminal-session-registry", () => ({
  getTerminalRuntimeSessionId: () => null,
  subscribeTerminalSessionStatus: () => () => {},
  peekTerminalTranscript: () => transcript,
  tapTerminalOutput: (paneId: string, listener: (data: string) => void) => {
    taps.set(paneId, listener);
    return () => taps.delete(paneId);
  },
}));
vi.mock("@/lib/tauri-api", () => ({ getPtySessionMetrics: vi.fn(), killPtySession: vi.fn(), writeToSession: vi.fn() }));

const { createTaskSpawner } = await import("../task-spawner");
const { awaitTerminalHandover } = await import("@/modules/codespace/services/terminal-handover");

afterEach(() => {
  taps.clear();
  transcript = "";
});

describe("awaitTerminalHandover", () => {
  it("opens when the program arms bracketed paste, and stops listening", async () => {
    const waiting = awaitTerminalHandover("p1", { timeoutMs: 2_000 });
    taps.get("p1")?.("Claude Code v2 booting…");
    taps.get("p1")?.("\u001b[?2004h");
    await expect(waiting).resolves.toBe(true);
    expect(taps.has("p1")).toBe(false);
  });

  it("opens at once when the marker already went by", async () => {
    transcript = "banner\u001b[?1049h";
    await expect(awaitTerminalHandover("p2", { timeoutMs: 2_000 })).resolves.toBe(true);
  });

  it("reports false at the timeout", async () => {
    await expect(awaitTerminalHandover("p3", { timeoutMs: 1 })).resolves.toBe(false);
  });
});

describe("createTaskSpawner", () => {
  it("waits for the handover only for a spawner whose panes launch the agent directly", () => {
    expect(createTaskSpawner(() => "p", vi.fn()).awaitHandover).toBeUndefined();
    expect(createTaskSpawner(() => "p", vi.fn(), undefined, { launchesAgentDirectly: true }).awaitHandover).toBeDefined();
  });

  it("passes an async pane id through, and refuses a missing one", async () => {
    await expect(createTaskSpawner(async () => "p9", vi.fn()).addPane("w", "claude")).resolves.toBe("p9");
    await expect(createTaskSpawner(async () => null, vi.fn()).addPane("w", "claude")).rejects.toThrow("No workspace is open");
    expect(() => createTaskSpawner(() => null, vi.fn()).addPane("w", "claude")).toThrow("No workspace is open");
  });
});
