import { memo } from "react";
import { HUE_COUNT, MAX_LANES, isFolded, type LaneRow } from "@/modules/codespace/services/git-graph-lanes";

export const LANE_WIDTH = 11;
const PAD = 6;

export function lanesWidth(columns: number): number {
  return PAD * 2 + (columns - 1) * LANE_WIDTH;
}

const x = (col: number) => PAD + Math.min(col, MAX_LANES) * LANE_WIDTH;
const tone = (hue: number, col: number) => (isFolded(col) ? "gg-folded" : `gg-hue-${hue % HUE_COUNT}`);

/** One row of lanes: lines passing, lines bending in and out, the commit's dot. */
export const GitGraphLanes = memo(function GitGraphLanes({ row, width, height }: { row: LaneRow; width: number; height: number }) {
  const mid = height / 2;
  const cx = x(row.col);
  const merging = new Set(row.merging.map((lane) => lane.col));
  return (
    <svg className="gg-lanes" width={width} height={height} aria-hidden="true">
      {row.before.map((lane, col) =>
        lane && col !== row.col && !merging.has(col) ? (
          <line key={`p${col}`} className={tone(lane.hue, col)} x1={x(col)} y1={0} x2={x(col)} y2={height} />
        ) : null,
      )}
      {row.before[row.col] ? <line className={tone(row.hue, row.col)} x1={cx} y1={0} x2={cx} y2={mid} /> : null}
      {row.merging.map((lane) => (
        <path key={`m${lane.col}`} className={tone(lane.hue, lane.col)} d={`M${x(lane.col)} 0 C${x(lane.col)} ${mid} ${cx} ${mid / 2} ${cx} ${mid}`} />
      ))}
      {row.after[row.col] ? <line className={tone(row.hue, row.col)} x1={cx} y1={mid} x2={cx} y2={height} /> : null}
      {row.forks.map((lane) => (
        <path key={`f${lane.col}`} className={tone(lane.hue, lane.col)} d={`M${cx} ${mid} C${cx} ${mid + 10} ${x(lane.col)} ${mid + 6} ${x(lane.col)} ${height}`} />
      ))}
      <circle className={`gg-dot ${tone(row.hue, row.col)}`} cx={cx} cy={mid} r={3.6} />
    </svg>
  );
});
