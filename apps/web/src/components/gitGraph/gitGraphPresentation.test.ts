import type { VcsGraphRef, VcsGraphWorktree, VcsWorktreeChangeCounts } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorktreeRows,
  formatCommitAge,
  GIT_GRAPH_LANE_COLORS,
  groupGraphRefsByOid,
  laneColor,
  shortOid,
  splitVisibleGraphRefs,
  worktreeDirectoryName,
} from "./gitGraphPresentation";

const ref = (
  overrides: Partial<VcsGraphRef> & Pick<VcsGraphRef, "name" | "kind">,
): VcsGraphRef => ({
  oid: "a".repeat(40),
  current: false,
  isDefault: false,
  worktreePath: null,
  ...overrides,
});

describe("laneColor", () => {
  it("wraps around the palette instead of running off the end", () => {
    expect(laneColor(0)).toBe(GIT_GRAPH_LANE_COLORS[0]);
    expect(laneColor(GIT_GRAPH_LANE_COLORS.length)).toBe(GIT_GRAPH_LANE_COLORS[0]);
    expect(laneColor(GIT_GRAPH_LANE_COLORS.length + 3)).toBe(GIT_GRAPH_LANE_COLORS[3]);
  });

  it("never returns undefined for any column", () => {
    for (let column = 0; column < 40; column++) {
      expect(laneColor(column)).toBeTypeOf("string");
    }
  });
});

describe("shortOid", () => {
  it("abbreviates to seven characters", () => {
    expect(shortOid("0123456789abcdef")).toBe("0123456");
  });
});

describe("groupGraphRefsByOid", () => {
  it("groups refs by the commit they point at", () => {
    const grouped = groupGraphRefsByOid([
      ref({ name: "main", kind: "local", oid: "a".repeat(40) }),
      ref({ name: "v1.0", kind: "tag", oid: "b".repeat(40) }),
      ref({ name: "origin/main", kind: "remote", oid: "a".repeat(40) }),
    ]);

    expect(grouped.get("a".repeat(40))?.map((entry) => entry.name)).toEqual([
      "main",
      "origin/main",
    ]);
    expect(grouped.get("b".repeat(40))?.map((entry) => entry.name)).toEqual(["v1.0"]);
  });

  it("orders current, then default, then locals, remotes, and tags", () => {
    const grouped = groupGraphRefsByOid([
      ref({ name: "v2.0", kind: "tag" }),
      ref({ name: "origin/main", kind: "remote" }),
      ref({ name: "topic", kind: "local" }),
      ref({ name: "main", kind: "local", isDefault: true }),
      ref({ name: "feature", kind: "local", current: true }),
    ]);

    expect(grouped.get("a".repeat(40))?.map((entry) => entry.name)).toEqual([
      "feature",
      "main",
      "topic",
      "origin/main",
      "v2.0",
    ]);
  });

  it("breaks ties by name so the order is stable across refreshes", () => {
    const grouped = groupGraphRefsByOid([
      ref({ name: "zeta", kind: "local" }),
      ref({ name: "alpha", kind: "local" }),
    ]);

    expect(grouped.get("a".repeat(40))?.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
  });

  it("returns an empty map for no refs", () => {
    expect(groupGraphRefsByOid([]).size).toBe(0);
  });
});

describe("splitVisibleGraphRefs", () => {
  const refs = (count: number) =>
    Array.from({ length: count }, (_, index) => ref({ name: `branch-${index}`, kind: "local" }));

  it("shows every ref when it fits", () => {
    const { visible, overflowCount } = splitVisibleGraphRefs(refs(3), 3);

    expect(visible).toHaveLength(3);
    expect(overflowCount).toBe(0);
  });

  it("reserves a slot for the overflow chip so the row never exceeds the budget", () => {
    const { visible, overflowCount } = splitVisibleGraphRefs(refs(10), 3);

    // Two chips plus a "+8" chip is three slots total.
    expect(visible).toHaveLength(2);
    expect(overflowCount).toBe(8);
    expect(visible.length + 1).toBeLessThanOrEqual(3);
  });

  it("accounts for every ref between visible and overflow", () => {
    const { visible, overflowCount } = splitVisibleGraphRefs(refs(7), 3);

    expect(visible.length + overflowCount).toBe(7);
  });

  it("keeps the highest-ranked refs visible", () => {
    const grouped = groupGraphRefsByOid([
      ref({ name: "origin/main", kind: "remote" }),
      ref({ name: "topic", kind: "local" }),
      ref({ name: "feature", kind: "local", current: true }),
      ref({ name: "v1.0", kind: "tag" }),
    ]);
    const { visible } = splitVisibleGraphRefs(grouped.get("a".repeat(40)) ?? [], 3);

    expect(visible.map((entry) => entry.name)).toEqual(["feature", "topic"]);
  });

  it("handles an empty ref list", () => {
    const { visible, overflowCount } = splitVisibleGraphRefs([], 3);

    expect(visible).toEqual([]);
    expect(overflowCount).toBe(0);
  });
});

describe("buildWorktreeRows", () => {
  const worktree = (path: string, overrides: Partial<VcsGraphWorktree> = {}): VcsGraphWorktree => ({
    path,
    refName: "main",
    headOid: "a".repeat(40),
    isPrimary: false,
    ...overrides,
  });
  const counts = (
    path: string,
    overrides: Partial<VcsWorktreeChangeCounts> = {},
  ): VcsWorktreeChangeCounts => ({
    path,
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    conflictedFileCount: 0,
    ...overrides,
  });

  it("orders unstaged above staged, matching the direction changes travel", () => {
    const rows = buildWorktreeRows({
      worktrees: [worktree("/repo")],
      changes: [counts("/repo", { stagedFileCount: 2, unstagedFileCount: 3 })],
      activeWorktreePath: null,
    });

    expect(rows.map((row) => row.kind)).toEqual(["unstaged", "staged"]);
    expect(rows[0]!.fileCount).toBe(3);
    expect(rows[1]!.fileCount).toBe(2);
  });

  it("omits a row that would show zero files", () => {
    const rows = buildWorktreeRows({
      worktrees: [worktree("/repo")],
      changes: [counts("/repo", { stagedFileCount: 1 })],
      activeWorktreePath: null,
    });

    expect(rows.map((row) => row.kind)).toEqual(["staged"]);
  });

  it("produces nothing for a clean worktree", () => {
    const rows = buildWorktreeRows({
      worktrees: [worktree("/repo")],
      changes: [counts("/repo")],
      activeWorktreePath: null,
    });

    expect(rows).toEqual([]);
  });

  it("rolls untracked and conflicted files into the unstaged count", () => {
    const rows = buildWorktreeRows({
      worktrees: [worktree("/repo")],
      changes: [
        counts("/repo", { unstagedFileCount: 1, untrackedFileCount: 2, conflictedFileCount: 3 }),
      ],
      activeWorktreePath: null,
    });

    expect(rows[0]!.fileCount).toBe(6);
    expect(rows[0]!.untrackedFileCount).toBe(2);
    expect(rows[0]!.conflictedFileCount).toBe(3);
  });

  it("shows a worktree whose only changes are untracked files", () => {
    const rows = buildWorktreeRows({
      worktrees: [worktree("/repo")],
      changes: [counts("/repo", { untrackedFileCount: 1 })],
      activeWorktreePath: null,
    });

    expect(rows.map((row) => row.kind)).toEqual(["unstaged"]);
  });

  it("sorts the active worktree first, then the primary one", () => {
    const rows = buildWorktreeRows({
      worktrees: [
        worktree("/repo", { isPrimary: true }),
        worktree("/wt/other"),
        worktree("/wt/active"),
      ],
      changes: [
        counts("/repo", { unstagedFileCount: 1 }),
        counts("/wt/other", { unstagedFileCount: 1 }),
        counts("/wt/active", { unstagedFileCount: 1 }),
      ],
      activeWorktreePath: "/wt/active",
    });

    expect(rows.map((row) => row.worktreePath)).toEqual(["/wt/active", "/repo", "/wt/other"]);
    expect(rows[0]!.isActiveWorktree).toBe(true);
  });

  it("skips worktrees whose changes were not reported", () => {
    // A path in `skippedPaths` has no counts; showing it as clean would be a lie.
    const rows = buildWorktreeRows({
      worktrees: [worktree("/repo"), worktree("/wt/unreadable")],
      changes: [counts("/repo", { unstagedFileCount: 1 })],
      activeWorktreePath: null,
    });

    expect(rows.map((row) => row.worktreePath)).toEqual(["/repo"]);
  });

  it("labels a detached worktree by its directory name", () => {
    const rows = buildWorktreeRows({
      worktrees: [worktree("/wt/t3code-feature", { refName: null })],
      changes: [counts("/wt/t3code-feature", { unstagedFileCount: 1 })],
      activeWorktreePath: null,
    });

    expect(rows[0]!.label).toBe("t3code-feature");
  });
});

describe("worktreeDirectoryName", () => {
  it("handles both path separators and a trailing slash", () => {
    expect(worktreeDirectoryName("C:\\Users\\me\\repo")).toBe("repo");
    expect(worktreeDirectoryName("/home/me/repo")).toBe("repo");
    expect(worktreeDirectoryName("/home/me/repo/")).toBe("repo");
  });
});

describe("formatCommitAge", () => {
  const now = 1_700_000_000_000;

  it("formats each unit boundary", () => {
    expect(formatCommitAge(now - 30_000, now)).toBe("now");
    expect(formatCommitAge(now - 5 * 60_000, now)).toBe("5m");
    expect(formatCommitAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(formatCommitAge(now - 2 * 86_400_000, now)).toBe("2d");
    expect(formatCommitAge(now - 3 * 7 * 86_400_000, now)).toBe("3w");
    expect(formatCommitAge(now - 2 * 365 * 86_400_000, now)).toBe("2y");
  });

  it("shows a commit dated in the future as now rather than a negative age", () => {
    // Clock skew between the repo's machine and this one is common enough that
    // "in 3 hours" would read as a bug.
    expect(formatCommitAge(now + 3 * 3_600_000, now)).toBe("now");
  });
});
