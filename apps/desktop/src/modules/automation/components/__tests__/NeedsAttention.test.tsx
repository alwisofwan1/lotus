import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Automation, AutomationClient, AutomationRun } from "../../services/automation-api";
import { NeedsAttention } from "../NeedsAttention";

const automation = { id: "a1", name: "Daily report", enabled: true, actionKind: "agent_prompt" } as unknown as Automation;
const run = (failure: AutomationRun["failure"]) =>
  ({ id: "r1", automationId: "a1", status: "failed", createdAtMs: Date.now(), detail: "raw error", failure, advice: "Do the fix." }) as AutomationRun;

describe("NeedsAttention", () => {
  it("offers the one fix for the failure, the raw error behind Details", () => {
    const onOpen = vi.fn();
    render(<NeedsAttention items={[{ automation, run: run("agent_missing") }]} client={{} as AutomationClient} onOpenAutomation={onOpen} />);
    expect(screen.getByText("Do the fix.")).toBeTruthy();
    expect(screen.queryByText("raw error")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("raw error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose another agent" }));
    expect(onOpen).toHaveBeenCalledWith("a1");
  });

  it("runs a prompt automation again for an unknown failure", () => {
    const runScheduledNow = vi.fn(async () => ({ status: "started" as const, runId: "r2" }));
    render(<NeedsAttention items={[{ automation, run: run("other") }]} client={{ runScheduledNow } as unknown as AutomationClient} />);
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(runScheduledNow).toHaveBeenCalledWith("a1");
  });
});
