/** A folder compared as a folder: a trailing separator does not make it another one. */
const folderKey = (path: string) => path.trim().replace(/[\\/]+$/, "");

/**
 * The workspace a ticket is delegated to when nobody picked one, given the folder on screen beside
 * Tasks (the canvas board's): the workspace in that folder, else null so the caller falls back to
 * the rail's first. Without it the Dock sent a ticket to whichever workspace the rail listed first,
 * a folder unrelated to the board the agent was drawn on.
 */
export function workspaceInFolder(
  projects: readonly { id: string }[],
  folder: string | null | undefined,
  folderOf: (id: string) => string | null | undefined,
): string | null {
  const wanted = folder ? folderKey(folder) : "";
  if (!wanted) return null;
  return projects.find((project) => {
    const cwd = folderOf(project.id);
    return cwd ? folderKey(cwd) === wanted : false;
  })?.id ?? null;
}
