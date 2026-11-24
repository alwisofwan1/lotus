import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useLiveAgentRunRegistration, type LiveAgentRunInput } from "../useLiveAgentRunRegistration";
import { createAgentRunRegistry } from "../../services/agent-run-registry";

function setup(overrides: Partial<LiveAgentRunInput> = {}) {
  const registry = createAgentRunRegistry();
  const submit = vi.fn();
  const results: Array<{ ok: boolean; outcome?: string }> = [];
  registry.subscribeResults((_id, ok, result) => results.push({ ok, outcome: result?.outcome }));
  const initial: LiveAgentRunInput = {
    id: "atlas", name: "Atlas", submit, fact: undefined, reportsTurnEnd: true, status: "idle", ptyEnded: false, sessionId: "s1", registry, ...overrides,
  };
  const hook = renderHook((props: LiveAgentRunInput) => useLiveAgentRunRegistration(props), { initialProps: initial });
  return { registry, submit, results, hook, initial };
}

describe("useLiveAgentRunRegistration", () => {
  it("types the step into the terminal and reports done on the next idle hook", async () => {
    const { registry, submit, results, hook, initial } = setup({ fact: { paneId: "p", turn: "idle", atMs: 1 } });

    act(() => { registry.run("atlas", { graphRunId: "g", run: { title: "Ship", brief: "Add rate limit" }, upstreamIds: [] }); });
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0]).toContain("Goal: Add rate limit");
    expect(results).toEqual([]); // the idle fact from before the submit does not count

    hook.rerender({ ...initial, status: "running", fact: { paneId: "p", turn: "running", atMs: Date.now() + 1 } });
    expect(results).toEqual([]);
    hook.rerender({ ...initial, status: "idle", fact: { paneId: "p", turn: "idle", atMs: Date.now() + 2 } });
    expect(results).toEqual([{ ok: true, outcome: "completed" }]);

    // A later manual turn never reports to the run again.
    hook.rerender({ ...initial, status: "idle", fact: { paneId: "p", turn: "idle", atMs: Date.now() + 3 } });
    expect(results).toHaveLength(1);
  });

  it("fails the step when there is no goal to type", () => {
    const { registry, submit, results } = setup();
    act(() => { registry.run("atlas", { graphRunId: "g" }); });
    expect(submit).not.toHaveBeenCalled();
    expect(results).toEqual([{ ok: false, outcome: "error" }]);
  });

  it("fails the step when the terminal refuses the message", async () => {
    const { registry, results } = setup({ submit: () => Promise.reject(new Error("PTY gone")) });
    act(() => { registry.run("atlas", { run: { title: "Ship", brief: "Go" } }); });
    await waitFor(() => expect(results).toEqual([{ ok: false, outcome: "error" }]));
  });
});
