import { describe, expect, it, vi } from "vitest";

import { openRunPane, type RunPaneGrid } from "../run-pane";

const request = { token: "tok-1", workspaceId: "ws-orbit", command: "LOTUS_AUTOMATION_RUN=1 claude --session-id tok-1 \"$(cat '/p.md')\"" };

function report() {
  return { opened: vi.fn(async () => undefined), failed: vi.fn(async () => undefined) };
}

function grid(overrides: Partial<RunPaneGrid> = {}): RunPaneGrid {
  return {
    workspace: vi.fn(() => ({ cwd: "/Users/me/workspace/orbit", remote: false })),
    addPane: vi.fn(() => "pane-1"),
    ...overrides,
  };
}

describe("openRunPane", () => {
  it("opens the run's command in its project and reports the project folder", async () => {
    const g = grid();
    const r = report();
    await openRunPane(request, g, r);
    expect(g.addPane).toHaveBeenCalledWith("ws-orbit", request.command, undefined);
    expect(r.opened).toHaveBeenCalledWith("tok-1", "/Users/me/workspace/orbit", "ws-orbit");
    expect(r.failed).not.toHaveBeenCalled();
  });

  it("opens a PR review in the checkout of its repo inside the project, and reports where", async () => {
    const g = grid({
      workspaces: () => [
        { id: "ws-orbit", cwd: "/w/acme-main", remote: false },
        { id: "ws-remote", cwd: "/srv", remote: true },
      ],
    });
    const findCheckout = vi.fn(async () => ({ workspaceId: "ws-orbit", cwd: "/w/acme-main/acme-web" }));
    const r = { ...report(), findCheckout };
    await openRunPane({ ...request, repo: "acme/acme-web" }, g, r);
    expect(findCheckout).toHaveBeenCalledWith(
      "acme/acme-web",
      [{ id: "ws-orbit", cwd: "/w/acme-main" }],
      "ws-orbit",
    );
    expect(g.addPane).toHaveBeenCalledWith("ws-orbit", request.command, "/w/acme-main/acme-web");
    expect(r.opened).toHaveBeenCalledWith("tok-1", "/w/acme-main/acme-web", "ws-orbit");
  });

  it("opens in the automation's project when no checkout is found, or the search fails", async () => {
    for (const findCheckout of [vi.fn(async () => null), vi.fn(async () => Promise.reject("git missing"))]) {
      const g = grid({ workspaces: () => [{ id: "ws-orbit", cwd: "/w/acme-main", remote: false }] });
      const r = { ...report(), findCheckout };
      await openRunPane({ ...request, repo: "acme/acme-infra" }, g, r);
      expect(g.addPane).toHaveBeenCalledWith("ws-orbit", request.command, undefined);
      expect(r.opened).toHaveBeenCalledWith("tok-1", "/Users/me/workspace/orbit", "ws-orbit");
    }
  });

  it("fails the run, with what to do, when the project is not open", async () => {
    const r = report();
    await openRunPane(request, grid({ workspace: () => null }), r);
    expect(r.failed).toHaveBeenCalledWith("tok-1", expect.stringContaining("not open in Lotus"));
    expect(r.opened).not.toHaveBeenCalled();
  });

  it("refuses a remote project: the prompt file is on this machine", async () => {
    const g = grid({ workspace: () => ({ cwd: "/srv/app", remote: true }) });
    const r = report();
    await openRunPane(request, g, r);
    expect(g.addPane).not.toHaveBeenCalled();
    expect(r.failed).toHaveBeenCalledWith("tok-1", expect.stringContaining("remote"));
  });

  it("still answers when there is no grid yet, or the pane cannot be added", async () => {
    const r1 = report();
    await openRunPane(request, null, r1);
    expect(r1.failed).toHaveBeenCalledWith("tok-1", expect.stringContaining("no workspace grid"));

    const r2 = report();
    await openRunPane(request, grid({ addPane: () => null }), r2);
    expect(r2.failed).toHaveBeenCalledWith("tok-1", expect.stringContaining("Could not open a pane"));

    const r3 = report();
    await openRunPane(request, grid({ addPane: () => { throw new Error("boom"); } }), r3);
    expect(r3.failed).toHaveBeenCalledWith("tok-1", expect.stringContaining("boom"));
  });
});
