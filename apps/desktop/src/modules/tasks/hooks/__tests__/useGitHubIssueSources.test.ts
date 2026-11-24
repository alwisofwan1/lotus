import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGitHubIssueSources } from "@/modules/tasks/hooks/useGitHubIssueSources";
import { indexProjects, trackerTaskKey } from "@/modules/tasks/services/task-mapping";
import type {
  GitHubIssue,
  GitHubIssuesClient,
  GitHubSourceConfig,
  IssueSourceSync,
} from "@/modules/tasks/services/github-issues-source";

const config: GitHubSourceConfig = {
  id: "github-initech-lotus",
  kind: "github",
  account: "alwisofwan1",
  repo: "initech/lotus",
  name: "initech/lotus",
};

const issue: GitHubIssue = {
  number: 123,
  title: "Crash on start",
  state: "open",
  state_reason: null,
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: ["alwisofwan1"],
  author: "teammate",
  url: "https://github.com/initech/lotus/issues/123",
  body: "",
  comments: 2,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-10-03T10:00:00Z",
  closed_at: null,
};

const closed: GitHubIssue = { ...issue, number: 7, title: "Old bug", state: "closed", state_reason: "completed", labels: [], assignees: [] };

const SYNCED = Date.UTC(2026, 9, 4, 9, 30);

function synced(over: Partial<IssueSourceSync> = {}): IssueSourceSync {
  return { issues: [issue, closed], syncedAtMs: SYNCED, reconciledAtMs: SYNCED, format: 1, health: { state: "healthy" }, ...over };
}

function client(result: IssueSourceSync | ((call: number) => IssueSourceSync)): GitHubIssuesClient {
  let calls = 0;
  return {
    sync: vi.fn(async () => {
      calls += 1;
      return typeof result === "function" ? result(calls) : result;
    }),
    readIssue: vi.fn(),
    listRepos: vi.fn(),
    forget: vi.fn(async () => undefined),
  };
}

const CONFIGS = [config];

describe("GitHub repos as ticket sources", () => {
  it("reads each source in full when it appears, and shows its issues as #123, Open or Closed", async () => {
    const github = client(synced());
    const { result } = renderHook(() => useGitHubIssueSources(CONFIGS, { client: github }));

    await waitFor(() => expect(result.current.tasks).toHaveLength(2));
    // Only the id: Rust reads the account and repo from settings itself.
    expect(github.sync).toHaveBeenCalledWith("github-initech-lotus", { full: true });
    expect(result.current.tasks[0]).toMatchObject({
      id: "123",
      projectId: "github-initech-lotus",
      number: 123,
      status: "open",
      labels: ["bug"],
      assignees: [{ id: "alwisofwan1", name: "alwisofwan1" }],
    });
    expect(result.current.tasks[0].key).toBeUndefined();
    expect(result.current.tasks[1]).toMatchObject({ id: "7", status: "closed" });

    const project = result.current.projects[0];
    expect(project).toMatchObject({ id: "github-initech-lotus", name: "initech/lotus", prefix: "", source: { kind: "github" } });
    expect(project.vocabulary.labels).toEqual({ open: "Open", closed: "Closed" });
    expect(project.vocabulary.open).toEqual(["open"]);
    expect(project.capabilities).toMatchObject({ holdsTasks: false, editRows: false, hasPriority: false });
    expect(project.source?.syncLine).toMatch(/^GitHub · synced /);

    // The key a row prints is `#123`, from its number — never a PREFIX-123.
    const projects = indexProjects(result.current.projects);
    expect(trackerTaskKey(result.current.tasks[0], projects)).toBe("#123");
    expect(result.current.issueOf("github-initech-lotus", 123)).toEqual(issue);
    expect(result.current.owns("github-initech-lotus")).toBe(true);
    expect(result.current.owns("notion-x")).toBe(false);
  });

  it("keeps the last good copy on screen when gh is signed out, and says what fixes it", async () => {
    const github = client(synced({ health: { state: "lost_access", why: "login" } }));
    const { result } = renderHook(() => useGitHubIssueSources(CONFIGS, { client: github }));

    await waitFor(() => expect(result.current.tasks).toHaveLength(2));
    const health = result.current.projects[0].source?.health;
    expect(health).toMatchObject({ state: "lost_access", line: "GitHub · no access", action: "retry" });
    expect(health?.banner).toContain("gh auth login");
  });

  it("keeps the issues it has when the command itself fails", async () => {
    const github = client((call) => {
      if (call === 1) return synced();
      throw new Error("the command went away");
    });
    const { result } = renderHook(() => useGitHubIssueSources(CONFIGS, { client: github }));
    await waitFor(() => expect(result.current.tasks).toHaveLength(2));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.projects[0].source?.health?.state).toBe("failed"));
    expect(result.current.tasks).toHaveLength(2);
  });

  it("drops a source removed while its sync ran", async () => {
    let resolve: (value: IssueSourceSync) => void = () => {};
    const github: GitHubIssuesClient = {
      ...client(synced()),
      sync: vi.fn(() => new Promise<IssueSourceSync>((r) => (resolve = r))),
    };
    const { result, rerender } = renderHook(({ configs }) => useGitHubIssueSources(configs, { client: github }), {
      initialProps: { configs: CONFIGS as readonly GitHubSourceConfig[] },
    });
    rerender({ configs: [] });
    await act(async () => resolve(synced()));
    expect(result.current.tasks).toEqual([]);
    expect(result.current.projects).toEqual([]);
  });
});

describe("keeping a GitHub source fresh without a click (PLAN G12)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(SYNCED);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function settle() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("syncs every minute while Tasks is open and the window has focus — incremental after the first", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const github = client(synced());
    renderHook(() => useGitHubIssueSources(CONFIGS, { client: github, live: true }));
    await settle();
    expect(github.sync).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(github.sync).toHaveBeenCalledTimes(2);
    expect(github.sync).toHaveBeenLastCalledWith("github-initech-lotus", { full: false });
  });

  it("does not poll while Tasks is closed", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const github = client(synced());
    renderHook(() => useGitHubIssueSources(CONFIGS, { client: github, live: false }));
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(github.sync).toHaveBeenCalledTimes(1);
  });

  it("does not poll while the window is in the background, and syncs once when it comes back", async () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const github = client(synced());
    renderHook(() => useGitHubIssueSources(CONFIGS, { client: github, live: true }));
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(github.sync).toHaveBeenCalledTimes(1);

    focus.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(github.sync).toHaveBeenCalledTimes(2);
  });

  it("asks nothing while slowed down, then asks again when the wait ends", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const github = client((call) => (call === 1 ? synced({ health: { state: "slowed_down", retryAtMs: SYNCED + 90_000 } }) : synced()));
    const { result } = renderHook(() => useGitHubIssueSources(CONFIGS, { client: github, live: true }));
    await settle();
    expect(result.current.projects[0].source?.health?.state).toBe("slowed_down");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(github.sync).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(github.sync).toHaveBeenCalledTimes(2);
  });
});
