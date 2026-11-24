import { describe, it, expect, vi } from "vitest";
import { createAgentRunRegistry } from "../agent-run-registry";

describe("agent run registry", () => {
  it("invokes a registered node's run handle and reports dispatch success", () => {
    const reg = createAgentRunRegistry();
    const run = vi.fn();
    reg.register("a", { run });
    expect(reg.run("a")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports dispatch failure for an unregistered node", () => {
    const reg = createAgentRunRegistry();
    expect(reg.has("ghost")).toBe(false);
    expect(reg.run("ghost")).toBe(false);
  });

  it("notifies subscribers of a reported result", () => {
    const reg = createAgentRunRegistry();
    const seen: Array<[string, boolean]> = [];
    reg.subscribeResults((id, ok) => seen.push([id, ok]));
    reg.reportResult("a", true);
    expect(seen).toEqual([["a", true]]);
  });

  it("threads the run context to the node's handle", () => {
    const reg = createAgentRunRegistry();
    const run = vi.fn();
    reg.register("a", { run });
    reg.run("a", { graphRunId: "g1" });
    expect(run).toHaveBeenCalledWith({ graphRunId: "g1" });
  });

  it("forwards a per-node result alongside the ok flag", () => {
    const reg = createAgentRunRegistry();
    const seen: unknown[] = [];
    reg.subscribeResults((id, ok, result) => seen.push([id, ok, result]));
    reg.reportResult("a", true, { outcome: "completed", sessionId: "s", nodeRunId: "r1" });
    expect(seen).toEqual([["a", true, { outcome: "completed", sessionId: "s", nodeRunId: "r1" }]]);
  });

  it("stops delivering after unregister / unsubscribe", () => {
    const reg = createAgentRunRegistry();
    const run = vi.fn();
    const off = reg.register("a", { run });
    off();
    reg.run("a");
    expect(run).not.toHaveBeenCalled();
  });
});
