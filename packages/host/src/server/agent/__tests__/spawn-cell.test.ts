import { describe, it, expect, vi } from "vitest";
import { spawnCell } from "../spawn-cell.js";
import { ProviderUnavailableError } from "../errors.js";
import type { PtyManager } from "../../pty/manager.js";
import type { AgentRunner } from "../types.js";
import type { PtySessionState } from "../../pty/types.js";

function makePty(state: PtySessionState): PtyManager {
  return { create: vi.fn(() => state), kill: vi.fn() } as unknown as PtyManager;
}
function makeRunner(spawnImpl: AgentRunner["spawnPty"]): AgentRunner {
  return { providerId: "claude", chat: vi.fn(), spawnPty: vi.fn(spawnImpl) };
}
const STATE: PtySessionState = { id: "pty-1", cwd: "/w", cols: 80, rows: 24, createdAt: 0, status: "running" };

describe("spawnCell", () => {
  it("creates the PTY then asks the runner to spawn into it, returning the state", async () => {
    const pty = makePty(STATE);
    const runner = makeRunner(async () => undefined);
    const state = await spawnCell(pty, runner, { cwd: "/w", provider: "claude" }, { cwd: "/w", provider: "claude" });
    expect(state.id).toBe("pty-1");
    expect(pty.create).toHaveBeenCalledWith({ cwd: "/w", provider: "claude" });
    expect(runner.spawnPty).toHaveBeenCalledWith({ cwd: "/w", provider: "claude" }, "pty-1");
  });

  it("kills the orphaned session and rethrows when the runner fails to spawn", async () => {
    const pty = makePty(STATE);
    const runner = makeRunner(async () => { throw new ProviderUnavailableError("claude", "boom"); });
    await expect(
      spawnCell(pty, runner, { cwd: "/w", provider: "claude" }, { cwd: "/w", provider: "claude" }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(pty.kill).toHaveBeenCalledWith("pty-1");
  });
});
