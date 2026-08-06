import { describe, expect, it } from "vite-plus/test";

import { layoutGitGraph, type GitGraphLane } from "./gitGraphLayout";

/**
 * Commits are written parent-last, matching git's output order: a child is
 * always emitted before the parent it points at.
 */
const graph = (...entries: ReadonlyArray<readonly [string, ...string[]]>) =>
  entries.map(([oid, ...parents]) => ({ oid, parents }));

const columnsOf = (rows: ReadonlyArray<{ readonly column: number }>) =>
  rows.map((row) => row.column);

describe("layoutGitGraph", () => {
  it("keeps a linear history in a single column", () => {
    const layout = layoutGitGraph(graph(["c", "b"], ["b", "a"], ["a"]));

    expect(columnsOf(layout.rows)).toEqual([0, 0, 0]);
    expect(layout.columnCount).toBe(1);
  });

  it("frees the lane after a root commit so nothing trails below it", () => {
    const layout = layoutGitGraph(graph(["b", "a"], ["a"]));

    expect(layout.rows[1]!.lanesBelow).toEqual([]);
    expect(layout.trailingLanes).toEqual([]);
  });

  it("gives a second branch tip its own column", () => {
    // Two tips over a shared parent:
    //   tipA   tipB
    //     \    /
    //      base
    const layout = layoutGitGraph(graph(["tipA", "base"], ["tipB", "base"], ["base"]));

    expect(columnsOf(layout.rows)).toEqual([0, 1, 0]);
    expect(layout.columnCount).toBe(2);
  });

  it("converges both children onto the shared parent's row", () => {
    const layout = layoutGitGraph(graph(["tipA", "base"], ["tipB", "base"], ["base"]));

    const base = layout.rows[2]!;
    expect(base.column).toBe(0);
    // The second child's lane terminates here and is drawn joining column 0.
    expect(base.mergedFrom).toEqual([1]);
    expect(base.lanesAbove).toEqual(["base", "base"]);
    expect(base.lanesBelow).toEqual([]);
  });

  it("forks a merge commit's extra parent into a new lane", () => {
    // merge has two parents; `main` continues in place, `feature` starts right.
    const layout = layoutGitGraph(
      graph(["merge", "main", "feature"], ["main", "base"], ["feature", "base"], ["base"]),
    );

    const merge = layout.rows[0]!;
    expect(merge.column).toBe(0);
    expect(merge.forkedTo).toEqual([1]);
    expect(merge.lanesBelow).toEqual(["main", "feature"]);
    expect(columnsOf(layout.rows)).toEqual([0, 0, 1, 0]);
  });

  it("does not allocate a duplicate lane when a merge parent is already drawn", () => {
    // `shared` is reachable as both the second parent of the merge and the
    // first parent of `other`, so the merge line must join the existing lane.
    const layout = layoutGitGraph(
      graph(["other", "shared"], ["merge", "main", "shared"], ["main", "base"], ["shared"]),
    );

    const merge = layout.rows[1]!;
    // Joins `shared`'s existing lane rather than opening a third.
    expect(merge.forkedTo).toEqual([0]);
    expect(layout.columnCount).toBe(2);
  });

  it("reuses a freed lane for a later branch tip instead of growing forever", () => {
    // `short` ends at a root, freeing column 1 before `late` needs a lane.
    const layout = layoutGitGraph(
      graph(
        ["main", "mainParent"],
        ["short", "shortRoot"],
        ["shortRoot"],
        ["late"],
        ["mainParent"],
      ),
    );

    // The freed column is reused rather than the graph growing a third.
    expect(layout.rows[3]!.column).toBe(1);
    expect(layout.columnCount).toBe(2);
  });

  it("records lanesAbove and lanesBelow as a consistent chain", () => {
    const layout = layoutGitGraph(
      graph(["merge", "main", "feature"], ["main", "base"], ["feature", "base"], ["base"]),
    );

    // Each row's `lanesAbove` must equal the previous row's `lanesBelow`, or
    // the renderer would draw lines that do not meet between rows. Compared as
    // whole sequences so a failure shows where the chain breaks.
    expect(layout.rows.slice(1).map((row) => row.lanesAbove)).toEqual(
      layout.rows.slice(0, -1).map((row) => row.lanesBelow),
    );
  });

  it("starts the first row from the seed lanes when paging", () => {
    const seedLanes: ReadonlyArray<GitGraphLane> = ["b", "sideBranch"];
    const layout = layoutGitGraph(graph(["b", "a"]), { seedLanes });

    expect(layout.rows[0]!.lanesAbove).toEqual(["b", "sideBranch"]);
    expect(layout.rows[0]!.column).toBe(0);
    // The unrelated lane must survive the row untouched.
    expect(layout.rows[0]!.lanesBelow).toEqual(["a", "sideBranch"]);
  });

  it("produces the same layout paged as it does in one pass", () => {
    const commits = graph(
      ["merge", "main", "feature"],
      ["main", "base"],
      ["feature", "base"],
      ["base", "root"],
      ["root"],
    );

    const whole = layoutGitGraph(commits);
    const firstPage = layoutGitGraph(commits.slice(0, 2));
    const secondPage = layoutGitGraph(commits.slice(2), {
      seedLanes: firstPage.trailingLanes,
    });

    expect([...firstPage.rows, ...secondPage.rows].map((row) => row.column)).toEqual(
      columnsOf(whole.rows),
    );
  });

  it("carries trailing lanes for commits the page did not reach", () => {
    const layout = layoutGitGraph(graph(["c", "b"]));

    // The parent the page never reached still holds its lane, so the next page
    // can continue the line.
    expect(layout.trailingLanes).toEqual(["b"]);
  });

  it("handles an octopus merge", () => {
    const layout = layoutGitGraph(graph(["octopus", "p1", "p2", "p3"], ["p1"], ["p2"], ["p3"]));

    expect(layout.rows[0]!.forkedTo).toEqual([1, 2]);
    expect(columnsOf(layout.rows)).toEqual([0, 0, 1, 2]);
  });

  it("returns an empty layout for no commits", () => {
    const layout = layoutGitGraph([]);

    expect(layout.rows).toEqual([]);
    expect(layout.columnCount).toBe(0);
    expect(layout.trailingLanes).toEqual([]);
  });

  it("never places a commit outside the reported column count", () => {
    const layout = layoutGitGraph(
      graph(["a", "b", "c"], ["b", "d"], ["c", "d"], ["d", "e"], ["x", "e"], ["e"]),
    );

    for (const row of layout.rows) {
      expect(row.column).toBeLessThan(layout.columnCount);
      for (const merged of row.mergedFrom) expect(merged).toBeLessThan(layout.columnCount);
      for (const forked of row.forkedTo) expect(forked).toBeLessThan(layout.columnCount);
    }
  });
});
