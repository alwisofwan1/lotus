/**
 * Split or inline for a diff tab. The diff's own width picks one (the same 760px line as
 * `useResponsiveGitDiffPanelDisplay` in the bb repo, see plans/editor-revamp/PLAN.md); once the user picks one by hand, that wins.
 */

export type DiffLayout = "split" | "inline";

/** Below this, two columns of code are too narrow to read. */
export const DIFF_SPLIT_MIN_WIDTH = 760;

/** `paneWidth` is null until the pane has been measured; inline is safe at any width. */
export function resolveDiffLayout(paneWidth: number | null, manual: DiffLayout | null): DiffLayout {
  if (manual) return manual;
  return paneWidth !== null && paneWidth >= DIFF_SPLIT_MIN_WIDTH ? "split" : "inline";
}
