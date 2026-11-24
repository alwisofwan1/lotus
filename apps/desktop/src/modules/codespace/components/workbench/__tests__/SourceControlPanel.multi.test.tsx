import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceControlPanel } from "../SourceControlPanel";
import type { GitRepoState } from "@/modules/codespace/hooks/useMultiRepoGit";

type MultiRepoPanelProps = Extract<ComponentProps<typeof SourceControlPanel>, { repos: Map<string, GitRepoState> }>;

describe("SourceControlPanel (multi-repo)", () => {
  const repoApp: GitRepoState = {
    rootDir: "/projects/app",
    statuses: [
      { path: "/projects/app/src/a.ts", relativePath: "src/a.ts", staged: "modified", unstaged: null },
    ],
    summary: { branch: "main", head: "abc", upstream: "origin/main", ahead: 1, behind: 0 },
    available: true,
    loading: false,
    error: null,
  };

  const repoLib: GitRepoState = {
    rootDir: "/projects/lib",
    statuses: [
      { path: "/projects/lib/index.ts", relativePath: "index.ts", staged: null, unstaged: "untracked" },
    ],
    summary: { branch: "feat/x", head: "def", upstream: null, ahead: 0, behind: 0 },
    available: true,
    loading: false,
    error: null,
  };

  function renderPanel(overrides: Partial<MultiRepoPanelProps> = {}) {
    const repos = new Map<string, GitRepoState>([
      [repoApp.rootDir, repoApp],
      [repoLib.rootDir, repoLib],
    ]);
    const props: MultiRepoPanelProps = {
      repos,
      onRefreshRepo: vi.fn(),
      onStageFile: vi.fn(),
      onUnstageFile: vi.fn(),
      onStageAll: vi.fn(),
      onUnstageAll: vi.fn(),
      onDiscardAllChanges: vi.fn(),
      onDiscardFile: vi.fn(),
      onCommit: vi.fn(),
      onPush: vi.fn(),
      onAiSuggestCommit: vi.fn(),
      onViewDiff: vi.fn(),
      ...overrides,
    };
    return { ...props, ...render(<SourceControlPanel {...props} />) };
  }

  it("renders a section for each repo", () => {
    renderPanel();
    expect(screen.getByText("app")).toBeInTheDocument();
    expect(screen.getByText("lib")).toBeInTheDocument();
  });

  it("leaves the total to the Source tab: no second header", () => {
    renderPanel();
    expect(screen.queryByText("Source Control")).toBeNull();
  });

  it("puts repos with work first and folds the clean ones into one row", () => {
    const clean: GitRepoState = { ...repoApp, rootDir: "/projects/docs", statuses: [], summary: { branch: "main", head: "x", upstream: "origin/main", ahead: 0, behind: 0 } };
    const repos = new Map<string, GitRepoState>([[clean.rootDir, clean], [repoLib.rootDir, repoLib]]);
    renderPanel({ repos });

    const names = () => Array.from(document.querySelectorAll(".scm-repo-name"), (node) => node.textContent);
    expect(names()).toEqual(["lib"]);
    const toggle = screen.getByRole("button", { name: /clean/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(names()).toEqual(["lib", "docs"]);
  });

  it("routes stage action with rootDir context", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Stage index.ts" }));
    expect(props.onStageFile).toHaveBeenCalledWith("/projects/lib", "/projects/lib/index.ts");
  });

  it("routes commit with rootDir and message", () => {
    const repos = new Map<string, GitRepoState>([[repoApp.rootDir, repoApp]]);
    const props = renderPanel({ repos });
    // Type a commit message
    const textarea = screen.getByPlaceholderText(/message/i);
    fireEvent.change(textarea, { target: { value: "fix: patch" } });
    fireEvent.click(screen.getByRole("button", { name: /^commit$/i }));
    expect(props.onCommit).toHaveBeenCalledWith("/projects/app", "fix: patch");
  });

  it("shows empty state when no repos have changes", () => {
    const emptyRepo: GitRepoState = { ...repoApp, statuses: [] };
    const repos = new Map([[emptyRepo.rootDir, emptyRepo]]);
    renderPanel({ repos });
    expect(screen.getByText(/clean/i)).toBeInTheDocument();
  });

  it("keeps the message when the commit fails, clears it when it succeeds", async () => {
    const repos = new Map<string, GitRepoState>([[repoApp.rootDir, repoApp]]);
    const onCommit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderPanel({ repos, onCommit });
    const textarea = screen.getByPlaceholderText(/message/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "fix: patch" } });

    fireEvent.click(screen.getByRole("button", { name: /^commit$/i }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(textarea.value).toBe("fix: patch");

    fireEvent.click(screen.getByRole("button", { name: /^commit$/i }));
    await waitFor(() => expect(textarea.value).toBe(""));
  });

  it("sends one commit while it runs, and shows that it is running", async () => {
    const repos = new Map<string, GitRepoState>([[repoApp.rootDir, repoApp]]);
    let finish: (ok: boolean) => void = () => {};
    const onCommit = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    renderPanel({ repos, onCommit });
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: "fix: patch" } });

    fireEvent.click(screen.getByRole("button", { name: /^commit$/i }));
    expect(await screen.findByRole("button", { name: /^committing$/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^committing$/i }));
    expect(onCommit).toHaveBeenCalledTimes(1);

    finish(true);
    expect(await screen.findByRole("button", { name: /^commit$/i })).toBeInTheDocument();
  });

  describe("Editor Revamp 15", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function deferred<T>() {
      let resolve: (value: T) => void = () => {};
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, resolve };
    }

    const onlyApp = () => new Map<string, GitRepoState>([[repoApp.rootDir, repoApp]]);
    const box = () => screen.getByPlaceholderText(/message/i) as HTMLTextAreaElement;

    it("has one refresh button per repo row and none for the whole panel", () => {
      renderPanel();
      expect(screen.queryByRole("button", { name: "Refresh all repositories" })).toBeNull();
      expect(screen.getAllByRole("button", { name: "Refresh source control" })).toHaveLength(2);
    });

    it("AI suggest fills the commit box, with a spinner while it runs", async () => {
      const run = deferred<string>();
      const onActivityChange = vi.fn();
      renderPanel({ repos: onlyApp(), onAiSuggestCommit: vi.fn(() => run.promise), onActivityChange });

      fireEvent.click(screen.getByRole("button", { name: "AI-generated commit message" }));
      expect(screen.getByRole("button", { name: "AI-generated commit message" })).toHaveAttribute("aria-busy", "true");
      expect(onActivityChange).toHaveBeenLastCalledWith("Writing commit message…");

      run.resolve("feat(app): add a thing");
      await waitFor(() => expect(box().value).toBe("feat(app): add a thing"));
      expect(screen.getByRole("button", { name: "AI-generated commit message" })).toHaveAttribute("aria-busy", "false");
      expect(onActivityChange).toHaveBeenLastCalledWith(null);
    });

    it("AI suggest leaves a message typed while it ran", async () => {
      const run = deferred<string>();
      renderPanel({ repos: onlyApp(), onAiSuggestCommit: vi.fn(() => run.promise) });
      fireEvent.click(screen.getByRole("button", { name: "AI-generated commit message" }));
      fireEvent.change(box(), { target: { value: "fix: my own words" } });
      run.resolve("feat: suggestion");
      await waitFor(() => expect(screen.getByRole("button", { name: "AI-generated commit message" })).toHaveAttribute("aria-busy", "false"));
      expect(box().value).toBe("fix: my own words");
    });

    it("push shows Pushing while it runs and is sent once", async () => {
      const run = deferred<void>();
      const onPush = vi.fn(() => run.promise);
      const onActivityChange = vi.fn();
      renderPanel({ repos: onlyApp(), onPush, onActivityChange });

      fireEvent.click(screen.getByRole("button", { name: /Push \(1\)/ }));
      const pushing = screen.getByRole("button", { name: /Pushing/ });
      expect(pushing).toHaveAttribute("aria-busy", "true");
      expect(onActivityChange).toHaveBeenLastCalledWith("Pushing…");
      fireEvent.click(pushing);
      expect(onPush).toHaveBeenCalledTimes(1);

      run.resolve();
      expect(await screen.findByRole("button", { name: /Push \(1\)/ })).toBeInTheDocument();
    });

    it("commit reports its activity to the status bar", async () => {
      const run = deferred<boolean>();
      const onActivityChange = vi.fn();
      renderPanel({ repos: onlyApp(), onCommit: vi.fn(() => run.promise), onActivityChange });
      fireEvent.change(box(), { target: { value: "fix: patch" } });
      fireEvent.click(screen.getByRole("button", { name: /^commit$/i }));
      expect(onActivityChange).toHaveBeenLastCalledWith("Committing…");
      run.resolve(true);
      await waitFor(() => expect(onActivityChange).toHaveBeenLastCalledWith(null));
    });

    it("discarding one file asks first, naming the file", () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      const props = renderPanel();
      fireEvent.click(screen.getByRole("button", { name: "Discard index.ts" }));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("index.ts"));
      expect(props.onDiscardFile).not.toHaveBeenCalled();

      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "Discard index.ts" }));
      expect(props.onDiscardFile).toHaveBeenCalledWith("/projects/lib", "/projects/lib/index.ts");
    });

    it("says an untracked file will be deleted, and a tracked one reverted", () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      const tracked: GitRepoState = {
        ...repoApp,
        statuses: [{ path: "/projects/app/src/b.ts", relativePath: "src/b.ts", staged: null, unstaged: "modified" }],
      };
      renderPanel({ repos: new Map([[tracked.rootDir, tracked], [repoLib.rootDir, repoLib]]) });
      fireEvent.click(screen.getByRole("button", { name: "Discard index.ts" }));
      expect(confirm).toHaveBeenLastCalledWith(expect.stringMatching(/^Delete index\.ts\?/));
      fireEvent.click(screen.getByRole("button", { name: "Discard b.ts" }));
      // The folder too: two files can share a name.
      expect(confirm).toHaveBeenLastCalledWith(expect.stringMatching(/^Discard changes in src\/b\.ts\?/));
    });

    it("clears its status-bar activity when it closes mid-action", () => {
      const onActivityChange = vi.fn();
      const view = renderPanel({ repos: onlyApp(), onPush: vi.fn(() => new Promise<void>(() => {})), onActivityChange });
      fireEvent.click(screen.getByRole("button", { name: /Push \(1\)/ }));
      expect(onActivityChange).toHaveBeenLastCalledWith("Pushing…");
      view.unmount();
      expect(onActivityChange).toHaveBeenLastCalledWith(null);
    });

    it("holds every action of a repo while one runs, and frees it when that fails", async () => {
      const run = deferred<void>();
      const tracked: GitRepoState = {
        ...repoLib,
        statuses: [
          { path: "/projects/lib/index.ts", relativePath: "index.ts", staged: null, unstaged: "untracked" },
          { path: "/projects/lib/other.ts", relativePath: "other.ts", staged: null, unstaged: "modified" },
        ],
      };
      const onStageFile = vi.fn(() => run.promise);
      renderPanel({ repos: new Map([[tracked.rootDir, tracked]]), onStageFile });

      fireEvent.click(screen.getByRole("button", { name: "Stage index.ts" }));
      expect(screen.getByRole("button", { name: "Stage other.ts" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Discard other.ts" })).toBeDisabled();

      const failing = Promise.reject(new Error("index.lock exists"));
      run.resolve(failing as unknown as void);
      await waitFor(() => expect(screen.getByRole("button", { name: "Stage other.ts" })).toBeEnabled());
    });

    it("only a working-tree row can be discarded", () => {
      renderPanel();
      expect(screen.queryByRole("button", { name: "Discard a.ts" })).toBeNull();
    });
  });
});
