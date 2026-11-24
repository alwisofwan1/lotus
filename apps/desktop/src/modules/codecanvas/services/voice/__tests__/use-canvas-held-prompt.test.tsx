import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { AgentStatusRegistry } from "../../agent-status-registry";
import { canvasHeldPromptBusyReason, canvasHeldPromptUnreachableReason, useCanvasHeldPrompt } from "../use-canvas-held-prompt";

const ROWAN = { id: "a1", type: "agent", data: { name: "Rowan" }, position: { x: 0, y: 0 } } as Node;
const MIRA = { id: "a2", type: "agent", data: { name: "Mira" }, position: { x: 0, y: 0 } } as Node;
const registry = { list: () => [], subscribe: () => () => {} } as unknown as AgentStatusRegistry;

function renderHeld(writeAgentPrompt = vi.fn<(id: string, data: string) => boolean>(() => true)) {
  const hook = renderHook(() => useCanvasHeldPrompt({ nodes: [ROWAN, MIRA], writeAgentPrompt, registry }));
  return { ...hook, writeAgentPrompt };
}

describe("useCanvasHeldPrompt", () => {
  it("puts line breaks in the agent's prompt as spaces, so nothing submits it", () => {
    const { result, writeAgentPrompt } = renderHeld();
    act(() => void result.current.place("a1", "Rowan", "fix the login\nthen add tests"));
    expect(writeAgentPrompt).toHaveBeenCalledWith("a1", "fix the login then add tests");
    expect(result.current.held).toMatchObject({ agentId: "a1", text: "fix the login then add tests" });
  });

  it("adds a second turn to the same agent after a space, in one write", () => {
    const { result, writeAgentPrompt } = renderHeld();
    act(() => void result.current.place("a1", "Rowan", "fix the login"));
    act(() => void result.current.place("a1", "Rowan", "then add tests"));
    expect(writeAgentPrompt).toHaveBeenLastCalledWith("a1", " then add tests");
    expect(result.current.held?.text).toBe("fix the login then add tests");
  });

  it("refuses a second agent while one already holds a Held Prompt", () => {
    const { result } = renderHeld();
    act(() => void result.current.place("a1", "Rowan", "fix the login"));
    let outcome;
    act(() => void (outcome = result.current.place("a2", "Mira", "write docs")));
    expect(outcome).toEqual({ ok: false, reason: canvasHeldPromptBusyReason("Rowan") });
  });

  it("refuses, with no reason, when the prompt cannot take text now", () => {
    const { result } = renderHeld(vi.fn(() => false));
    let outcome;
    act(() => void (outcome = result.current.place("a1", "Rowan", "fix the login")));
    expect(outcome).toEqual({ ok: false });
    expect(result.current.held).toBeNull();
  });

  it("keeps it when Enter cannot reach the prompt, so Enter can try again", () => {
    const write = vi.fn<(id: string, data: string) => boolean>(() => true);
    const { result } = renderHeld(write);
    act(() => void result.current.place("a1", "Rowan", "fix the login"));
    write.mockReturnValue(false);
    let outcome;
    act(() => void (outcome = result.current.send()));
    expect(outcome).toEqual({ ok: false, reason: canvasHeldPromptUnreachableReason("Rowan") });
    expect(result.current.held).not.toBeNull();
  });

  it("joins a typed message for the same agent after a space, and lets go of it", () => {
    const { result, writeAgentPrompt } = renderHeld();
    act(() => void result.current.place("a1", "Rowan", "fix the login"));
    expect(result.current.join("a2")).toBeNull();
    let joined;
    act(() => void (joined = result.current.join("a1")));
    expect(joined).toBe("Rowan");
    expect(writeAgentPrompt).toHaveBeenLastCalledWith("a1", " ");
    expect(result.current.held).toBeNull();
  });
});
