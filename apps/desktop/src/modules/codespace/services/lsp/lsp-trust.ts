/*
 * Which folders may run a language server. A server runs the project's own code: a TypeScript
 * server from the project's `node_modules/.bin`, rust-analyzer the crate's build scripts and
 * proc macros. Opening a cloned repo must not do that before the user says the folder is theirs
 * to trust, as VS Code's Workspace Trust asks.
 */

import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";

/** One key per folder per machine: `/repo` here and `/repo` on an SSH host are two folders. */
export function trustKey(location: CodeSpaceStoredWorkspaceLocation | null | undefined, folder: string): string {
  const path = folder.replace(/\/+$/, "") || "/";
  if (location?.kind === "ssh") {
    return `ssh:${location.user ? `${location.user}@` : ""}${location.host}:${location.port ?? 22}:${path}`;
  }
  return `local:${path}`;
}

/** A folder is trusted when it, or a folder above it, was trusted on the same machine. */
export function isFolderTrusted(
  trusted: readonly string[],
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  folder: string,
): boolean {
  const key = trustKey(location, folder);
  return trusted.some((entry) => {
    if (entry === key) return true;
    const parent = entry.endsWith("/") ? entry : `${entry}/`;
    return key.startsWith(parent);
  });
}
