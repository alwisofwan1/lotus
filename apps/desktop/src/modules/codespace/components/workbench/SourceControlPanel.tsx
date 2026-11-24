"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { CodespaceGitFileStatus, CodespaceGitRepoSummary } from "@/lib/tauri-api";
import type { GitRepoState } from "@/modules/codespace/hooks/useMultiRepoGit";
import { cn } from "@/lib/utils";
import { SourceControlRepoSection } from "./SourceControlRepoSection";

interface SingleRepoSourceControlPanelProps {
  rootDir: string;
  statuses: CodespaceGitFileStatus[];
  summary: CodespaceGitRepoSummary | null;
  gitAvailable: boolean;
  loading: boolean;
  actionPath: string | null;
  commitMessage: string;
  committing: boolean;
  pushing: boolean;
  aiSuggesting: boolean;
  error: string | null;
  onCommitMessageChange: (message: string) => void;
  onCommit: () => void;
  onPush: () => void;
  onAiSuggestCommit: () => void;
  onRefresh: () => void;
  onStageFile: (filePath: string) => void;
  onUnstageFile: (filePath: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscardAllChanges: () => void;
  onDiscardFile?: (filePath: string) => void;
  onViewDiff: (filePath: string, target: "staged" | "unstaged") => void;
}

type MaybePromise<T> = Promise<T> | T;

interface MultiRepoSourceControlPanelProps {
  repos: Map<string, GitRepoState>;
  onRefreshRepo: (rootDir: string) => void;
  onStageFile: (rootDir: string, filePath: string) => MaybePromise<void>;
  onUnstageFile: (rootDir: string, filePath: string) => MaybePromise<void>;
  onStageAll: (rootDir: string) => MaybePromise<void>;
  onUnstageAll: (rootDir: string) => MaybePromise<void>;
  onDiscardAllChanges: (rootDir: string) => MaybePromise<void>;
  /** Asked for only after the user confirmed. */
  onDiscardFile: (rootDir: string, filePath: string) => MaybePromise<void>;
  /** Resolves `false` when the commit failed; the message is kept so it is not typed again. */
  onCommit: (rootDir: string, message: string) => MaybePromise<boolean | void>;
  onPush: (rootDir: string) => MaybePromise<void>;
  /** Resolves the suggested message, or null when there is none (the error is shown elsewhere). */
  onAiSuggestCommit: (rootDir: string) => MaybePromise<string | null | void>;
  onViewDiff: (rootDir: string, filePath: string, target: "staged" | "unstaged") => void;
  /** The long git action running now, for the status bar ("Committing…"); null when none. */
  onActivityChange?: (activity: string | null) => void;
}

/** What a repo is doing. One at a time per repo: git holds a lock on the index anyway. */
type RepoTask =
  | { kind: "commit" | "push" | "suggest" | "all" }
  | { kind: "file"; path: string };

const ACTIVITY_LABELS: Partial<Record<RepoTask["kind"], string>> = {
  commit: "Committing…",
  push: "Pushing…",
  suggest: "Writing commit message…",
};

export type SourceControlPanelProps = SingleRepoSourceControlPanelProps | MultiRepoSourceControlPanelProps;

function isMultiRepoProps(props: SourceControlPanelProps): props is MultiRepoSourceControlPanelProps {
  return "repos" in props;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function SourceControlPanel(props: SourceControlPanelProps) {
  if (!isMultiRepoProps(props)) {
    return (
      <SourceControlRepoSection
        rootDir={props.rootDir}
        statuses={props.statuses}
        summary={props.summary}
        available={props.gitAvailable}
        loading={props.loading}
        actionPath={props.actionPath}
        commitMessage={props.commitMessage}
        committing={props.committing}
        pushing={props.pushing}
        aiSuggesting={props.aiSuggesting}
        error={props.error}
        onCommitMessageChange={props.onCommitMessageChange}
        onCommit={props.onCommit}
        onPush={props.onPush}
        onAiSuggestCommit={props.onAiSuggestCommit}
        onRefresh={props.onRefresh}
        onStageFile={props.onStageFile}
        onUnstageFile={props.onUnstageFile}
        onStageAll={props.onStageAll}
        onUnstageAll={props.onUnstageAll}
        onDiscardAllChanges={props.onDiscardAllChanges}
        onDiscardFile={props.onDiscardFile}
        onViewDiff={props.onViewDiff}
      />
    );
  }

  return <MultiRepoSourceControlPanel {...props} />;
}

function MultiRepoSourceControlPanel({
  repos,
  onRefreshRepo,
  onStageFile,
  onUnstageFile,
  onStageAll,
  onUnstageAll,
  onDiscardAllChanges,
  onDiscardFile,
  onCommit,
  onPush,
  onAiSuggestCommit,
  onViewDiff,
  onActivityChange,
}: MultiRepoSourceControlPanelProps) {
  const [commitMessages, setCommitMessages] = useState<Record<string, string>>({});
  // Read after an await: what the box holds now, not when the action started.
  const commitMessagesRef = useRef(commitMessages);
  const repoEntries = useMemo(() => [...repos.entries()], [repos]);
  // Repos with work first, in their own order; the clean ones fold into one row under them.
  const { active: activeRepos, clean: cleanRepos } = useMemo(() => splitByWork(repoEntries), [repoEntries]);
  const [showClean, setShowClean] = useState(false);
  const setCommitMessage = useCallback((rootDir: string, message: string) => {
    commitMessagesRef.current = { ...commitMessagesRef.current, [rootDir]: message };
    setCommitMessages(commitMessagesRef.current);
  }, []);

  const [tasks, setTasks] = useState<ReadonlyMap<string, RepoTask>>(() => new Map());
  // The guard: state lands a render later, so two quick clicks would both see the repo free.
  const tasksRef = useRef(new Map<string, RepoTask>());
  /** `ran: false` when the repo was busy or the action threw; callers show their own errors. */
  const runRepoTask = useCallback(async <T,>(rootDir: string, task: RepoTask, run: () => MaybePromise<T>): Promise<{ ran: true; value: T } | { ran: false }> => {
    if (tasksRef.current.has(rootDir)) return { ran: false };
    tasksRef.current.set(rootDir, task);
    setTasks(new Map(tasksRef.current));
    try {
      return { ran: true, value: await run() };
    } catch (error) {
      console.error("[source-control]", error);
      return { ran: false };
    } finally {
      tasksRef.current.delete(rootDir);
      setTasks(new Map(tasksRef.current));
    }
  }, []);

  const activity = useMemo(() => {
    for (const task of tasks.values()) {
      const label = ACTIVITY_LABELS[task.kind];
      if (label) return label;
    }
    return null;
  }, [tasks]);
  useEffect(() => {
    onActivityChange?.(activity);
  }, [activity, onActivityChange]);
  // A panel that goes away mid-action must not leave "Pushing…" in the status bar for good.
  useEffect(() => () => onActivityChange?.(null), [onActivityChange]);

  const commitRepo = useCallback(async (rootDir: string) => {
    const message = commitMessagesRef.current[rootDir] ?? "";
    if (!message.trim()) return;
    const result = await runRepoTask(rootDir, { kind: "commit" }, () => onCommit(rootDir, message));
    if (!result.ran || result.value === false) return;
    // Clear only what was committed: a message typed while the commit ran stays.
    if (commitMessagesRef.current[rootDir] === message) setCommitMessage(rootDir, "");
  }, [onCommit, runRepoTask, setCommitMessage]);

  const suggestMessage = useCallback(async (rootDir: string) => {
    const before = commitMessagesRef.current[rootDir] ?? "";
    const result = await runRepoTask(rootDir, { kind: "suggest" }, () => onAiSuggestCommit(rootDir));
    // A message typed while Claude wrote is the user's, and wins.
    if (result.ran && result.value && (commitMessagesRef.current[rootDir] ?? "") === before) setCommitMessage(rootDir, result.value);
  }, [onAiSuggestCommit, runRepoTask, setCommitMessage]);

  const renderRepo = ([rootDir, repo]: [string, GitRepoState]) => {
    const task = tasks.get(rootDir);
    return (
      <SourceControlRepoSection
        key={rootDir}
        rootDir={rootDir}
        statuses={repo.statuses}
        summary={repo.summary}
        available={repo.available}
        loading={repo.loading}
        busy={Boolean(task)}
        actionPath={task?.kind === "file" ? task.path : task?.kind === "all" ? "__all__" : null}
        commitMessage={commitMessages[rootDir] ?? ""}
        committing={task?.kind === "commit"}
        pushing={task?.kind === "push"}
        aiSuggesting={task?.kind === "suggest"}
        error={repo.error}
        // Open where there is something to do; a lone repo is open either way.
        defaultExpanded={repoEntries.length === 1 || repo.statuses.length > 0}
        onCommitMessageChange={(message) => setCommitMessage(rootDir, message)}
        onCommit={() => void commitRepo(rootDir)}
        onPush={() => void runRepoTask(rootDir, { kind: "push" }, () => onPush(rootDir))}
        onAiSuggestCommit={() => void suggestMessage(rootDir)}
        onRefresh={() => onRefreshRepo(rootDir)}
        onStageFile={(filePath) => void runRepoTask(rootDir, { kind: "file", path: filePath }, () => onStageFile(rootDir, filePath))}
        onUnstageFile={(filePath) => void runRepoTask(rootDir, { kind: "file", path: filePath }, () => onUnstageFile(rootDir, filePath))}
        onStageAll={() => void runRepoTask(rootDir, { kind: "all" }, () => onStageAll(rootDir))}
        onUnstageAll={() => void runRepoTask(rootDir, { kind: "all" }, () => onUnstageAll(rootDir))}
        onDiscardAllChanges={() => void runRepoTask(rootDir, { kind: "all" }, () => onDiscardAllChanges(rootDir))}
        onDiscardFile={(filePath) => void runRepoTask(rootDir, { kind: "file", path: filePath }, () => onDiscardFile(rootDir, filePath))}
        onViewDiff={(filePath, target) => onViewDiff(rootDir, filePath, target)}
      />
    );
  };

  // The count lives on the Source tab; a second header saying it again here was only height.
  return (
    <div className="source-control-panel scm-panel">
      {repoEntries.length === 0 ? (
        <p className="scm-note scm-note--center">No Git repositories found.</p>
      ) : (
        <>
          {activeRepos.map(renderRepo)}
          {activeRepos.length === 0 && repoEntries.length > 1 ? (
            <p className="scm-note scm-note--center">Every repository is clean.</p>
          ) : null}
          {cleanRepos.length > 0 && activeRepos.length > 0 ? (
            <>
              <button
                type="button"
                className={cn("scm-clean-toggle", showClean && "is-open")}
                onClick={() => setShowClean((open) => !open)}
                aria-expanded={showClean}
              >
                <ChevronRight className="scm-repo-chevron" aria-hidden="true" />
                <span>Clean</span>
                <span className="scm-repo-count">{cleanRepos.length}</span>
              </button>
              {showClean ? cleanRepos.map(renderRepo) : null}
            </>
          ) : (
            cleanRepos.map(renderRepo)
          )}
        </>
      )}
    </div>
  );
}

/** Work = changes to commit or commits to push. A repo without either has nothing to show. */
function splitByWork(entries: Array<[string, GitRepoState]>) {
  const active: Array<[string, GitRepoState]> = [];
  const clean: Array<[string, GitRepoState]> = [];
  for (const entry of entries) {
    const [, repo] = entry;
    const hasWork = repo.statuses.length > 0 || (repo.summary?.ahead ?? 0) > 0 || Boolean(repo.error);
    (hasWork ? active : clean).push(entry);
  }
  return { active, clean };
}

export { basename as sourceControlBasename };
