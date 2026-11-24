import type { TopControlsPref } from "../hooks/useCanvasBehaviorSettings";

export interface TopControlsModeInput {
  /** The user's persisted preference. */
  pref: TopControlsPref;
  /** No project is open — the command bar isn't rendered, so there's nothing to dock into. */
  emptyState: boolean;
}

/**
 * The effective placement of the project/canvas controls. The user can prefer the command-bar
 * dock, but the empty state forces the top pill back so no control becomes unreachable: the
 * command bar is rendered inside the project branch, so it doesn't exist without a project. Pure
 * so the fallback logic is tested without rendering the page.
 */
export function resolveTopControlsMode({ pref, emptyState }: TopControlsModeInput): TopControlsPref {
  if (pref === "command-bar" && !emptyState) return "command-bar";
  return "top-bar";
}
