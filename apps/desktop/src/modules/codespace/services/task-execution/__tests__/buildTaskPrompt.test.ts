import { describe, it, expect } from "vitest";
import { buildTaskPrompt, KNOWLEDGE_PROMPT_CAP_BYTES } from "../buildTaskPrompt";
import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";

const baseTask: BridgeTask = {
  id: "task_1",
  workspaceId: "ws_1",
  title: "Implement auth flow",
  goal: "Wire OAuth to session store, log failures.",
  knowledge: "Use stytch SDK. Token TTL = 12h.",
  status: "todo",
  priority: "medium",
  assignees: ["@claude"],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe("buildTaskPrompt", () => {
  it("includes task title and goal as labeled sections", () => {
    const out = buildTaskPrompt(baseTask);
    expect(out).toContain("Task: Implement auth flow");
    expect(out).toContain("Goal:");
    expect(out).toContain("Wire OAuth to session store, log failures.");
  });

  it("includes the knowledge body when present", () => {
    const out = buildTaskPrompt(baseTask);
    expect(out).toContain("Context:");
    expect(out).toContain("Use stytch SDK. Token TTL = 12h.");
  });

  it("omits the Context section when knowledge is empty", () => {
    const out = buildTaskPrompt({ ...baseTask, knowledge: "" });
    expect(out).not.toContain("Context:");
  });

  /*
    Everything below is the reason the HISTORY panel has been empty. The panel has been able to
    draw an agent's report since the MCP tools shipped; the prompt never once asked for one, and
    ended at "Execute the task above." A worker cannot report to a surface it was never told about.
  */
  it("names the task the way the tools name it", () => {
    // Every MCP call needs both. Without them the worker would have to guess its own id.
    const out = buildTaskPrompt(baseTask, { taskKey: "INT-2" });

    expect(out).toContain("INT-2");
    expect(out).toContain("ws_1");
    expect(out).toContain("task_1");
  });

  it("asks for a result, and names the tool that records one", () => {
    const out = buildTaskPrompt(baseTask, { taskKey: "INT-2" });

    expect(out).toContain("lotus_append_task_feedback_event");
    expect(out).toContain("lotus_request_task_review");
  });

  it("tells the worker what to do when it cannot finish", () => {
    // The one rule worth stating outright: a blocked task reported as done is worse than a blocked
    // task, because the list then says somebody can stop looking.
    const out = buildTaskPrompt(baseTask, { taskKey: "INT-2" });

    expect(out).toContain("lotus_canvas_mark_blocked");
    expect(out.toLowerCase()).toContain("do not");
  });

  it("lists the sub-tasks when the task has them", () => {
    const out = buildTaskPrompt(
      {
        ...baseTask,
        subtasks: [
          { id: "s1", title: "Read the store", status: "completed" as const },
          { id: "s2", title: "Write the reader", status: "pending" as const },
        ],
      },
      { taskKey: "INT-2" },
    );

    expect(out).toContain("Read the store");
    expect(out).toContain("Write the reader");
  });

  it("says nothing about sub-tasks when there are none", () => {
    // An empty checklist heading claims there was a checklist.
    expect(buildTaskPrompt(baseTask)).not.toContain("Sub-tasks");
  });

  it("keeps the contract even when knowledge fills the budget", () => {
    // Truncation must eat the pasted context, never the instructions that make the work reportable.
    const out = buildTaskPrompt({ ...baseTask, knowledge: "x".repeat(200_000) }, { taskKey: "INT-2" });

    expect(out).toContain("lotus_append_task_feedback_event");
  });

  it("trails with an explicit execute instruction", () => {
    const out = buildTaskPrompt(baseTask);
    expect(out.trim().endsWith("Execute the task above.")).toBe(true);
  });

  it("truncates knowledge exceeding the byte cap with a clear marker", () => {
    const big = "x".repeat(KNOWLEDGE_PROMPT_CAP_BYTES + 5_000);
    const out = buildTaskPrompt({ ...baseTask, knowledge: big });
    expect(out).toContain("[truncated");
    // Total bytes well under raw knowledge length
    const knowledgeChunk = out.split("Context:\n")[1] ?? "";
    expect(Buffer.byteLength(knowledgeChunk, "utf8")).toBeLessThan(big.length);
  });

  it("preserves UTF-8 multi-byte chars when truncating (no broken codepoints)", () => {
    const unit = "私";
    const big = unit.repeat(Math.ceil(KNOWLEDGE_PROMPT_CAP_BYTES / 3) + 10);
    const out = buildTaskPrompt({ ...baseTask, knowledge: big });
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(out))).not.toThrow();
  });

  it("renders an optional workspace context block before the task", () => {
    const out = buildTaskPrompt(baseTask, { workspaceLabel: "lotus", cwd: "/repo/lotus" });
    expect(out.indexOf("workspace=lotus")).toBeGreaterThan(-1);
    expect(out.indexOf("cwd=/repo/lotus")).toBeGreaterThan(-1);
    expect(out.indexOf("workspace=lotus")).toBeLessThan(out.indexOf("Task:"));
  });
});
