import { joinUnder } from "@/lib/path-utils";
import type { CodespaceGitFileStatus, EditorListEntry } from "@/lib/tauri-api";
import { rankPaths } from "@/modules/codespace/services/fuzzy-path";

export type FileNode = {
  kind: "file";
  id: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  ignored?: boolean;
};

export type DirectoryNode = {
  kind: "directory";
  id: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  ignored?: boolean;
  children: TreeNode[];
};

export type TreeNode = FileNode | DirectoryNode;

export type DeleteDraft = {
  kind: "file" | "directory";
  name: string;
  relativePath: string;
  busy: boolean;
};

export type MutableDirectoryNode = {
  kind: "directory";
  id: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  ignored?: boolean;
  directoryChildren: Map<string, MutableDirectoryNode>;
  fileChildren: FileNode[];
};

export function toRelative(rootDir: string, absolutePath: string): string {
  if (!absolutePath.startsWith(rootDir)) return absolutePath;
  const relative = absolutePath.slice(rootDir.length).replace(/^[/\\]+/, "");
  return relative || absolutePath;
}

export function buildTree(rootDir: string, entries: EditorListEntry[]): TreeNode[] {
  const root: MutableDirectoryNode = {
    kind: "directory",
    id: "__root__",
    name: rootDir,
    relativePath: "",
    absolutePath: rootDir,
    directoryChildren: new Map(),
    fileChildren: [],
  };

  const normalize = (value: string) => value.replace(/\\/g, "/");
  const sortedUniqueEntries = Array.from(
    new Map(entries.map((entry) => [entry.path, entry])).values(),
  ).sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
  });

  for (const entry of sortedUniqueEntries) {
    const absolutePath = entry.path;
    const relativePath = normalize(toRelative(rootDir, absolutePath));
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    let parent = root;
    let parentRelativePath = "";
    let parentAbsolutePath = rootDir;
    for (const segment of segments.slice(0, -1)) {
      const nextRelativePath = parentRelativePath ? `${parentRelativePath}/${segment}` : segment;
      const nextAbsolutePath = joinUnder(parentAbsolutePath, segment);
      let nextDirectory = parent.directoryChildren.get(segment);
      if (!nextDirectory) {
        nextDirectory = {
          kind: "directory",
          id: `dir:${nextRelativePath}`,
          name: segment,
          relativePath: nextRelativePath,
          absolutePath: nextAbsolutePath,
          directoryChildren: new Map(),
          fileChildren: [],
        };
        parent.directoryChildren.set(segment, nextDirectory);
      }
      parent = nextDirectory;
      parentRelativePath = nextRelativePath;
      parentAbsolutePath = nextAbsolutePath;
    }

    const itemName = segments[segments.length - 1] ?? relativePath;
    if (entry.kind === "directory") {
      const nextRelativePath = parentRelativePath ? `${parentRelativePath}/${itemName}` : itemName;
      const nextAbsolutePath = joinUnder(parentAbsolutePath, itemName);
      if (!parent.directoryChildren.has(itemName)) {
        parent.directoryChildren.set(itemName, {
          kind: "directory",
          id: `dir:${nextRelativePath}`,
          name: itemName,
          relativePath: nextRelativePath,
          absolutePath: nextAbsolutePath,
          directoryChildren: new Map(),
          fileChildren: [],
        });
      }
      // The folder may exist already as the parent of a deeper entry; its own entry decides.
      if (entry.ignored) parent.directoryChildren.get(itemName)!.ignored = true;
      continue;
    }

    parent.fileChildren.push({
      kind: "file",
      id: `file:${relativePath}`,
      name: itemName,
      relativePath,
      absolutePath,
      ...(entry.ignored ? { ignored: true } : {}),
    });
  }

  const toTreeNode = (directory: MutableDirectoryNode): DirectoryNode => {
    const directories: DirectoryNode[] = Array.from(directory.directoryChildren.values())
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
      .map(toTreeNode);
    const files = directory.fileChildren.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );

    return {
      kind: "directory",
      id: directory.id,
      name: directory.name,
      relativePath: directory.relativePath,
      absolutePath: directory.absolutePath,
      ...(directory.ignored ? { ignored: true } : {}),
      children: [...directories, ...files],
    };
  };

  return toTreeNode(root).children;
}

/**
 * The tree for a filter: the files Go to file ranks first for `query`, searched across the whole
 * index (a lazy tree has only read the folders you opened), with just the folders above them.
 */
export function searchTree(
  rootDir: string,
  query: string,
  files: readonly string[],
  limit: number,
): TreeNode[] {
  const hits = rankPaths(query, files, { rootDir, limit });
  return buildTree(rootDir, hits.map((hit) => ({ path: hit.path, kind: "file" })));
}

export function gitStatusLabel(status: CodespaceGitFileStatus): string {
  if (status.unstaged === "untracked") return "?";
  if (status.staged === "added") return "A";
  if (status.staged === "deleted" || status.unstaged === "deleted") return "D";
  if (status.staged === "renamed") return "R";
  if (status.staged === "copied") return "C";
  if (status.staged || status.unstaged) return "M";
  return "";
}

export function gitStatusTone(status: CodespaceGitFileStatus): string {
  if (status.unstaged === "untracked") return "text-emerald-200/82";
  if (status.staged && status.unstaged) return "text-amber-200/86";
  if (status.staged) return "text-blue-200/86";
  return "text-orange-200/82";
}
