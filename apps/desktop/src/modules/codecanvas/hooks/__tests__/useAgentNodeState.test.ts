import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentNodeState } from "../useAgentNodeState";
import { stopHeadlessAgent } from "../../services/headless-agent-sessions";
import type { AgentRunner, AgentStartOptions } from "@/lib/tauri/canvas-agent";

/** Fake runner that captures the onLine sink so a test can drive the stream by hand. */
function fakeRunner() {
  let sink: ((line: string) => void) | null = null;
  const sinks: Array<(line: string) => void> = [];
  const calls: AgentStartOptions[] = [];
  const runner: AgentRunner = {
    async start(opts: AgentStartOptions) {
      sink = opts.onLine;
      sinks.push(opts.onLine);
      calls.push(opts);
      return `run-${calls.length}`;
    },
    async stop() {},
  };
  return {
    runner,
    calls,
    emit: (line: string) => sink?.(line),
    emitAt: (index: number, line: string) => sinks[index]?.(line),
  };
}

const base = { prompt: "do it", model: "claude-sonnet-4-6", cwd: "/repo" };

describe("useAgentNodeState", () => {
  it("a headless run remains stoppable after its board unmounts", async () => {
    const { runner } = fakeRunner();
    const stop = vi.spyOn(runner, "stop");
    const { result, unmount } = renderHook(() => useAgentNodeState({ ...base, runner, runtimePaneId: "canvas:p:detached" }));
    await act(async () => { await result.current.start(); });
    unmount();
    await act(async () => { await stopHeadlessAgent("canvas:p:detached"); });
    expect(stop).toHaveBeenCalledExactlyOnceWith("run-1");
  });
  it("stop during startup cancels the late-arriving run id", async () => {
    let spawned!: (id: string) => void;
    const runner: AgentRunner = {
      start: vi.fn(() => new Promise<string>((resolve) => { spawned = resolve; })),
      stop: vi.fn(async () => {}),
    };
    const { result } = renderHook(() => useAgentNodeState({ ...base, runner }));
    let starting!: Promise<void>;
    act(() => { starting = result.current.start(); });
    await act(async () => { await Promise.resolve(); });
    let stopping!: Promise<void>;
    act(() => { stopping = result.current.stop(); });
    await act(async () => { spawned("late-run"); await Promise.all([starting, stopping]); });
    expect(runner.stop).toHaveBeenCalledExactlyOnceWith("late-run");
    expect(result.current.status).toBe("idle");
  });
  it("goes connecting on start, then running on the first stream event", async () => {
    const { runner, emit } = fakeRunner();
    const { result } = renderHook(() => useAgentNodeState({ ...base, runner }));

    expect(result.current.status).toBe("idle");
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe("connecting");

    act(() => emit(JSON.stringify({ type: "system", session_id: "s1" })));
    expect(result.current.status).toBe("running");
  });

  it("surfaces the session id once the stream reports one", async () => {
    const { runner, emit } = fakeRunner();
    const { result } = renderHook(() => useAgentNodeState({ ...base, runner }));
    expect(result.current.sessionId).toBeNull();
    await act(async () => {
      await result.current.start();
    });
    act(() => emit(JSON.stringify({ type: "system", session_id: "sess-42" })));
    expect(result.current.sessionId).toBe("sess-42");
  });

  it("folds text and tool activity into distinct, ordered view entries", async () => {
    const { runner, emit } = fakeRunner();
    const { result } = renderHook(() => useAgentNodeState({ ...base, runner }));
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      emit(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Planning" }] } }));
      emit(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] } }));
    });
    expect(result.current.view.entries).toEqual([
      { kind: "message", text: "Planning" },
      { kind: "tool", label: "Reading a.ts" },
    ]);
  });

  it("reaches completed on a successful result", async () => {
    const { runner, emit } = fakeRunner();
    const { result } = renderHook(() => useAgentNodeState({ ...base, runner }));
    await act(async () => {
      await result.current.start();
    });
    act(() => emit(JSON.stringify({ type: "result", is_error: false, result: "ok" })));
    expect(result.current.status).toBe("completed");
  });

  it("returns to idle after stop while running", async () => {
    const { runner, emit } = fakeRunner();
    const { result } = renderHook(() => useAgentNodeState({ ...base, runner }));
    await act(async () => {
      await result.current.start();
    });
    act(() => emit(JSON.stringify({ type: "system", session_id: "s1" })));
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.status).toBe("idle");
  });

  it("ignores stale completion events from an older run after re-run starts", async () => {
    const { runner, emit, emitAt } = fakeRunner();
    const { result } = renderHook(() => useAgentNodeState({ ...base, runner }));

    await act(async () => { await result.current.start(); });
    act(() => {
      emit(JSON.stringify({ type: "system", session_id: "old-session" }));
      emit(JSON.stringify({ type: "result", is_error: false, result: "old done" }));
    });
    expect(result.current.status).toBe("completed");

    await act(async () => { await result.current.start(); });
    expect(result.current.status).toBe("connecting");

    act(() => {
      emitAt(0, JSON.stringify({ type: "_final", exitCode: 0 }));
      emit(JSON.stringify({ type: "system", session_id: "new-session" }));
      emitAt(0, JSON.stringify({ type: "result", is_error: false, result: "late old result" }));
    });

    expect(result.current.status).toBe("running");
    expect(result.current.sessionId).toBe("new-session");
  });

  it("resumes the session on reply and keeps prior output", async () => {
    const { runner, calls, emit } = fakeRunner();
    const { result } = renderHook(() => useAgentNodeState({ ...base, runner }));
    await act(async () => { await result.current.start(); });
    act(() => {
      emit(JSON.stringify({ type: "system", session_id: "sess-9" }));
      emit(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done part 1" }] } }));
      emit(JSON.stringify({ type: "result", is_error: false }));
    });
    expect(result.current.status).toBe("completed");
    expect(result.current.canReply).toBe(true);

    await act(async () => { await result.current.sendReply("now do part 2"); });
    expect(calls[1]).toMatchObject({ prompt: "now do part 2", resumeSessionId: "sess-9" });
    expect(result.current.status).toBe("connecting");
    // Prior output preserved across the resume.
    expect(result.current.view.entries).toContainEqual({ kind: "message", text: "Done part 1" });
  });

  it("assembles the run prompt with the headless contract, connected context, and role", async () => {
    const { runner, calls } = fakeRunner();
    const { result } = renderHook(() => useAgentNodeState({
      ...base, runner,
      appliedSkills: ["tdd"],
      getContext: () => [{ type: "note", content: "SHARED CTX" }],
    }));
    await act(async () => { await result.current.start(); });
    expect(calls[0].prompt).toContain("headless agent"); // operating contract injected
    expect(calls[0].prompt).toContain("SHARED CTX"); // connected note context
    expect(calls[0].prompt).toContain("tdd"); // applied skill
    expect(calls[0].prompt).toContain("do it"); // role prompt
  });

  it("awaits async image attachment resolution before starting the run", async () => {
    const { runner, calls } = fakeRunner();
    const { result } = renderHook(() => useAgentNodeState({
      ...base,
      runner,
      getAttachments: async () => [{ kind: "bytes", name: "asset.png", mime: "image/png", base64: "QUJD" }],
    }));
    await act(async () => { await result.current.start(); });
    expect(calls[0].imageAttachments).toEqual([{ name: "asset.png", content: "data:image/png;base64,QUJD", mimeType: "image/png" }]);
  });

  it("applies governance (effort + permission mode) to the run", async () => {
    const { runner, calls } = fakeRunner();
    const { result } = renderHook(() => useAgentNodeState({ ...base, runner, effort: "high", skipPermissions: false }));
    await act(async () => { await result.current.start(); });
    expect(calls[0]).toMatchObject({ effort: "high", skipPermissions: false });
  });

  it("emits a run record on completion with captured actions", async () => {
    const { runner, emit } = fakeRunner();
    const records: import("../../services/agent-run-record").AgentRunRecord[] = [];
    const { result } = renderHook(() => useAgentNodeState({ ...base, runner, agentId: "node-1", onRunComplete: (r) => records.push(r) }));
    await act(async () => { await result.current.start(); });
    act(() => {
      emit(JSON.stringify({ type: "system", session_id: "s1" }));
      emit(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] } }));
      emit(JSON.stringify({ type: "result", is_error: false }));
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ agentId: "node-1", kind: "run", outcome: "completed", sessionId: "s1" });
    expect(records[0].actions).toContain("Reading a.ts");
  });

  it("records a stopped run when stopped mid-flight", async () => {
    const { runner, emit } = fakeRunner();
    const records: import("../../services/agent-run-record").AgentRunRecord[] = [];
    const { result } = renderHook(() => useAgentNodeState({ ...base, runner, agentId: "n2", onRunComplete: (r) => records.push(r) }));
    await act(async () => { await result.current.start(); });
    act(() => emit(JSON.stringify({ type: "system", session_id: "s2" })));
    await act(async () => { await result.current.stop(); });
    expect(records.at(-1)).toMatchObject({ outcome: "stopped" });
  });

  it("cannot reply before a session exists", async () => {
    const { runner, calls } = fakeRunner();
    const { result } = renderHook(() => useAgentNodeState({ ...base, runner }));
    expect(result.current.canReply).toBe(false);
    await act(async () => { await result.current.sendReply("hello"); });
    expect(calls).toHaveLength(0);
  });
});
