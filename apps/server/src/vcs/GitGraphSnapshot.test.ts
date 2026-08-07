import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  parseGraphCommits,
  parseGraphRefs,
  parseGraphWorktrees,
  parseWorktreeChangeCounts,
} from "./GitVcsDriverCore.ts";
import * as VcsProcess from "./VcsProcess.ts";

const FIELD = "\x1f";
const RECORD = "\0";

const commitRecord = (fields: {
  oid: string;
  parents: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  summary: string;
}) =>
  `${RECORD}${fields.oid}${FIELD}${fields.parents}${FIELD}${fields.authorName}${FIELD}${fields.authorEmail}${FIELD}${fields.authoredAt}${FIELD}${fields.committedAt}${FIELD}${fields.summary}\n`;

describe("parseGraphCommits", () => {
  it("parses parents, identity, and both timestamps", () => {
    const commits = parseGraphCommits(
      commitRecord({
        oid: "a".repeat(40),
        parents: `${"b".repeat(40)} ${"c".repeat(40)}`,
        authorName: "Ada Lovelace",
        authorEmail: "ada@example.com",
        authoredAt: "1700000000",
        committedAt: "1700000060",
        summary: "Merge branch 'feature'",
      }),
    );

    assert.strictEqual(commits.length, 1);
    const commit = commits[0]!;
    assert.strictEqual(commit.oid, "a".repeat(40));
    assert.deepStrictEqual([...commit.parents], ["b".repeat(40), "c".repeat(40)]);
    assert.strictEqual(commit.authorName, "Ada Lovelace");
    assert.strictEqual(commit.authorEmail, "ada@example.com");
    assert.strictEqual(commit.summary, "Merge branch 'feature'");
    assert.strictEqual(DateTime.toEpochMillis(commit.authoredAt), 1_700_000_000_000);
    assert.strictEqual(DateTime.toEpochMillis(commit.committedAt), 1_700_000_060_000);
  });

  it("treats a root commit as having no parents", () => {
    const commits = parseGraphCommits(
      commitRecord({
        oid: "d".repeat(40),
        parents: "",
        authorName: "Ada",
        authorEmail: "ada@example.com",
        authoredAt: "1700000000",
        committedAt: "1700000000",
        summary: "Initial commit",
      }),
    );

    assert.deepStrictEqual([...commits[0]!.parents], []);
  });

  it("keeps a subject containing tabs and quotes intact", () => {
    // A tab- or newline-delimited format would desynchronise here; the
    // unit-separated one must not.
    const summary = 'fix:\tstop "quoting" \x1b[31mthings\x1b[0m';
    const commits = parseGraphCommits(
      commitRecord({
        oid: "e".repeat(40),
        parents: "f".repeat(40),
        authorName: "Ada",
        authorEmail: "ada@example.com",
        authoredAt: "1700000000",
        committedAt: "1700000000",
        summary,
      }),
    );

    assert.strictEqual(commits[0]!.summary, summary);
  });

  it("accepts an empty commit subject", () => {
    const commits = parseGraphCommits(
      commitRecord({
        oid: "1".repeat(40),
        parents: "",
        authorName: "Ada",
        authorEmail: "ada@example.com",
        authoredAt: "1700000000",
        committedAt: "1700000000",
        summary: "",
      }),
    );

    assert.strictEqual(commits.length, 1);
    assert.strictEqual(commits[0]!.summary, "");
  });

  it("returns nothing for empty output", () => {
    assert.deepStrictEqual(parseGraphCommits(""), []);
  });

  it("skips a record with an unparseable timestamp rather than dating it to the epoch", () => {
    const commits = parseGraphCommits(
      commitRecord({
        oid: "2".repeat(40),
        parents: "",
        authorName: "Ada",
        authorEmail: "ada@example.com",
        authoredAt: "not-a-number",
        committedAt: "1700000000",
        summary: "Broken",
      }),
    );

    assert.deepStrictEqual(commits, []);
  });
});

describe("parseGraphWorktrees", () => {
  it("keeps detached worktrees that the branch-only parser drops", () => {
    const stdout =
      "worktree /repo\0HEAD aaa\0branch refs/heads/main\0\0" +
      "worktree /repo/../wt-detached\0HEAD bbb\0detached\0\0";

    const entries = parseGraphWorktrees(stdout);

    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries[0], {
      path: "/repo",
      refName: "main",
      headOid: "aaa",
      isPrimary: true,
      prunable: false,
    });
    assert.deepStrictEqual(entries[1], {
      path: "/repo/../wt-detached",
      refName: null,
      headOid: "bbb",
      isPrimary: false,
      prunable: false,
    });
  });

  it("marks only the first entry as primary and flags prunable entries", () => {
    const stdout =
      "worktree /repo\0HEAD aaa\0branch refs/heads/main\0\0" +
      "worktree /gone\0HEAD bbb\0branch refs/heads/old\0prunable gitdir file points to non-existent location\0\0";

    const entries = parseGraphWorktrees(stdout);

    assert.strictEqual(entries[0]!.isPrimary, true);
    assert.strictEqual(entries[1]!.isPrimary, false);
    assert.strictEqual(entries[1]!.prunable, true);
  });

  it("omits a bare repository, which has no working tree to show changes for", () => {
    const stdout = "worktree /repo.git\0bare\0\0worktree /wt\0HEAD aaa\0branch refs/heads/main\0\0";

    const entries = parseGraphWorktrees(stdout);

    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]!.path, "/wt");
    // The bare entry is skipped entirely, so the surviving worktree becomes primary.
    assert.strictEqual(entries[0]!.isPrimary, true);
  });

  it("records an unborn HEAD as a null oid", () => {
    const entries = parseGraphWorktrees("worktree /repo\0branch refs/heads/main\0\0");

    assert.strictEqual(entries[0]!.headOid, null);
  });
});

describe("parseGraphRefs", () => {
  const context = {
    defaultBranch: "main",
    remoteNames: ["origin"],
    worktreePathByBranch: new Map([["feature", "/wt/feature"]]),
    currentBranch: "main",
  };

  it("classifies local, remote, and tag refs", () => {
    const stdout = [
      `refs/heads/main${FIELD}${"a".repeat(40)}${FIELD}${FIELD}`,
      `refs/heads/feature${FIELD}${"b".repeat(40)}${FIELD}${FIELD}`,
      `refs/remotes/origin/main${FIELD}${"a".repeat(40)}${FIELD}${FIELD}`,
      `refs/tags/v1.0${FIELD}${"c".repeat(40)}${FIELD}${FIELD}`,
    ].join("\n");

    const refs = parseGraphRefs(stdout, context);

    assert.deepStrictEqual(
      refs.map((ref) => [ref.name, ref.kind]),
      [
        ["main", "local"],
        ["feature", "local"],
        ["origin/main", "remote"],
        ["v1.0", "tag"],
      ],
    );
  });

  it("peels an annotated tag to the commit it wraps", () => {
    const tagObject = "d".repeat(40);
    const commit = "e".repeat(40);
    const stdout = `refs/tags/v2.0${FIELD}${tagObject}${FIELD}${commit}${FIELD}`;

    const refs = parseGraphRefs(stdout, context);

    assert.strictEqual(
      refs[0]!.oid,
      commit,
      "annotated tags must resolve to a commit, not a tag object",
    );
  });

  it("drops symrefs so origin/HEAD does not double-label its target", () => {
    const stdout = `refs/remotes/origin/HEAD${FIELD}${"a".repeat(40)}${FIELD}${FIELD}refs/remotes/origin/main`;

    assert.deepStrictEqual(parseGraphRefs(stdout, context), []);
  });

  it("marks the current branch, the default branch, and worktree ownership", () => {
    const stdout = [
      `refs/heads/main${FIELD}${"a".repeat(40)}${FIELD}${FIELD}`,
      `refs/heads/feature${FIELD}${"b".repeat(40)}${FIELD}${FIELD}`,
      `refs/remotes/origin/main${FIELD}${"a".repeat(40)}${FIELD}${FIELD}`,
    ].join("\n");

    const refs = parseGraphRefs(stdout, context);

    const main = refs.find((ref) => ref.name === "main" && ref.kind === "local")!;
    const feature = refs.find((ref) => ref.name === "feature")!;
    const originMain = refs.find((ref) => ref.kind === "remote")!;

    assert.strictEqual(main.current, true);
    assert.strictEqual(main.isDefault, true);
    assert.strictEqual(main.worktreePath, null);
    assert.strictEqual(feature.current, false);
    assert.strictEqual(feature.worktreePath, "/wt/feature");
    assert.strictEqual(originMain.isDefault, true);
  });
});

describe("parseWorktreeChangeCounts", () => {
  // `git status --porcelain=2 -z`: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
  const ordinary = (xy: string, path: string) =>
    `1 ${xy} N... 100644 100644 100644 aaa bbb ${path}\0`;

  it("separates staged from unstaged using the two status characters", () => {
    const counts = parseWorktreeChangeCounts(
      ordinary("M.", "staged-only.ts") +
        ordinary(".M", "unstaged-only.ts") +
        ordinary("MM", "both.ts"),
    );

    // "both.ts" is staged AND unstaged: it counts once on each side.
    expect(counts.stagedFileCount).toBe(2);
    expect(counts.unstagedFileCount).toBe(2);
  });

  it("counts untracked files separately and ignores ignored ones", () => {
    const counts = parseWorktreeChangeCounts("? new.ts\0! build-output.js\0");

    expect(counts.untrackedFileCount).toBe(1);
    expect(counts.stagedFileCount).toBe(0);
    expect(counts.unstagedFileCount).toBe(0);
  });

  it("counts unmerged entries as conflicts rather than staged changes", () => {
    const counts = parseWorktreeChangeCounts(
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.ts\0",
    );

    expect(counts.conflictedFileCount).toBe(1);
    expect(counts.stagedFileCount).toBe(0);
    expect(counts.unstagedFileCount).toBe(0);
  });

  it("does not count a rename's original path as its own entry", () => {
    // A "2" record is followed by a second NUL-terminated field holding the
    // path it was renamed from; reading that as a record would double-count.
    const counts = parseWorktreeChangeCounts(
      `2 R. N... 100644 100644 100644 aaa bbb R100 new-name.ts\0old-name.ts\0` +
        ordinary("M.", "other.ts"),
    );

    expect(counts.stagedFileCount).toBe(2);
    expect(counts.unstagedFileCount).toBe(0);
  });

  it("returns zeroes for a clean worktree", () => {
    expect(parseWorktreeChangeCounts("")).toEqual({
      stagedFileCount: 0,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
      conflictedFileCount: 0,
    });
  });

  it("is not confused by a path containing a newline", () => {
    const counts = parseWorktreeChangeCounts(ordinary("M.", "weird\nname.ts"));

    expect(counts.stagedFileCount).toBe(1);
  });
});

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-graph-snapshot-test-",
});
const TestLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.execute({
      operation: "GitGraphSnapshot.test.git",
      cwd,
      args,
      timeoutMs: 20_000,
    });
  });

const writeAndCommit = (cwd: string, name: string, message: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(cwd, name), `${name}\n`);
    yield* runGit(cwd, ["add", name]);
    yield* runGit(cwd, ["commit", "-m", message]);
  });

const makeRepo = Effect.fn("makeRepo")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-graph-repo-" });
  // `git init` inherits init.defaultBranch from the developer's global config,
  // so every test that names a branch renames it explicitly rather than
  // assuming main or master.
  yield* runGit(cwd, ["init"]);
  yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
  yield* runGit(cwd, ["config", "user.name", "Test"]);
  yield* runGit(cwd, ["config", "commit.gpgsign", "false"]);
  yield* runGit(cwd, ["config", "tag.gpgsign", "false"]);
  return cwd;
});

it.layer(TestLayer)("graphSnapshot", (it) => {
  it.effect(
    "returns commits, refs, and worktrees for a real repository",
    () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const cwd = yield* makeRepo();

        yield* writeAndCommit(cwd, "a.txt", "first");
        yield* runGit(cwd, ["branch", "-M", "main"]);
        yield* runGit(cwd, ["tag", "v1.0"]);
        yield* runGit(cwd, ["checkout", "-b", "feature"]);
        yield* writeAndCommit(cwd, "b.txt", "on feature");
        yield* runGit(cwd, ["checkout", "main"]);
        yield* writeAndCommit(cwd, "c.txt", "on main");
        yield* runGit(cwd, ["merge", "--no-ff", "-m", "merge feature", "feature"]);
        yield* runGit(cwd, ["tag", "-a", "v2.0", "-m", "annotated release"]);

        const snapshot = yield* driver.graphSnapshot({ cwd });

        assert.strictEqual(snapshot.isRepo, true);
        assert.strictEqual(snapshot.commits.length, 4, "three commits plus the merge");

        const merge = snapshot.commits.find((commit) => commit.summary === "merge feature");
        assert.isDefined(merge);
        assert.strictEqual(merge!.parents.length, 2, "a --no-ff merge has two parents");

        const refNames = snapshot.refs.map((ref) => `${ref.kind}:${ref.name}`);
        assert.includeMembers(refNames, ["local:main", "local:feature", "tag:v1.0", "tag:v2.0"]);

        // Every ref must point at a commit present in the graph, or the client
        // would have a label with nowhere to draw it. This is the property that
        // catches an unpeeled annotated tag.
        const commitOids = new Set(snapshot.commits.map((commit) => commit.oid));
        for (const ref of snapshot.refs) {
          assert.isTrue(
            commitOids.has(ref.oid),
            `ref ${ref.kind}:${ref.name} points at ${ref.oid}, which is not in the graph`,
          );
        }

        const primary = snapshot.worktrees.find((worktree) => worktree.isPrimary);
        assert.isDefined(primary);
        assert.strictEqual(primary!.refName, "main");
      }),
    { timeout: 60_000 },
  );

  it.effect(
    "excludes T3 checkpoint refs from the graph",
    () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const cwd = yield* makeRepo();

        yield* writeAndCommit(cwd, "a.txt", "first");
        yield* runGit(cwd, ["branch", "-M", "main"]);
        // A checkpoint commit that no branch, tag, or remote reaches. `git log
        // --all` would pull it into the graph; the ref selection deliberately
        // does not, because checkpoints are T3 bookkeeping, not user history.
        yield* writeAndCommit(cwd, "checkpoint.txt", "checkpoint only");
        const checkpointOid = (yield* runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(cwd, ["update-ref", "refs/t3/checkpoints/test/turn/1", checkpointOid]);
        yield* runGit(cwd, ["reset", "--hard", "HEAD~1"]);

        const snapshot = yield* driver.graphSnapshot({ cwd });

        assert.strictEqual(
          snapshot.commits.length,
          1,
          "only the branch commit belongs in the graph",
        );
        assert.isFalse(
          snapshot.commits.some((commit) => commit.oid === checkpointOid),
          "checkpoint commits must not appear in the graph",
        );
        assert.isFalse(
          snapshot.refs.some((ref) => ref.name.includes("checkpoint")),
          "checkpoint refs must not appear as graph labels",
        );
      }),
    { timeout: 60_000 },
  );

  it.effect(
    "pages through history and reports the end of the walk",
    () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const cwd = yield* makeRepo();

        for (let index = 0; index < 5; index++) {
          yield* writeAndCommit(cwd, `file-${index}.txt`, `commit ${index}`);
        }

        const firstPage = yield* driver.graphSnapshot({ cwd, limit: 2 });
        assert.strictEqual(firstPage.commits.length, 2);
        assert.strictEqual(firstPage.nextCursor, 2);

        const secondPage = yield* driver.graphSnapshot({ cwd, cursor: 2, limit: 2 });
        assert.strictEqual(secondPage.commits.length, 2);
        assert.strictEqual(secondPage.nextCursor, 4);

        const lastPage = yield* driver.graphSnapshot({ cwd, cursor: 4, limit: 2 });
        assert.strictEqual(lastPage.commits.length, 1);
        assert.strictEqual(lastPage.nextCursor, null, "the final page must not advertise another");

        const allOids = [...firstPage.commits, ...secondPage.commits, ...lastPage.commits].map(
          (commit) => commit.oid,
        );
        assert.strictEqual(new Set(allOids).size, 5, "pages must not overlap or skip commits");
      }),
    { timeout: 60_000 },
  );

  it.effect(
    "counts staged, unstaged, and untracked work per worktree",
    () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeRepo();

        yield* writeAndCommit(cwd, "tracked.txt", "first");
        yield* runGit(cwd, ["branch", "-M", "main"]);

        // Get both files committed first: staging anything before this commit
        // would just be swallowed by it.
        yield* writeAndCommit(cwd, "second.txt", "add second");

        // Now one staged edit, one unstaged edit, and one untracked file.
        yield* fileSystem.writeFileString(path.join(cwd, "tracked.txt"), "staged change");
        yield* runGit(cwd, ["add", "tracked.txt"]);
        yield* fileSystem.writeFileString(path.join(cwd, "second.txt"), "modified, not staged");
        yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "new");

        const result = yield* driver.worktreeChanges({ cwd, worktreePaths: [cwd] });

        assert.strictEqual(result.worktrees.length, 1);
        const counts = result.worktrees[0]!;
        assert.strictEqual(counts.stagedFileCount, 1, "tracked.txt is staged");
        assert.strictEqual(counts.unstagedFileCount, 1, "second.txt is modified since the index");
        assert.strictEqual(counts.untrackedFileCount, 1);
        assert.strictEqual(counts.conflictedFileCount, 0);
        assert.deepStrictEqual(result.skippedPaths, []);
      }),
    { timeout: 60_000 },
  );

  it.effect(
    "refuses a path that is not a worktree of this repository",
    () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeRepo();
        yield* writeAndCommit(cwd, "a.txt", "first");

        // A real git repo, but a different one: reading its status through this
        // repository's request would be an access-boundary escape.
        const outsider = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-graph-out-" });
        yield* runGit(outsider, ["init"]);

        const result = yield* driver.worktreeChanges({ cwd, worktreePaths: [outsider] });

        assert.deepStrictEqual(result.worktrees, []);
        assert.deepStrictEqual(result.skippedPaths, [outsider]);
      }),
    { timeout: 60_000 },
  );

  it.effect(
    "reports an empty graph for a repository with no commits",
    () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const cwd = yield* makeRepo();

        const snapshot = yield* driver.graphSnapshot({ cwd });

        assert.strictEqual(snapshot.isRepo, true);
        assert.deepStrictEqual(snapshot.commits, []);
        assert.strictEqual(snapshot.nextCursor, null);
      }),
    { timeout: 60_000 },
  );
});
