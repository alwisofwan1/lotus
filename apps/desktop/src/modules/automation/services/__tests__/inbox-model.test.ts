import { describe, expect, it } from "vitest";

import type { Automation, AutomationDraft, AutomationRun } from "../automation-api";
import { initials, needsAttention, pendingByAutomation, requesterLabel, reviewPreview, shortPr, waitingItems, waitingRequests } from "../inbox-model";

const base: AutomationDraft = {
  id: "d1",
  runId: "r1",
  automationId: "a1",
  kind: "pr_review",
  subject: "acme/api#1",
  status: "pending",
  content: { repo: "acme/api", number: 1, url: "u", headSha: "h", summary: "", comments: [] } as unknown as AutomationDraft["content"],
  slack: null,
  result: null,
  sentUrl: null,
  createdAtMs: 1,
};

describe("waitingItems", () => {
  it("keeps one row per PR (its latest round), puts Asks first, and counts a result once", () => {
    const round2 = { ...base, id: "d2", createdAtMs: 5 };
    const other = { ...base, id: "d3", automationId: "a2", content: { ...base.content!, number: 2 }, createdAtMs: 3 };
    const ask = { ...base, id: "q1", kind: "ask", content: null, ask: { question: "?", choices: [], actionKind: "agent_prompt" } } as AutomationDraft;
    const sent: AutomationDraft = { ...base, id: "d0", status: "sent" };
    const rows = waitingItems([base, round2, other, ask, sent], [round2]);
    expect(rows.map((d) => d.id)).toEqual(["q1", "d2", "d3"]);
    expect(pendingByAutomation(rows)).toEqual(new Map([["a1", 2], ["a2", 1]]));
  });
});

describe("row facts", () => {
  it("counts findings that still stand: blockers, should-fix, and earlier ones not fixed", async () => {
    const { openFindings, isReReview } = await import("../inbox-model");
    const d = {
      ...base,
      content: {
        ...base.content!,
        comments: [
          { path: "a", line: 1, severity: "blocker" as const, body: "" },
          { path: "a", line: 2, severity: "question" as const, body: "" },
          { path: "a", line: 3, body: "" },
        ],
        previous: [
          { path: "b", line: 1, body: "", status: "fixed", note: null, hasThread: true },
          { path: "b", line: 2, body: "", status: "not-fixed", note: null, hasThread: true },
        ],
      },
    };
    expect(openFindings(d)).toBe(2);
    expect(isReReview(d)).toBe(true);
    expect(isReReview(base)).toBe(false);
  });

  it("groups rows: Asks first, then Today, Yesterday, then the date", async () => {
    const { waitingGroupLabel } = await import("../inbox-model");
    const now = new Date(2026, 9, 2, 15, 0).getTime();
    const at = (d: number, h = 9) => ({ ...base, createdAtMs: new Date(2026, 9, d, h).getTime() });
    expect(waitingGroupLabel(at(2, 1), now)).toBe("Today");
    expect(waitingGroupLabel(at(1, 23), now)).toBe("Yesterday");
    const older = { ...base, createdAtMs: new Date(2026, 8, 28, 9).getTime() };
    expect(waitingGroupLabel(older, now)).toBe(new Date(2026, 8, 28).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }));
    expect(waitingGroupLabel({ ...base, kind: "ask", ask: { question: "?", choices: [], actionKind: "agent_prompt" } } as AutomationDraft, now)).toBe(
      "Needs your answer",
    );
  });
});

describe("rowStatus — one status per quiet row (16a)", () => {
  const review = (verdict: "looks-good" | "questions" | "changes-needed", comments = 0, previous: unknown[] = []) =>
    ({
      ...base,
      content: {
        ...base.content!,
        comments: Array.from({ length: comments }, (_, i) => ({ path: "a", line: i, body: "" })),
        reply: { verdict, points: [] },
        previous,
      },
    }) as AutomationDraft;

  it("names the verdict and the comments once, toned by kind", async () => {
    const { rowStatus } = await import("../inbox-model");
    expect(rowStatus(review("changes-needed", 4))).toEqual({ tone: "changes", text: "Changes needed · 4 comments" });
    expect(rowStatus(review("questions", 1))).toEqual({ tone: "changes", text: "Questions · 1 comment" });
    expect(rowStatus(review("looks-good"))).toEqual({ tone: "waiting", text: "Looks good · ready to send" });
    expect(rowStatus(review("changes-needed", 2, [{}])).text).toBe("Re-review · Changes needed · 2 comments");
  });

  it("an Ask needs an answer, a channel result waits to post, a send in flight says so", async () => {
    const { rowStatus } = await import("../inbox-model");
    const ask = { ...base, kind: "ask", content: null, ask: { question: "?", choices: [], actionKind: "agent_prompt" } } as AutomationDraft;
    expect(rowStatus(ask)).toEqual({ tone: "ask", text: "Needs your answer" });
    const result = { ...base, kind: "agent_prompt", content: null, result: { channel: "C1" } } as unknown as AutomationDraft;
    expect(rowStatus(result, { channelName: () => "eng" }).text).toBe("Waiting to post in #eng");
    expect(rowStatus({ ...base, status: "sending" }).text).toBe("Sending…");
    expect(rowStatus(result, { older: true }).text).toBe("Waiting to post in #C1 · older run");
  });
});

describe("waitingRequests", () => {
  const asked = (id: string, at: number, thread: string | null): AutomationDraft => ({
    ...base,
    id,
    createdAtMs: at,
    slack: thread ? { channel: "C1", threadTs: thread, requester: "U1" } : null,
  });

  it("puts one Slack thread's reviews together where its newest was, in the order they were asked", () => {
    // Newest first, as waitingItems orders them.
    const waiting = [asked("b2", 9, "t1"), asked("solo", 8, null), asked("x", 7, "t2"), asked("b1", 5, "t1")];
    const requests = waitingRequests(waiting);
    expect(requests.map((r) => [r.key, r.items.map((d) => d.id)])).toEqual([
      ["C1:t1", ["b1", "b2"]],
      [null, ["solo"]],
      ["C1:t2", ["x"]],
    ]);
  });
});

describe("requesterLabel", () => {
  it("names who asked, says You for the user, and never shows a raw id", () => {
    const slack = { channel: "C1", threadTs: "t", requester: "U1" };
    expect(requesterLabel(slack, new Map([["U1", "Tanaka"]]))).toEqual({ who: "Tanaka", known: true, you: false });
    expect(requesterLabel(slack, new Map())).toEqual({ who: "Someone", known: false, you: false });
    expect(requesterLabel({ ...slack, requester: null }, new Map())).toEqual({ who: "You", known: true, you: true });
  });

  it("takes two initials from a name", () => {
    expect(initials("Tanaka")).toBe("TA");
    expect(initials("Rizky Pratama")).toBe("RP");
    expect(initials("alwi.sofwan")).toBe("AS");
  });
});

describe("PR rows", () => {
  it("drop the owner and preview the Slack lead before the audit summary", () => {
    const d = { ...base, content: { ...base.content!, summary: "Spec: 0 findings.", reply: { verdict: "questions" as const, points: [], lead: "Backend matches TKT-1051." } } };
    expect(shortPr(d)).toBe("api#1");
    expect(reviewPreview(d)).toBe("Backend matches TKT-1051.");
    expect(reviewPreview({ ...d, content: { ...d.content, reply: { verdict: "questions", points: [] } } })).toBe("Spec: 0 findings.");
  });
});

describe("needsAttention", () => {
  const a = (id: string) => ({ id, name: id }) as unknown as Automation;
  const run = (automationId: string, status: AutomationRun["status"], createdAtMs: number) =>
    ({ id: `${automationId}${createdAtMs}`, automationId, status, createdAtMs }) as AutomationRun;

  it("flags an automation whose latest finished run failed, until a run succeeds", () => {
    const runs = [run("x", "succeeded", 1), run("x", "failed", 2), run("x", "skipped", 3), run("y", "failed", 1), run("y", "succeeded", 2)];
    expect(needsAttention([a("x"), a("y")], runs).map((n) => n.automation.id)).toEqual(["x"]);
  });
});
