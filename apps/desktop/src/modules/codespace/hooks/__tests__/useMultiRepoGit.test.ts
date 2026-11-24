import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMultiRepoGit } from "../useMultiRepoGit";
import type { CodespaceGitFileStatus, CodespaceGitRepoSummary } from "@/lib/tauri/codespace";

const mocks = vi.hoisted(() => ({
  codespaceGitStatusFor: vi.fn(),
  codespaceGitRepoSummaryFor: vi.fn(),
  codespaceGitDiscoverRepos: vi.fn(),
}));

vi.mock("@/lib/tauri/codespace", () => ({
  codespaceGitStatusFor: mocks.codespaceGitStatusFor,
  codespaceGitRepoSummaryFor: mocks.codespaceGitRepoSummaryFor,
  codespaceGitDiscoverRepos: mocks.codespaceGitDiscoverRepos,
}));

vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: () => true,
}));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => true,
}));

const FILE_A: CodespaceGitFileStatus = {
  path: "/projects/app/src/index.ts",
  relativePath: "src/index.ts",
  staged: null,
  unstaged: "modified",
};

const FILE_B: CodespaceGitFileStatus = {
  path: "/projects/lib/util.ts",
  relativePath: "util.ts",
  staged: "added",
  unstaged: null,
};

const SUMMARY_APP: CodespaceGitRepoSummary = {
  branch: "main",
  head: "abc123",
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
};

const SUMMARY_LIB: CodespaceGitRepoSummary = {
  branch: "feat/x",
  head: "def456",
  upstream: null,
  ahead: 0,
  behind: 0,
};

function setupMocks() {
  mocks.codespaceGitDiscoverRepos.mockImplementation((workspaceRoot: string) => {
    if (workspaceRoot === "/projects/app") return Promise.resolve(["/projects/app", "/projects/lib"]);
    return Promise.resolve([workspaceRoot]);
  });
  mocks.codespaceGitStatusFor.mockImplementation((_loc: unknown, opts: { repoRoot: string }) => {
    if (opts.repoRoot === "/projects/app") return Promise.resolve([FILE_A]);
    if (opts.repoRoot === "/projects/lib") return Promise.resolve([FILE_B]);
    return Promise.resolve([]);
  });
  mocks.codespaceGitRepoSummaryFor.mockImplementation((_loc: unknown, opts: { repoRoot: string }) => {
    if (opts.repoRoot === "/projects/app") return Promise.resolve(SUMMARY_APP);
    if (opts.repoRoot === "/projects/lib") return Promise.resolve(SUMMARY_LIB);
    return Promise.reject(new Error("not a repo"));
  });
}

describe("useMultiRepoGit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("fetches status and summary for each root", async () => {
    const { result } = renderHook(() =>
      useMultiRepoGit({ roots: ["/projects/app"], location: null, enabled: true }),
    );

    await waitFor(() => {
      const app = result.current.repos.get("/projects/app");
      expect(app?.statuses).toEqual([FILE_A]);
    });

    const app = result.current.repos.get("/projects/app")!;
    expect(app.summary).toEqual(SUMMARY_APP);
    expect(app.available).toBe(true);

    const lib = result.current.repos.get("/projects/lib")!;
    expect(lib.statuses).toEqual([FILE_B]);
    expect(lib.summary).toEqual(SUMMARY_LIB);
    expect(lib.available).toBe(true);
  });

  it("marks repo as unavailable when status call fails", async () => {
    mocks.codespaceGitStatusFor.mockImplementation((_loc: unknown, opts: { repoRoot: string }) => {
      if (opts.repoRoot === "/projects/app") return Promise.reject(new Error("not a git repo"));
      return Promise.resolve([FILE_B]);
    });

    const { result } = renderHook(() =>
      useMultiRepoGit({ roots: ["/projects/app"], location: null, enabled: true }),
    );

    await waitFor(() => {
      const app = result.current.repos.get("/projects/app");
      return expect(app?.loading).toBe(false);
    });

    const app = result.current.repos.get("/projects/app")!;
    expect(app.available).toBe(false);
    expect(app.statuses).toEqual([]);
  });

  it("returns empty map when disabled", () => {
    const { result } = renderHook(() =>
      useMultiRepoGit({ roots: ["/projects/app"], location: null, enabled: false }),
    );
    expect(result.current.repos.size).toBe(0);
  });

  it("refreshAll re-fetches all repos", async () => {
    const { result } = renderHook(() =>
      useMultiRepoGit({ roots: ["/projects/app"], location: null, enabled: true }),
    );

    await waitFor(() => {
      const app = result.current.repos.get("/projects/app");
      return expect(app?.loading).toBe(false);
    });
    expect(mocks.codespaceGitStatusFor).toHaveBeenCalledTimes(2); // app + lib

    await act(async () => { await result.current.refreshAll(); });
    expect(mocks.codespaceGitStatusFor).toHaveBeenCalledTimes(4); // 2 initial + 2 refresh
  });

  it("refreshRepo re-fetches a single repo", async () => {
    const { result } = renderHook(() =>
      useMultiRepoGit({ roots: ["/projects/app"], location: null, enabled: true }),
    );

    await waitFor(() => {
      const app = result.current.repos.get("/projects/app");
      return expect(app?.loading).toBe(false);
    });

    await act(async () => { await result.current.refreshRepo("/projects/app"); });
    expect(mocks.codespaceGitStatusFor).toHaveBeenLastCalledWith(null, { repoRoot: "/projects/app" });
  });

  it("totalChanges sums across all repos", async () => {
    const { result } = renderHook(() =>
      useMultiRepoGit({ roots: ["/projects/app"], location: null, enabled: true }),
    );

    await waitFor(() => expect(result.current.totalChanges).toBe(2));
  });

  it("loading is true while any repo is fetching", async () => {
    let resolveApp: (v: CodespaceGitFileStatus[]) => void;
    mocks.codespaceGitDiscoverRepos.mockResolvedValue(["/projects/app"]);
    mocks.codespaceGitStatusFor.mockImplementation((_loc: unknown, opts: { repoRoot: string }) => {
      if (opts.repoRoot === "/projects/app") {
        return new Promise((r) => { resolveApp = r; });
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() =>
      useMultiRepoGit({ roots: ["/projects/app"], location: null, enabled: true }),
    );

    // After discovery resolves, loading states are set
    await waitFor(() => expect(result.current.repos.size).toBe(1));
    expect(result.current.loading).toBe(true);

    await act(async () => { resolveApp!([FILE_A]); });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});
