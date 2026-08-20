import { describe, expect, it } from "@effect/vitest";

import {
  pickSubcommand,
  summarizeRecords,
  type ProcessSpawnOutcome,
  type ProcessSpawnRecord,
} from "./processSpawnObserver.ts";

const record = (
  overrides: Partial<ProcessSpawnRecord> & Pick<ProcessSpawnRecord, "command">,
): ProcessSpawnRecord => ({
  subcommand: null,
  cwd: null,
  durationMs: 10,
  exitCode: 0,
  outcome: "ok" satisfies ProcessSpawnOutcome,
  finishedAtMs: 1_000,
  ...overrides,
});

describe("pickSubcommand", () => {
  it("skips the -C flag and its value, which the VCS layer prefixes to every git call", () => {
    expect(pickSubcommand(["-C", "/repo", "rev-parse", "--show-toplevel"])).toBe("rev-parse");
  });

  it("skips a run of -c overrides", () => {
    expect(
      pickSubcommand([
        "-c",
        "core.quotepath=false",
        "-c",
        "core.fsmonitor=false",
        "-C",
        "/repo",
        "status",
      ]),
    ).toBe("status");
  });

  it("returns the first argument when it is already the subcommand", () => {
    expect(pickSubcommand(["remote", "-v"])).toBe("remote");
  });

  it("returns null when every argument is a flag", () => {
    expect(pickSubcommand(["--version"])).toBeNull();
    expect(pickSubcommand([])).toBeNull();
  });
});

describe("summarizeRecords", () => {
  it("reports the spawn rate over the window rather than the sample count", () => {
    const summary = summarizeRecords(
      Array.from({ length: 60 }, () => record({ command: "git" })),
      30_000,
      false,
    );

    expect(summary.spawns).toBe(60);
    expect(summary.spawnsPerSecond).toBe(2);
  });

  it("groups by command and subcommand, ranking by count", () => {
    const summary = summarizeRecords(
      [
        ...Array.from({ length: 3 }, () =>
          record({ command: "git", subcommand: "rev-parse", durationMs: 100 }),
        ),
        record({ command: "git", subcommand: "remote", durationMs: 50 }),
      ],
      30_000,
      false,
    );

    expect(summary.topCommands[0]).toEqual({
      label: "git rev-parse",
      count: 3,
      nonZeroExits: 0,
      avgDurationMs: 100,
    });
    expect(summary.topCommands[1]?.label).toBe("git remote");
  });

  it("counts outcomes separately", () => {
    const summary = summarizeRecords(
      [
        record({ command: "git", outcome: "non-zero-exit", exitCode: 128 }),
        record({ command: "git", outcome: "timeout", exitCode: null }),
        record({ command: "git", outcome: "spawn-error", exitCode: null }),
        record({ command: "git" }),
      ],
      30_000,
      false,
    );

    expect(summary.nonZeroExits).toBe(1);
    expect(summary.timeouts).toBe(1);
    expect(summary.spawnErrors).toBe(1);
  });

  it("estimates the Windows taskkill amplification only on Windows", () => {
    const records = [
      record({ command: "git", outcome: "non-zero-exit", exitCode: 128 }),
      record({ command: "git", outcome: "non-zero-exit", exitCode: 128 }),
    ];

    // Each already-exited non-zero child costs two `taskkill` runs, and each of those is an
    // `exec` through cmd.exe: cmd.exe + taskkill.exe + a conhost apiece.
    expect(summarizeRecords(records, 30_000, true).estimatedWindowsCleanupProcesses).toBe(16);
    expect(summarizeRecords(records, 30_000, false).estimatedWindowsCleanupProcesses).toBe(0);
  });

  it("ranks the busiest working directories so a storm can be attributed to a project", () => {
    const summary = summarizeRecords(
      [
        record({ command: "git", cwd: "/a" }),
        record({ command: "git", cwd: "/a" }),
        record({ command: "git", cwd: "/b" }),
        record({ command: "git", cwd: null }),
      ],
      30_000,
      false,
    );

    expect(summary.topCwds).toEqual([
      { cwd: "/a", count: 2 },
      { cwd: "/b", count: 1 },
    ]);
  });

  it("handles an empty window without dividing by zero", () => {
    const summary = summarizeRecords([], 30_000, true);

    expect(summary.spawns).toBe(0);
    expect(summary.spawnsPerSecond).toBe(0);
    expect(summary.estimatedWindowsCleanupProcesses).toBe(0);
    expect(summary.topCommands).toEqual([]);
  });
});
