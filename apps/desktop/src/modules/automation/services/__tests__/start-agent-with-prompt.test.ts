import { describe, expect, it, vi } from "vitest";

import { startAgentWithPrompt, type AgentPaneDeps } from "../start-agent-with-prompt";

function deps(overrides: Partial<AgentPaneDeps> = {}): AgentPaneDeps & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    addPane: vi.fn(() => "pane-1"),
    awaitSessionId: vi.fn(async () => "sess-1"),
    waitReady: vi.fn(async () => ({ reason: "agent" as const })),
    write: vi.fn(async (_id: string, data: string) => {
      writes.push(data);
    }),
    settle: vi.fn(async () => undefined),
    // Default: the agent reacts to the first return at once.
    idleMs: vi.fn(async () => 0),
    pause: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("startAgentWithPrompt", () => {
  it("opens a claude pane in the workspace and types the prompt, then presses return on its own", async () => {
    const d = deps();
    const error = await startAgentWithPrompt("ws-1", "Make me an automation\n", d);

    expect(error).toBeNull();
    expect(d.addPane).toHaveBeenCalledWith("ws-1", "claude");
    expect(d.awaitSessionId).toHaveBeenCalledWith("pane-1");
    expect(d.writes).toEqual(["Make me an automation", "\r"]);
  });

  it("needs a workspace", async () => {
    const d = deps();
    expect(await startAgentWithPrompt(null, "x", d)).toMatch(/Open a workspace/);
    expect(d.addPane).not.toHaveBeenCalled();
  });

  it("reports a pane that could not open", async () => {
    const d = deps({ addPane: vi.fn(() => null) });
    expect(await startAgentWithPrompt("ws-1", "x", d)).toMatch(/could not open/);
  });

  it("reports a session that never came up, and types nothing", async () => {
    const d = deps({ awaitSessionId: vi.fn(async () => null) });
    expect(await startAgentWithPrompt("ws-1", "x", d)).toMatch(/did not start/);
    expect(d.writes).toEqual([]);
  });

  it("reports a session that ended before it was ready", async () => {
    const d = deps({ waitReady: vi.fn(async () => ({ reason: "gone" as const })) });
    expect(await startAgentWithPrompt("ws-1", "x", d)).toMatch(/closed/);
    expect(d.writes).toEqual([]);
  });

  it("presses return again when the agent did not react to the first one", async () => {
    // Seen live 2026-09-25: a fresh claude showed the prompt in its box but never ran it; one more
    // return from the user started it. So: no output after the return → press it again.
    let checks = 0;
    const d = deps({ idleMs: vi.fn(async () => (++checks <= 1 ? 60_000 : 0)) });
    expect(await startAgentWithPrompt("ws-1", "x", d)).toBeNull();
    expect(d.writes).toEqual(["x", "\r", "\r"]);
  });

  it("gives up after two extra returns and says what to do", async () => {
    const d = deps({ idleMs: vi.fn(async () => 60_000) });
    expect(await startAgentWithPrompt("ws-1", "x", d)).toMatch(/press Enter/);
    expect(d.writes).toEqual(["x", "\r", "\r", "\r"]);
  });
});
