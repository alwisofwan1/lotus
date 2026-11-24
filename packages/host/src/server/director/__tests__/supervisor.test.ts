import { describe, it, expect, vi } from "vitest";
import { DirectorSupervisor, type DirectorSessionStore } from "../supervisor.js";
import type { DirectorRunner, DirectorInvokeRequest, DirectorInvokeResult } from "../director-runner.js";

function memoryStore(initial: string | null = null): DirectorSessionStore {
  let id = initial;
  return { load: () => id, save: (v) => { id = v; } };
}

function recordingRunner(impl?: (req: DirectorInvokeRequest) => Promise<DirectorInvokeResult>): {
  runner: DirectorRunner; calls: DirectorInvokeRequest[];
} {
  const calls: DirectorInvokeRequest[] = [];
  const runner: DirectorRunner = {
    provider: "claude",
    invoke: vi.fn(async (req) => {
      calls.push(req);
      return impl ? impl(req) : { sessionId: "srv-sess", text: "ok", isError: false };
    }),
  };
  return { runner, calls };
}

function makeSupervisor(runner: DirectorRunner, store: DirectorSessionStore, onReply?: (r: DirectorInvokeResult) => void) {
  let n = 0;
  return new DirectorSupervisor({ runner, cwd: "/w", sessionStore: store, newSessionId: () => `uuid-${++n}`, ...(onReply ? { onReply } : {}) });
}

describe("DirectorSupervisor", () => {
  it("starts a fresh session on the first event and persists the resulting id", async () => {
    const { runner, calls } = recordingRunner();
    const store = memoryStore();
    const sup = makeSupervisor(runner, store);
    await sup.handleEvent("goal: ship");
    expect(calls[0]).toMatchObject({ event: "goal: ship", sessionId: "uuid-1", resume: false, cwd: "/w" });
    expect(store.load()).toBe("srv-sess"); // persisted the id returned by the runner
  });

  it("resumes the persisted session on subsequent events", async () => {
    const { runner, calls } = recordingRunner();
    const sup = makeSupervisor(runner, memoryStore());
    await sup.handleEvent("e1");
    await sup.handleEvent("e2");
    expect(calls[1]).toMatchObject({ event: "e2", sessionId: "srv-sess", resume: true });
  });

  it("resumes an existing session across a restart (loaded from the store)", async () => {
    const { runner, calls } = recordingRunner();
    const sup = makeSupervisor(runner, memoryStore("prior-session"));
    await sup.handleEvent("e1");
    expect(calls[0]).toMatchObject({ sessionId: "prior-session", resume: true });
  });

  it("serializes concurrent events — the Director session is single-threaded", async () => {
    const order: string[] = [];
    const { runner } = recordingRunner(async (req) => {
      order.push(`start:${req.event}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${req.event}`);
      return { sessionId: "s", text: "", isError: false };
    });
    const sup = makeSupervisor(runner, memoryStore());
    await Promise.all([sup.handleEvent("a"), sup.handleEvent("b")]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("surfaces the Director reply via onReply", async () => {
    const onReply = vi.fn();
    const { runner } = recordingRunner(async () => ({ sessionId: "s", text: "done", isError: false }));
    await makeSupervisor(runner, memoryStore(), onReply).handleEvent("e");
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ text: "done" }));
  });

  it("surfaces an infra failure as an error reply instead of rejecting (fire-and-forget safe)", async () => {
    const onReply = vi.fn();
    const runner: DirectorRunner = {
      provider: "claude",
      invoke: vi.fn(async () => { throw new Error("binary not found on PATH"); }),
    };
    const store = memoryStore();
    const result = await makeSupervisor(runner, store, onReply).handleEvent("goal");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("binary not found");
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ isError: true }));
    expect(store.load()).toBeNull(); // failed first turn leaves no session to resume
  });

  it("pokeWorkerIdle sends a worker-idle event to the Director", async () => {
    const { runner, calls } = recordingRunner();
    const sup = makeSupervisor(runner, memoryStore());
    await sup.handleEvent("goal");
    await sup.pokeWorkerIdle();
    expect(calls[1]!.event.toLowerCase()).toContain("worker");
    expect(calls[1]!.resume).toBe(true);
  });
});
