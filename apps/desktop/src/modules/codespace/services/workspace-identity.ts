/**
 * Which id a new workspace gets.
 *
 * Lotus Tasks, automations and task prefixes are all keyed by workspace id, so a folder that
 * gets a fresh id on reopen loses every one of them. A workspace for a place Lotus has seen
 * before therefore takes back that place's id — unless a workspace with that id is open right
 * now, in which case the user asked for a second workspace on the same folder and gets a new id.
 */

export interface KnownWorkspace {
  id: string;
  label?: string;
  cwd: string;
  location?: unknown;
  /** Epoch ms; the newest id for a place wins. */
  lastSeenAt: number;
}

type Location =
  | { kind: "local"; cwd?: string }
  | { kind: "ssh"; host?: string; user?: string | null; port?: number | null; remoteCwd?: string | null };

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/** The place a workspace opens: a local folder, or an SSH host + user + port + folder. */
export function workspacePlaceKey(cwd: string, location?: unknown): string {
  const loc = location as Location | undefined;
  if (loc?.kind === "ssh") {
    return `ssh:${loc.user ?? ""}@${loc.host ?? ""}:${loc.port ?? ""}:${trimSlash(loc.remoteCwd ?? "")}`;
  }
  return `local:${trimSlash(loc?.cwd ?? cwd)}`;
}

/** The id to reuse for `placeKey`, or `null` when a new one must be made. */
export function reusableWorkspaceId(
  placeKey: string,
  known: readonly KnownWorkspace[],
  openIds: ReadonlySet<string>,
): string | null {
  const candidates = known
    .filter((k) => workspacePlaceKey(k.cwd, k.location) === placeKey)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const free = candidates.find((k) => !openIds.has(k.id));
  // The newest id for this place is open: that is a second workspace on it, not a reopen.
  if (!free || (candidates[0] && openIds.has(candidates[0].id))) return null;
  return free.id;
}
