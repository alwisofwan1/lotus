import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

// Read-only project file and git access (src-tauri/src/project_files). Canvas, the codespace
// terminals and CodeChat all use it, so it lives outside the CodeChat wrapper.

export interface GitRepoStatus {
  repoRoot: string;
  branch: string;
  hasChanges: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
}

export interface ProjectFile {
  path: string;
  content: string;
  totalLines: number;
}

export interface CodebaseSearchResult {
  path: string;
  lineNumber: number;
  line: string;
  submatches?: Array<{
    match: string;
    start: number;
    end: number;
  }>;
}

/** Who last changed one line (`project_files/git.rs`). */
export interface GitBlameEntry {
  lineNumber: number;
  /** First 8 characters. */
  commit: string;
  author: string;
  /** Unix seconds. */
  timestamp: number;
  /** The commit message's first line. */
  summary: string;
  /** False for a line changed on disk but not committed. */
  committed: boolean;
  /** The author is this repo's `user.email`. */
  you: boolean;
}

export async function getGitRepoStatus(projectPath: string): Promise<GitRepoStatus | null> {
  if (!isTauri()) {
    return null;
  }

  try {
    return await tauriInvoke<GitRepoStatus>("git_repo_status", { projectPath });
  } catch {
    return null;
  }
}

export async function readProjectFile(
  projectPath: string,
  filePath: string,
  startLine?: number,
  endLine?: number,
): Promise<ProjectFile> {
  if (!isTauri()) {
    throw new Error("Desktop app required for project file reads.");
  }

  return tauriInvoke<ProjectFile>("read_project_file", {
    projectPath,
    filePath,
    startLine,
    endLine,
  });
}

export async function searchCodebase(
  projectPath: string,
  pattern: string,
  fileGlob?: string,
  maxResults?: number,
): Promise<CodebaseSearchResult[]> {
  if (!isTauri()) {
    throw new Error("Desktop app required for codebase search.");
  }

  return tauriInvoke<CodebaseSearchResult[]>("search_codebase", {
    projectPath,
    pattern,
    fileGlob,
    maxResults,
  });
}

export async function gitBlameFile(
  projectPath: string,
  filePath: string,
  startLine?: number,
  endLine?: number,
): Promise<GitBlameEntry[]> {
  if (!isTauri()) {
    throw new Error("Desktop app required for git blame.");
  }

  return tauriInvoke<GitBlameEntry[]>("git_blame_file", {
    projectPath,
    filePath,
    startLine,
    endLine,
  });
}

export async function gitDiffProject(
  projectPath: string,
  target?: string,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("Desktop app required for git diff.");
  }

  return tauriInvoke<string>("git_diff", { projectPath, target });
}
