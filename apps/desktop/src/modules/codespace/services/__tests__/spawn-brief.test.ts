import { afterEach, describe, expect, it, vi } from "vitest";

const taps = new Map<string, (data: string) => void>();
const statusSubscribers = new Map<string, (status: string) => void>();
const writes: string[] = [];
let status = "live";
vi.mock("@/modules/codespace/services/terminal-session-registry", () => ({
  getTerminalRuntimeSessionId: () => null,
  getTerminalSessionStatus: () => status,
  peekTerminalTranscript: () => "",
  tapTerminalOutput: (paneId: string, listener: (data: string) => void) => {
    taps.set(paneId, listener);
    return () => taps.delete(paneId);
  },
  subscribeTerminalSessionStatus: (paneId: string, subscriber: (status: string) => void) => {
    statusSubscribers.set(paneId, subscriber);
    return () => statusSubscribers.delete(paneId);
  },
  writeTerminalSession: (_paneId: string, data: string) => writes.push(data),
}));

const { deliverInitialPrompt } = await import("../spawn-brief");

const fast = { sleep: async () => {} };
const output = (paneId: string, data: string) => taps.get(paneId)?.(data);

afterEach(() => {
  taps.clear();
  statusSubscribers.clear();
  writes.length = 0;
  status = "live";
  vi.restoreAllMocks();
});

describe("deliverInitialPrompt", () => {
  it("waits for the agent's handover, then types the text and presses Enter separately", async () => {
    const delivering = deliverInitialPrompt("p1", "Read BRIEF.md\n", { behindShell: false, keystrokes: fast });
    await Promise.resolve();
    expect(writes).toEqual([]);
    output("p1", "SessionStart hooks…\x1b[?2004h");
    await expect(delivering).resolves.toBe("submitted");
    expect(writes[0]).toBe("Read BRIEF.md");
    expect(writes.slice(1)).toEqual(["\r", "\r", "\r"]);
    expect(taps.has("p1")).toBe(false);
    expect(statusSubscribers.has("p1")).toBe(false);
  });

  it("behind a shell, never types at the shell's own prompt", async () => {
    const delivering = deliverInitialPrompt("p2", "brief", { behindShell: true, keystrokes: fast });
    output("p2", "\x1b[?2004h");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(writes).toEqual([]);
    output("p2", "claude\x1b[?2004l\r\n");
    output("p2", "\x1b[?2004h");
    await expect(delivering).resolves.toBe("submitted");
    expect(writes).toEqual(["brief", "\r", "\r", "\r"]);
  });

  it("with no handover, leaves the text typed but unsent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(deliverInitialPrompt("p3", "brief", { behindShell: true, handoverMs: 1 })).resolves.toBe("typed");
    expect(writes).toEqual(["brief"]);
  });

  it("writes nothing to a pane that closed while it waited", async () => {
    const delivering = deliverInitialPrompt("p4", "brief", { behindShell: false, keystrokes: fast });
    status = "exited";
    statusSubscribers.get("p4")?.("exited");
    await expect(delivering).resolves.toBe("gone");
    expect(writes).toEqual([]);
  });

  it("stops typing when the pane closes between the text and Enter", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const delivering = deliverInitialPrompt("p5", "brief", {
      behindShell: false,
      keystrokes: {
        sleep: async () => {
          if (writes.length) status = "exited";
        },
      },
    });
    output("p5", "\x1b[?1049h");
    await expect(delivering).resolves.toBe("gone");
    expect(writes).toEqual(["brief"]);
  });
});
