import { formatRemoteError, parseRemoteError } from "@/lib/tauri/remote-error";
import type { WorkbenchTab } from "@/modules/codespace/components/types";

export function describeError(err: unknown): string {
  return formatRemoteError(parseRemoteError(err));
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** `path` is `root` or under it; `/x/repo2` is not under `/x/repo`. */
export function isInsideRoot(root: string, path: string): boolean {
  const base = normalizePath(root).replace(/\/+$/, "");
  const target = normalizePath(path);
  return target === base || target.startsWith(`${base}/`);
}

export function openFilePaths(tabs: WorkbenchTab[]): string[] {
  return tabs.flatMap((tab) => (tab.kind === "file" ? [tab.filePath] : []));
}
