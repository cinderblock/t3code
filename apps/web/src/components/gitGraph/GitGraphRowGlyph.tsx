import { memo } from "react";

import type { GitGraphRow } from "~/lib/gitGraphLayout";

import { laneColor } from "./gitGraphPresentation";

export const GIT_GRAPH_LANE_WIDTH = 14;
export const GIT_GRAPH_ROW_HEIGHT = 30;
const DOT_RADIUS = 3.5;
const STROKE_WIDTH = 1.5;

const laneX = (column: number) => column * GIT_GRAPH_LANE_WIDTH + GIT_GRAPH_LANE_WIDTH / 2;

/**
 * A cubic bezier that leaves and enters vertically, so a line joining another
 * lane reads as a branch rather than a diagonal cut across the row.
 */
function curvePath(fromX: number, fromY: number, toX: number, toY: number): string {
  const midY = (fromY + toY) / 2;
  return `M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`;
}

/**
 * Draws one row of the commit graph: the lanes passing through it, the lines
 * converging on its commit, the lines forking out of it, and the dot itself.
 *
 * Everything is derived from the row's own lane state, so rows render
 * independently and a virtualized list can mount them in any order.
 */
export const GitGraphRowGlyph = memo(function GitGraphRowGlyph(props: {
  row: GitGraphRow;
  columnCount: number;
}) {
  const { row, columnCount } = props;
  const width = Math.max(1, columnCount) * GIT_GRAPH_LANE_WIDTH;
  const midY = GIT_GRAPH_ROW_HEIGHT / 2;
  const dotX = laneX(row.column);

  const passThrough: number[] = [];
  for (let index = 0; index < row.lanesAbove.length; index++) {
    const above = row.lanesAbove[index];
    if (above === null || above === undefined) continue;
    if (index === row.column || above === row.oid) continue;
    // A lane only truly passes through when it holds the same commit below;
    // anything else terminated or was reassigned on this row.
    if (row.lanesBelow[index] !== above) continue;
    passThrough.push(index);
  }

  const continuesBelow = (row.lanesBelow[row.column] ?? null) !== null;
  const arrivesFromAbove = row.lanesAbove[row.column] === row.oid;

  return (
    <svg
      width={width}
      height={GIT_GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${width} ${GIT_GRAPH_ROW_HEIGHT}`}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
      focusable="false"
    >
      {passThrough.map((index) => (
        <line
          key={`through-${index}`}
          x1={laneX(index)}
          y1={0}
          x2={laneX(index)}
          y2={GIT_GRAPH_ROW_HEIGHT}
          stroke={laneColor(index)}
          strokeWidth={STROKE_WIDTH}
        />
      ))}

      {arrivesFromAbove ? (
        <line
          x1={dotX}
          y1={0}
          x2={dotX}
          y2={midY}
          stroke={laneColor(row.column)}
          strokeWidth={STROKE_WIDTH}
        />
      ) : null}

      {row.mergedFrom.map((index) => (
        <path
          key={`merge-${index}`}
          d={curvePath(laneX(index), 0, dotX, midY)}
          fill="none"
          stroke={laneColor(index)}
          strokeWidth={STROKE_WIDTH}
        />
      ))}

      {continuesBelow ? (
        <line
          x1={dotX}
          y1={midY}
          x2={dotX}
          y2={GIT_GRAPH_ROW_HEIGHT}
          stroke={laneColor(row.column)}
          strokeWidth={STROKE_WIDTH}
        />
      ) : null}

      {row.forkedTo.map((index) => (
        <path
          key={`fork-${index}`}
          d={curvePath(dotX, midY, laneX(index), GIT_GRAPH_ROW_HEIGHT)}
          fill="none"
          stroke={laneColor(index)}
          strokeWidth={STROKE_WIDTH}
        />
      ))}

      <circle
        cx={dotX}
        cy={midY}
        r={DOT_RADIUS}
        fill={laneColor(row.column)}
        stroke="var(--background)"
        strokeWidth={1.5}
      />
    </svg>
  );
});
