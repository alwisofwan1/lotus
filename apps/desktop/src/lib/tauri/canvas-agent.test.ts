import { describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class { onmessage?: (line: string) => void; } }));
import { createTauriAgentRunner } from "./canvas-agent";

describe("headless agent native stop receipt", () => {
  it("waits for run completion after a cancellation accepted before native registration", async () => {
    let endRun!: () => void;
    const completion = new Promise<void>((resolve) => { endRun = resolve; });
    invoke.mockImplementation((command: string) => command === "agent_cli_run" ? completion : Promise.resolve(false));
    const runner = createTauriAgentRunner();
    const runId = await runner.start({ prompt: "test", model: "", cwd: "/tmp", onLine: vi.fn() });
    let stopped = false;
    const stopping = runner.stop(runId).then(() => { stopped = true; });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("agent_cli_cancel", { runId }));
    await Promise.resolve();
    expect(stopped).toBe(false);
    endRun();
    await stopping;
    expect(stopped).toBe(true);
  });
});
