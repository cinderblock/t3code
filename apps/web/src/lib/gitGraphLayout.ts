import type { VcsGraphCommit } from "@t3tools/contracts";

/**
 * Assigns commits to columns ("lanes") so a client can draw a GitKraken-style
 * commit graph.
 *
 * The server sends topology only — `(oid, parents[])` in git's `--date-order` —
 * and this turns it into per-row drawing instructions. Doing it here rather than
 * on the server keeps the wire payload small and lets the graph re-layout on
 * load-more without a round trip.
 *
 * The one invariant the algorithm leans on: git never emits a parent before one
 * of its children, in any of its ordering modes. So by the time a commit is
 * reached, every lane reserved for it was reserved by a commit already drawn
 * above it.
 */

/** A lane slot: the oid this lane is waiting to draw, or null when free. */
export type GitGraphLane = string | null;

export interface GitGraphRow {
  readonly oid: string;
  /** Column the commit's dot sits in. */
  readonly column: number;
  /** Lane occupancy immediately above this row. */
  readonly lanesAbove: ReadonlyArray<GitGraphLane>;
  /** Lane occupancy immediately below this row. */
  readonly lanesBelow: ReadonlyArray<GitGraphLane>;
  /**
   * Columns above that terminate at this commit, excluding {@link column}.
   * Non-empty when a commit has more than one child — the lines converge here.
   */
  readonly mergedFrom: ReadonlyArray<number>;
  /**
   * Columns below that this commit forks into, excluding {@link column}.
   * Non-empty for a merge commit, whose extra parents start new lanes.
   */
  readonly forkedTo: ReadonlyArray<number>;
}

export interface GitGraphLayout {
  readonly rows: ReadonlyArray<GitGraphRow>;
  /** Widest lane count across the page; the renderer sizes the gutter from this. */
  readonly columnCount: number;
  /**
   * Lane state after the last row. Feed this back as `seedLanes` when laying out
   * the next page, or lanes visibly reshuffle at the page boundary.
   */
  readonly trailingLanes: ReadonlyArray<GitGraphLane>;
}

export interface GitGraphLayoutOptions {
  /** Trailing lanes from the previous page, for a continuous graph across pages. */
  readonly seedLanes?: ReadonlyArray<GitGraphLane>;
}

/** First free slot, extending the lane array when all slots are taken. */
function allocateLane(lanes: Array<GitGraphLane>, oid: string): number {
  const free = lanes.indexOf(null);
  if (free !== -1) {
    lanes[free] = oid;
    return free;
  }
  lanes.push(oid);
  return lanes.length - 1;
}

/** Drops trailing free slots so an emptied graph reports a narrow gutter. */
function trimTrailingFreeLanes(lanes: Array<GitGraphLane>): void {
  while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
    lanes.pop();
  }
}

export function layoutGitGraph(
  commits: ReadonlyArray<Pick<VcsGraphCommit, "oid" | "parents">>,
  options: GitGraphLayoutOptions = {},
): GitGraphLayout {
  const lanes: Array<GitGraphLane> = [...(options.seedLanes ?? [])];
  const rows: GitGraphRow[] = [];
  let columnCount = 0;

  for (const commit of commits) {
    const lanesAbove = [...lanes];

    // Every lane reserved for this commit ends here. The leftmost becomes the
    // commit's own column so the busiest line stays as straight as possible;
    // the rest are drawn converging into it.
    const reserved: number[] = [];
    for (let index = 0; index < lanes.length; index++) {
      if (lanes[index] === commit.oid) reserved.push(index);
    }

    let column: number;
    if (reserved.length === 0) {
      // A branch tip: nothing below it has claimed this commit yet.
      column = allocateLane(lanes, commit.oid);
    } else {
      column = reserved[0]!;
      for (const index of reserved.slice(1)) {
        lanes[index] = null;
      }
    }
    const mergedFrom = reserved.slice(1);

    // The first parent inherits the commit's own lane, which is what keeps a
    // branch's mainline vertical. Extra parents (a merge) reuse a lane already
    // waiting for them if there is one, else start a new lane to the right.
    const forkedTo: number[] = [];
    if (commit.parents.length === 0) {
      lanes[column] = null;
    } else {
      lanes[column] = commit.parents[0]!;
      for (const parent of commit.parents.slice(1)) {
        const existing = lanes.indexOf(parent);
        if (existing !== -1) {
          // Already drawn as a lane; the merge line just joins it.
          if (existing !== column) forkedTo.push(existing);
          continue;
        }
        forkedTo.push(allocateLane(lanes, parent));
      }
    }

    trimTrailingFreeLanes(lanes);
    const lanesBelow = [...lanes];
    columnCount = Math.max(columnCount, lanesAbove.length, lanesBelow.length, column + 1);

    rows.push({ oid: commit.oid, column, lanesAbove, lanesBelow, mergedFrom, forkedTo });
  }

  return { rows, columnCount, trailingLanes: [...lanes] };
}
