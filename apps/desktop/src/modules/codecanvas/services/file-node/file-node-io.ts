import { codespaceGitDiffFileContentFor } from "@/lib/tauri/codespace-git-dispatch";
import { editorIndexFilesFor } from "@/lib/tauri/codespace-editor-dispatch";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import { readDiskFile } from "@/modules/codespace/services/editor-file-store";
import { watchEditorRoot } from "@/lib/tauri/editor-watch";
import { getActiveProjectLocation, getActiveProjectRootDir } from "../canvas-active-project";
import { createFileWatchRegistry, type FileSource } from "./file-watch-registry";

/**
 * The File Node's seam to disk, git and the active project: everything the pure registry and view
 * helpers are kept clear of. Thin on purpose; the behaviour worth testing lives next door.
 */

/** The active project's machine in the editor's own spelling; null = this one. */
export function activeFileLocation(root: string): CodeSpaceStoredWorkspaceLocation | null {
  const machine = getActiveProjectLocation();
  if (!machine) return null;
  return { kind: "ssh", host: machine.host, ...(machine.user ? { user: machine.user } : {}), ...(machine.port ? { port: machine.port } : {}), remoteCwd: root };
}

/** Where a File Node's path lives right now, or null when no project is open. */
export function activeFileSource(path: string): FileSource | null {
  const root = getActiveProjectRootDir();
  if (!root) return null;
  return { root, location: activeFileLocation(root), path };
}

export const fileWatchRegistry = createFileWatchRegistry({
  read: (root, location, path) => {
    // The editor's own routing: a path outside the root is read where it is (on SSH, from its own folder).
    return readDiskFile(path, { location, rootDir: root });
  },
  watch: (root, onChange) => watchEditorRoot("canvas-file-nodes", root, onChange),
  onWindowFocus: (callback) => {
    if (typeof window === "undefined") return () => {};
    window.addEventListener("focus", callback);
    return () => window.removeEventListener("focus", callback);
  },
});

/**
 * git's copy of the file for the marks beside the line numbers: HEAD's, so an edit an agent already
 * staged still counts as changed (the "unstaged" side would compare against the index and lose it).
 * The staged diff's `original` is HEAD's text. Null when git has none (untracked, no repo).
 */
export async function fetchGitBaseline(source: FileSource): Promise<string | null> {
  try {
    const diff = await codespaceGitDiffFileContentFor(source.location, source.path, "staged", { repoRoot: source.root });
    return diff.original;
  } catch {
    return null;
  }
}

/** Every file under the canvas project root, absolute paths, for ⌘K "Open file…". */
export async function indexProjectFiles(): Promise<string[]> {
  const root = getActiveProjectRootDir();
  if (!root) return [];
  try {
    const index = await editorIndexFilesFor(activeFileLocation(root), root);
    return index.files;
  } catch {
    return [];
  }
}
