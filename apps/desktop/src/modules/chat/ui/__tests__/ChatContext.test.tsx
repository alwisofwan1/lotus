import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { emptyThreadState, type ThreadState } from "../../domain/thread-state";
import { ContextPane } from "../ChatContext";

const state: ThreadState = {
  ...emptyThreadState("t"),
  turns: [{ id: "1", input: null, status: "completed", error: null, usage: { inputTokens: 12_400, outputTokens: 800, costUsd: 0.042, durationMs: 3200 }, startedAt: 0, endedAt: 1, items: [] }],
  interactions: [
    { interaction: { kind: "question", id: "q", itemId: null, questions: [{ question: "Which?", header: "Library", options: [], multiSelect: false }] }, turnId: null, requestedAt: 0, resolution: null },
  ] as ThreadState["interactions"],
};

const pane = (over: Partial<React.ComponentProps<typeof ContextPane>> = {}) =>
  render(
    <ContextPane
      state={state}
      cwd="/u/proj"
      branch="main"
      model="opus"
      effort={null}
      login="Claude login"
      permission="Ask first"
      account={{ provider: "claude", account: "acme", plan: null, inUse: true, error: null, windows: [{ kind: "session", group: "session", usedPercent: 85, resetsAtMs: null, windowMinutes: 300 }] }}
      accountName="acme"
      plan={[{ content: "Write tests", activeForm: "Writing tests", status: "active" }]}
      {...over}
    />,
  );

describe("ContextPane", () => {
  it("shows the session, what it cost, the limits, the plan and what waits", () => {
    pane();
    expect(screen.getByText("proj")).toBeTruthy();
    expect(screen.getByText("12k")).toBeTruthy();
    expect(screen.getByText("3.2s")).toBeTruthy();
    expect(screen.getByText("$0.042")).toBeTruthy();
    expect(screen.getByText("API equiv.")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "5-hour used" }).getAttribute("aria-valuenow")).toBe("85");
    expect(screen.getByText("Writing tests")).toBeTruthy();
    expect(screen.getByText("Library")).toBeTruthy();
  });

  it("gauges the context window when the turn reported it", () => {
    const withWindow = { ...state, turns: [{ ...state.turns[0], usage: { ...state.turns[0].usage!, contextTokens: 62_000, contextWindow: 200_000 } }] };
    pane({ state: withWindow });
    expect(screen.getByRole("meter", { name: "Context window used" }).getAttribute("aria-valuenow")).toBe("31");
    expect(screen.getByText("· 62k of 200k")).toBeTruthy();
  });

  it("labels a billed cost and flags a bypass", () => {
    pane({ login: "API key", permission: "Allow everything", model: "claude-opus-5-5" });
    expect(screen.getByText("cost")).toBeTruthy();
    expect(screen.getByText("Opus 5.5")).toBeTruthy();
    expect(screen.getByText("Allow everything").getAttribute("data-tone")).toBe("warn");
    cleanup();
    pane({ model: "gpt-6.1-terra", modelLabel: "GPT-6.1 Terra" });
    expect(screen.getByText("GPT-6.1 Terra")).toBeTruthy();
  });

  it("leaves out what does not apply", () => {
    pane({ state: emptyThreadState("t"), account: null, plan: null, branch: null });
    expect(screen.getByText("Nothing yet: usage shows after the first reply")).toBeTruthy();
    expect(screen.queryByText("Limits")).toBeNull();
    expect(screen.queryByText(/Waiting on you/)).toBeNull();
    expect(screen.queryByText("Context window")).toBeNull();
  });
});
