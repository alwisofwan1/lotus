import { describe, expect, it, vi } from "vitest";
import {
  busyIssues,
  busyIssuesInWorkspace,
  createFactoryRunStarter,
  filterIssues,
  implementerChoice,
  newRunFooter,
  parseCap,
} from "@/modules/factory/services/factory-new-run";
import type { FactoryRunState } from "@/modules/factory/services/factory-run";

const row = (issue: number, state: FactoryRunState, repo = "o/r") => ({ repo, issue, state });

describe("busyIssues", () => {
  it("an issue whose newest run is running, paused or has its draft PR open cannot start again", () => {
    const busy = busyIssues(
      [
        row(1, "running"),
        row(2, "paused"),
        row(3, "check-failed"),
        row(4, "done"),
        row(5, "stopped"),
        row(6, "running", "x/y"),
        row(7, "merged"),
        row(8, "pr-closed"),
        row(9, "recovery-required"),
      ],
      "O/R",
    );
    expect([...busy.keys()].sort()).toEqual([1, 2, 4, 9]);
    expect(busy.get(4)).toBe("pr-open");
    expect(busy.get(1)).toBe("running");
  });
});

describe("busyIssuesInWorkspace", () => {
  const at = (issue: string, state: FactoryRunState, checkout: string, repo = "o/r") => ({ repo, issue, state, ticket: { checkout } });

  it("a ticket running anywhere in the workspace holds it, whichever sub-repo the run is in", () => {
    const busy = busyIssuesInWorkspace(
      [
        at("TKT-1", "running", "/w/meta"),
        at("TKT-2", "paused", "/w/meta/back", "o/back"),
        at("TKT-3", "done", "/w/meta/front/", "o/front"),
        at("TKT-4", "running", "/w/other"),
        at("TKT-5", "running", "/w/meta-two"),
        at("TKT-6", "merged", "/w/meta"),
        { repo: "o/r", issue: "TKT-7", state: "running" as const },
      ],
      "/w/meta/",
    );
    expect([...busy.keys()].sort()).toEqual(["TKT-1", "TKT-2", "TKT-3"]);
    expect(busy.get("TKT-3")).toBe("pr-open");
    expect(busy.get("TKT-1")).toBe("running");
  });
});

describe("createFactoryRunStarter in a workspace", () => {
  it("works in the workspace folder itself and never looks a checkout up", async () => {
    const findCheckout = vi.fn(async () => "/elsewhere");
    const start = vi.fn(async () => "run");
    const begin = createFactoryRunStarter({
      findCheckout,
      projectIdOf: (c) => `p:${c}`,
      readIssue: async () => ({ title: "T", body: null }),
      start,
    });
    const repo = { id: "s1", repo: "o/r", account: "me", name: "o/r" };
    const results = await begin({ repo, sourceId: "n1", issues: ["TKT-1"], implementer: "p1", capUsd: 2, workspace: "/w/meta" });
    expect(results).toEqual([{ issue: "TKT-1", error: null }]);
    expect(findCheckout).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p:/w/meta", factory: expect.objectContaining({ checkout: "/w/meta" }) }));
    // A plain workspace run records no Workspace: triage has nothing to route.
    expect(start).not.toHaveBeenCalledWith(expect.objectContaining({ factory: expect.objectContaining({ workspace: expect.anything() }) }));
  });

  it("a meta-repo run records the Workspace so triage can route it to a sub-repo (FM8)", async () => {
    const start = vi.fn(async () => "run");
    const begin = createFactoryRunStarter({
      findCheckout: async () => null,
      projectIdOf: (c) => `p:${c}`,
      readIssue: async () => ({ title: "T", body: null }),
      start,
    });
    const repo = { id: "", repo: "meta", account: "me", name: "meta" };
    await begin({ repo, sourceId: "n1", issues: ["TKT-1"], implementer: "p1", capUsd: 2, workspace: "/w/meta", meta: true, repoAccounts: { "o/back": "back-bot" } });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        factory: expect.objectContaining({ workspace: "/w/meta", checkout: "/w/meta", repo: "meta", account: "me", repoAccounts: { "o/back": "back-bot" } }),
      }),
    );
  });
});

describe("parseCap", () => {
  it("takes at least one cent and nothing else: every run needs a cap", () => {
    expect(parseCap("2")).toBe(2);
    expect(parseCap(" 0.5 ")).toBe(0.5);
    expect(parseCap("0.01")).toBe(0.01);
    for (const bad of ["", "  ", "0", "0.004", "-1", "abc", "Infinity"]) expect(parseCap(bad)).toBeNull();
  });
});

describe("filterIssues", () => {
  const issues = [
    { number: 12, title: "Fix the login" },
    { number: 7, title: "Add a pluralize helper" },
  ];
  it("matches the title, any case, or the number", () => {
    expect(filterIssues(issues, "LOGIN").map((i) => i.number)).toEqual([12]);
    expect(filterIssues(issues, "#7").map((i) => i.number)).toEqual([7]);
    expect(filterIssues(issues, "  ").map((i) => i.number)).toEqual([12, 7]);
    const tickets = [
      { number: "TKT-123", title: "Login" },
      { number: "TKT-1234", title: "Export" },
    ];
    expect(filterIssues(tickets, "tkt-123").map((i) => i.number)).toEqual(["TKT-123"]);
    expect(filterIssues(tickets, "1234").map((i) => i.number)).toEqual(["TKT-1234"]);
  });
});

describe("newRunFooter", () => {
  it("says how many runs and the most they can cost", () => {
    expect(newRunFooter(3, 2)).toBe("3 runs · up to $6.00");
    expect(newRunFooter(1, 2.5)).toBe("1 run · up to $2.50");
    expect(newRunFooter(2, null)).toBe("2 runs");
    expect(newRunFooter(0, 2)).toBe("No ticket picked");
  });
});

describe("createFactoryRunStarter", () => {
  const repo = { id: "src-1", repo: "o/r", account: "me", name: "o/r" };
  const deps = () => ({
    findCheckout: vi.fn(async () => "/code/r"),
    projectIdOf: vi.fn((checkout: string) => `cp:${checkout}`),
    readIssue: vi.fn(async (_id: string, n: number | string): Promise<{ title: string; body: string; notion?: { pageId: string; url: string } } | null> => ({ title: `Issue ${n}`, body: `body ${n}` })),
    start: vi.fn(async () => "run"),
  });

  it("starts one run per issue, with the ticket, the implementer and the cap", async () => {
    const d = deps();
    const results = await createFactoryRunStarter(d)({ repo, sourceId: "src-1", issues: [1, 2], implementer: "p1", capUsd: 2 });
    expect(results).toEqual([
      { issue: 1, error: null },
      { issue: 2, error: null },
    ]);
    expect(d.findCheckout).toHaveBeenCalledTimes(1);
    expect(d.start).toHaveBeenCalledTimes(2);
    const [input] = d.start.mock.calls[0] as unknown as [{ projectId: string; budgetCap?: number; factory: Record<string, unknown> }];
    expect(input.projectId).toBe("cp:/code/r");
    expect(input.budgetCap).toBe(2);
    expect(input.factory).toMatchObject({ repo: "o/r", issue: 1, title: "Issue 1", body: "body 1", account: "me", checkout: "/code/r", implementer: "p1" });
  });

  it("one issue failing does not stop the others, and says why", async () => {
    const d = deps();
    d.start.mockImplementationOnce(async () => {
      throw new Error("MemberBusy");
    });
    const results = await createFactoryRunStarter(d)({ repo, sourceId: "src-1", issues: [1, 2], implementer: "p1", capUsd: 3 });
    expect(results).toEqual([
      { issue: 1, error: "MemberBusy" },
      { issue: 2, error: null },
    ]);
    const [input] = d.start.mock.calls[1] as unknown as [{ budgetCap?: number }];
    expect(input.budgetCap).toBe(3);
  });

  it("an issue that cannot be read is not started", async () => {
    const d = deps();
    d.readIssue.mockResolvedValueOnce(null as never);
    const results = await createFactoryRunStarter(d)({ repo, sourceId: "src-1", issues: [9], implementer: "p1", capUsd: 2 });
    expect(results).toEqual([{ issue: 9, error: "Could not read #9 from the ticket list." }]);
    expect(d.start).not.toHaveBeenCalled();
  });

  it("a Notion ticket reads its own source, runs in the picked repo, and links its page (#168)", async () => {
    const d = deps();
    d.readIssue.mockResolvedValueOnce({ title: "Login", body: "Properties:\n- Status: Todo", notion: { pageId: "pg", url: "https://www.notion.so/pg" } });
    const results = await createFactoryRunStarter(d)({ repo, sourceId: "notion-db", issues: ["TKT-123"], implementer: "p1", capUsd: 2 });
    expect(results).toEqual([{ issue: "TKT-123", error: null }]);
    expect(d.readIssue).toHaveBeenCalledWith("notion-db", "TKT-123");
    const [input] = d.start.mock.calls[0] as unknown as [{ workflowId: string; run: { title: string }; factory: Record<string, unknown> }];
    expect(input.workflowId).toBe("factory:o/r#TKT-123");
    expect(input.run.title).toBe("Login (TKT-123)");
    expect(input.factory).toMatchObject({
      repo: "o/r",
      issue: 0,
      account: "me",
      notion: { key: "TKT-123", pageId: "pg", url: "https://www.notion.so/pg" },
    });
  });

  it("with no checkout, every issue says so and nothing starts", async () => {
    const d = deps();
    d.findCheckout.mockResolvedValueOnce(null as never);
    const results = await createFactoryRunStarter(d)({ repo, sourceId: "src-1", issues: [1, 2], implementer: "p1", capUsd: 2 });
    expect(results.every((r) => r.error?.includes("No open workspace holds a checkout"))).toBe(true);
    expect(d.start).not.toHaveBeenCalled();
  });
});

describe("implementerChoice", () => {
  const presets = [{ id: "p1" }, { id: "p2" }];
  it("starts at Settings' preset, else the first, and says where it came from", () => {
    expect(implementerChoice(presets, "p2", null)).toEqual({ id: "p2", caption: "from Settings" });
    expect(implementerChoice(presets, null, null)).toEqual({ id: "p1", caption: "not set in Settings" });
    expect(implementerChoice(presets, "gone", null)).toEqual({ id: "p1", caption: "Settings preset not on this Mac" });
  });
  it("a pick in the sheet is for this batch only, unless it is Settings' own", () => {
    expect(implementerChoice(presets, "p2", "p1")).toEqual({ id: "p1", caption: "this batch only" });
    expect(implementerChoice(presets, "p2", "p2")).toEqual({ id: "p2", caption: "from Settings" });
  });
});
