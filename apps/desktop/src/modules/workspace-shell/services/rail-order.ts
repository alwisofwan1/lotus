import type { RailWorkspace } from "@/modules/workspace-shell/types";

/**
 * Pinned folders first, everything else in the order the engine already has them.
 *
 * Ordering lives here rather than in the rail component because it is a decision about the LIST,
 * not about a row: a workspace does not know whether it is pinned until it is seen next to its
 * siblings, and a sort written inline in JSX is one that quietly stops being stable.
 *
 * Stability matters more than it looks: the rail is re-derived on every keystroke in a terminal,
 * and a comparator that reshuffles equal items would make folders jump while someone is typing.
 * `Array.prototype.sort` has been required to be stable since ES2019, and the comparator below
 * only ever separates pinned from unpinned — never two of the same.
 */
export function orderRailWorkspaces(
  workspaces: RailWorkspace[],
  pinnedIds: readonly string[],
): RailWorkspace[] {
  const pinned = new Set(pinnedIds);
  return workspaces
    .map((workspace) => (pinned.has(workspace.id) === Boolean(workspace.pinned)
      ? workspace
      : { ...workspace, pinned: pinned.has(workspace.id) }))
    .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)));
}

/** Toggling a pin, as a value rather than as a mutation: the caller stores what comes back. */
export function togglePinned(pinnedIds: readonly string[], workspaceId: string): string[] {
  return pinnedIds.includes(workspaceId)
    ? pinnedIds.filter((id) => id !== workspaceId)
    : [...pinnedIds, workspaceId];
}

/**
 * Opening a folder never closes another one (the point of the whole change), so this is a set
 * toggle and nothing more. Kept beside the pin toggle because they are read together.
 */
export function toggleOpen(openIds: readonly string[], workspaceId: string): string[] {
  return openIds.includes(workspaceId)
    ? openIds.filter((id) => id !== workspaceId)
    : [...openIds, workspaceId];
}

/** Showing a folder implies it is expanded — a folder you are looking into is not collapsed. */
export function withOpen(openIds: readonly string[], workspaceId: string): string[] {
  return openIds.includes(workspaceId) ? [...openIds] : [...openIds, workspaceId];
}

export interface RailSection {
  /** Shown as a heading above the group; used as the React key too, so it stays unique. */
  label: string;
  workspaces: RailWorkspace[];
}

/**
 * The list, cut into the two things a pin creates: kept folders, and the rest.
 *
 * Headings appear ONLY once something is pinned. A rail with one section does not need a label
 * telling you what the whole rail already says at the top — that is a heading that costs a line
 * and adds nothing — so an unpinned rail stays a flat list, exactly as it was.
 *
 * An empty group is dropped rather than drawn with nothing under it: pinning every folder should
 * leave "Pinned" alone, not "Pinned" followed by a bare "Others".
 */
export function railSections(ordered: RailWorkspace[]): RailSection[] {
  const pinned = ordered.filter((workspace) => workspace.pinned);
  if (pinned.length === 0) return [{ label: "", workspaces: ordered }];

  const rest = ordered.filter((workspace) => !workspace.pinned);
  return [
    { label: "Pinned", workspaces: pinned },
    ...(rest.length > 0 ? [{ label: "Workspaces", workspaces: rest }] : []),
  ];
}
