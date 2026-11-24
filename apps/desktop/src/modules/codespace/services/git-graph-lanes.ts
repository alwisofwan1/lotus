/**
 * Lanes for the Git graph: which column each commit sits in and which lines pass its row.
 *
 * Input is topo-ordered (a child always above its parents). A lane is waiting for one commit (its
 * `sha`) and keeps a hue for its life, so a branch keeps its colour while lanes beside it come
 * and go (Q16). Columns past `MAX_LANES` draw folded into one dotted lane.
 */

export const MAX_LANES = 6;
export const HUE_COUNT = 6;

export type Lane = { sha: string; hue: number };

export type LaneRow = {
  /** The commit's column. */
  col: number;
  hue: number;
  /** Lanes entering the row from above (`null` = empty column). */
  before: (Lane | null)[];
  /** Lanes leaving the row below. */
  after: (Lane | null)[];
  /** Other lanes that ended at this commit: they bend into it from above. */
  merging: { col: number; hue: number }[];
  /** Lanes to the second and later parents: they bend out of it below. */
  forks: { col: number; hue: number }[];
};

export function layoutLanes(commits: readonly { sha: string; parents: readonly string[] }[]): LaneRow[] {
  const lanes: (Lane | null)[] = [];
  let nextHue = 0;
  const freeColumn = () => {
    const empty = lanes.indexOf(null);
    return empty < 0 ? lanes.length : empty;
  };
  return commits.map((commit) => {
    const before = lanes.slice();
    let col = lanes.findIndex((lane) => lane?.sha === commit.sha);
    let hue: number;
    if (col < 0) {
      // A branch tip: nothing above waited for it.
      col = freeColumn();
      hue = nextHue++;
    } else {
      hue = lanes[col]!.hue;
    }
    const merging: LaneRow["merging"] = [];
    lanes.forEach((lane, i) => {
      if (lane?.sha === commit.sha && i !== col) {
        merging.push({ col: i, hue: lane.hue });
        lanes[i] = null;
      }
    });
    const [first, ...rest] = commit.parents;
    lanes[col] = first ? { sha: first, hue } : null;
    const forks: LaneRow["forks"] = [];
    for (const parent of rest) {
      let i = lanes.findIndex((lane) => lane?.sha === parent);
      if (i < 0) {
        i = freeColumn();
        lanes[i] = { sha: parent, hue: nextHue++ };
      }
      forks.push({ col: i, hue: lanes[i]!.hue });
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    return { col, hue, before, after: lanes.slice(), merging, forks };
  });
}

/** Columns the drawing needs: folded lanes take one column together. */
export function laneColumns(rows: readonly LaneRow[]): number {
  let widest = 1;
  for (const row of rows) widest = Math.max(widest, row.before.length, row.after.length, row.col + 1);
  return Math.min(MAX_LANES + 1, widest);
}

export function isFolded(col: number): boolean {
  return col >= MAX_LANES;
}
