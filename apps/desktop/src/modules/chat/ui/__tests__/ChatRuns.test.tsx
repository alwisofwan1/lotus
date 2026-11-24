import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { threadRuns } from "../../domain/runs";
import type { ThreadState } from "../../domain/thread-state";
import { fixPrompt, RunBadge, RunChip, RunLinksContext, RunsPane } from "../ChatRuns";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const failing = [
  "Exit code 1",
  " FAIL  src/LoginForm.test.tsx > LoginForm > shows the error",
  "AssertionError: expected 'Wrong password' to be 'Invalid'",
  " ❯ src/LoginForm.test.tsx:31:7",
  " Tests  1 failed | 18 passed (19)",
].join("\n");
const item = (id: string, command: string, status: "completed" | "failed", output: string) => ({
  item: { id, kind: "command" as const, status, command, description: null, output },
  startedAt: 0,
  endedAt: 0,
});
const runs = threadRuns({
  turns: [{ items: [item("c1", "bun run test", "failed", failing), item("c2", "bun run lint", "completed", "No issues found!")] }],
} as unknown as ThreadState);

describe("RunsPane", () => {
  it("opens the newest failure and hands it back to the composer", () => {
    const onFix = vi.fn();
    render(<RunsPane runs={runs} target={null} agentName="Claude" onFix={onFix} />);
    expect(screen.getByRole("button", { name: /Tests.*18 passed · 1 failed/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Lint.*No problems/ }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Ask Claude to fix" }));
    expect(onFix).toHaveBeenCalledWith(runs.find((r) => r.id === "c1"));
    expect(fixPrompt(runs.find((r) => r.id === "c1")!)).toContain("shows the error");

    fireEvent.click(screen.getByRole("button", { name: /Full output · 4 lines/ }));
    expect(document.querySelector(".chat-run-output")?.textContent).toContain("Tests  1 failed | 18 passed");
  });

  it("folds a failure away once the same command passes", () => {
    const { rerender } = render(<RunsPane runs={runs} target={null} agentName="Claude" onFix={vi.fn()} />);
    const after = threadRuns({
      turns: [{ items: [item("c1", "bun run test", "failed", failing), item("c2", "bun run lint", "completed", "No issues found!"), item("c4", "bun run test", "completed", " Tests  19 passed (19)")] }],
    } as unknown as ThreadState);
    rerender(<RunsPane runs={after} target={null} agentName="Claude" onFix={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Tests.*18 passed · 1 failed/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("· passed in the next run")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask Claude to fix" })).toBeNull();
  });

  it("opens the card a chip points at", () => {
    const { rerender } = render(<RunsPane runs={runs} target={null} agentName="Claude" onFix={vi.fn()} />);
    rerender(<RunsPane runs={runs} target={{ id: "c2", n: 1 }} agentName="Claude" onFix={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Lint.*No problems/ }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("fixPrompt", () => {
  it("names the command, the failing test and its excerpt", () => {
    const text = fixPrompt(runs.find((r) => r.id === "c1")!);
    expect(text).toContain("`bun run test` failed: 18 passed · 1 failed.");
    expect(text).toContain("First failure: shows the error (src/LoginForm.test.tsx:31)");
    expect(text).toContain("AssertionError: expected 'Wrong password' to be 'Invalid'");
    expect(text.endsWith("Fix it, then run `bun run test` again.")).toBe(true);
  });

  it("sends the output's tail when the failure has no excerpt", () => {
    const tail = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const [build] = threadRuns({
      turns: [{ items: [item("b1", "bun run build", "failed", ["Exit code 1", ...tail].join("\n"))] }],
    } as unknown as ThreadState);
    const text = fixPrompt({ ...build, excerpt: [] });
    expect(text).toContain("`bun run build` failed: Failed.");
    expect(text).toContain("line 29");
    expect(text).toContain("line 10");
    expect(text).not.toContain("line 9\n");
  });
});

// A chip's clock: it ignores a click that lands right after it appeared or changed.
let clock = 0;
const at = (ms: number) => vi.spyOn(performance, "now").mockReturnValue((clock = ms));
afterEach(() => vi.restoreAllMocks());

describe("RunChip", () => {
  it("shows a check's result and opens its card; other commands get none", () => {
    const open = vi.fn();
    at(1000);
    render(
      <RunLinksContext.Provider value={open}>
        <RunChip item={item("c1", "bun run test", "failed", failing).item} />
        <RunChip item={item("c3", "ls", "completed", "a").item} />
      </RunLinksContext.Provider>,
    );
    at(clock + 500);
    fireEvent.click(screen.getByRole("button", { name: "18 passed · 1 failed" }));
    expect(open).toHaveBeenCalledWith("c1");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

describe("RunBadge", () => {
  const runOf = (status: "running" | "completed", command = "bun run test", output = " Tests  12 passed (12)") =>
    threadRuns({
      turns: [{ items: [{ item: { id: "b1", kind: "command", status, command, description: null, output }, startedAt: 0, endedAt: 0 }] }],
    } as unknown as ThreadState)[0];

  it("is not a button while the check runs, so a click aimed near it opens nothing", () => {
    render(<RunBadge run={runOf("running")} onOpen={vi.fn()} />);
    expect(screen.getByText("Tests running…")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("ignores a click that lands just after it changed under the pointer", () => {
    const onOpen = vi.fn();
    at(1000);
    const { rerender } = render(<RunBadge run={runOf("completed")} onOpen={onOpen} />);
    at(1500);
    rerender(<RunBadge run={{ ...runOf("completed"), summary: "11 passed" }} onOpen={onOpen} />);
    at(1700);
    fireEvent.click(screen.getByRole("button", { name: "Tests 11 passed" }));
    expect(onOpen).not.toHaveBeenCalled();
    at(1900);
    fireEvent.click(screen.getByRole("button", { name: "Tests 11 passed" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("names a finished build once", () => {
    render(<RunBadge run={runOf("completed", "bun run build", "done")} onOpen={vi.fn()} />);
    expect(screen.getByRole("button").textContent).toBe("Built");
  });
});

describe("RunChip settling", () => {
  it("ignores a click that lands just after the chip appeared", () => {
    const open = vi.fn();
    at(1000);
    render(
      <RunLinksContext.Provider value={open}>
        <RunChip item={item("c1", "bun run test", "failed", failing).item} />
      </RunLinksContext.Provider>,
    );
    at(1100);
    fireEvent.click(screen.getByRole("button", { name: "18 passed · 1 failed" }));
    expect(open).not.toHaveBeenCalled();
  });
});
