import { describe, expect, it, vi } from "vitest";
import type { AutomationDraft } from "@/modules/automation";
import type { FactoryRunRow } from "@/modules/factory";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";
import { automationAskLine, automationNeedsYouAsks, factoryAskedAt, factoryNeedsYouAsks, taskNeedsYouAsks } from "../needs-you-sources";

const row = (patch: Partial<FactoryRunRow>): FactoryRunRow =>
  ({ id: "r1", projectId: "p", repo: "o/r", issue: 42, title: "Fix login", state: "needs-answers", group: "needs-you", startedAt: 100, endedAt: null, progress: null, intake: null, ...patch }) as FactoryRunRow;

describe("needs-you sources (S5)", () => {
  it("takes the Factory runs in the needs-you group, waiting since their last step ended", () => {
    const open = vi.fn();
    const asks = factoryNeedsYouAsks([row({}), row({ id: "r2", group: "running" as FactoryRunRow["group"] })], open);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ id: "factory:r1", source: "factory", askedAtMs: 100 });
    asks[0].onOpen();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }));
    const progress = { steps: [{ stage: "spec", attempt: 1, startedAt: 150, endedAt: 900 }] } as unknown as FactoryRunRow["progress"];
    expect(factoryAskedAt({ startedAt: 100, progress })).toBe(900);
  });

  it("says what an Automation row waits for", () => {
    const draft = (patch: Partial<AutomationDraft>) => ({ id: "d", kind: "pr_review", subject: "PR #7", createdAtMs: 5, ...patch }) as AutomationDraft;
    expect(automationAskLine(draft({}))).toBe("Review ready to send");
    expect(automationAskLine(draft({ kind: "ask", ask: { question: "?" } as AutomationDraft["ask"] }))).toBe("Asks you a question");
    expect(automationAskLine(draft({ kind: "agent_prompt" }))).toBe("Result to read");
    expect(automationNeedsYouAsks([draft({})], () => {})[0]).toMatchObject({ id: "automation:d", name: "PR #7", askedAtMs: 5 });
  });

  it("takes a workspace's tasks in review, not a ticket source's", () => {
    const projects = new Map<string, TrackerProject>([
      ["ws", { id: "ws", name: "Lotus", prefix: "LOT" } as TrackerProject],
      ["vault", { id: "vault", name: "Vault", prefix: "TKT", source: { kind: "obsidian" } } as unknown as TrackerProject],
    ]);
    const task = (patch: Partial<TrackerTask>) => ({ id: "t1", projectId: "ws", number: 2, title: "Ship it", status: "in-review", updatedAt: 9, ...patch }) as TrackerTask;
    const open = vi.fn();
    const asks = taskNeedsYouAsks([task({}), task({ id: "t2", projectId: "vault" }), task({ id: "t3", status: "todo" })], projects, open);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ id: "task:t1", source: "task", name: "LOT-2 Ship it", askedAtMs: 9 });
    asks[0].onOpen();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
  });
});
