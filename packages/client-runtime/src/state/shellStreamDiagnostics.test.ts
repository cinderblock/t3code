import { describe, expect, it } from "vite-plus/test";

import {
  classifyShellTransition,
  shouldReportApplied,
  type ShellTransition,
} from "./shellStreamDiagnostics.ts";

const transition = (overrides: Partial<ShellTransition> = {}): ShellTransition => ({
  environmentId: "Noook",
  itemKind: "thread-upserted",
  itemSequence: 100,
  previousSequence: 90,
  nextSequence: 100,
  previousThreadCount: 5,
  nextThreadCount: 5,
  previousProjectCount: 3,
  nextProjectCount: 3,
  discardedAsStale: false,
  droppedWithoutSnapshot: false,
  ...overrides,
});

describe("classifyShellTransition", () => {
  it("stays quiet for an ordinary applied event", () => {
    expect(classifyShellTransition(transition())).toBeNull();
  });

  it("stays quiet when the view grows", () => {
    expect(
      classifyShellTransition(transition({ previousThreadCount: 5, nextThreadCount: 6 })),
    ).toBeNull();
  });

  // Sequences come from a min across projectors of the global event log, so a jump is normal
  // and must not be reported. Only a shrinking or stalled view is worth waking someone for.
  it("stays quiet for a large sequence jump, which is normal here", () => {
    expect(
      classifyShellTransition(transition({ previousSequence: 90, nextSequence: 900 })),
    ).toBeNull();
  });

  it("reports a view that lost a thread", () => {
    expect(
      classifyShellTransition(transition({ previousThreadCount: 5, nextThreadCount: 4 })),
    ).toBe("shell-view-shrank");
  });

  it("reports a view that lost a project", () => {
    expect(
      classifyShellTransition(transition({ previousProjectCount: 3, nextProjectCount: 2 })),
    ).toBe("shell-view-shrank");
  });

  it("reports an event ignored as at-or-behind the cached cursor", () => {
    expect(classifyShellTransition(transition({ discardedAsStale: true }))).toBe(
      "shell-event-discarded",
    );
  });

  it("reports an event that arrived with no snapshot to apply it to", () => {
    expect(
      classifyShellTransition(
        transition({ droppedWithoutSnapshot: true, previousThreadCount: null }),
      ),
    ).toBe("shell-event-dropped");
  });

  it("does not invent a shrink when a count is unknown", () => {
    expect(
      classifyShellTransition(transition({ previousThreadCount: null, nextThreadCount: 0 })),
    ).toBeNull();
  });
});

describe("shouldReportApplied", () => {
  // A failure-only diagnostic went completely silent through a reproduction, and silence could
  // not distinguish a clean stream from a dead one. The heartbeat exists to make absence mean
  // something, so the first item must always report.
  it("always reports the first applied item", () => {
    expect(shouldReportApplied(1)).toBe(true);
  });

  it("reports every tenth item thereafter", () => {
    expect(shouldReportApplied(10)).toBe(true);
    expect(shouldReportApplied(20)).toBe(true);
  });

  it("stays quiet in between so the log does not become a firehose", () => {
    expect(shouldReportApplied(2)).toBe(false);
    expect(shouldReportApplied(9)).toBe(false);
    expect(shouldReportApplied(11)).toBe(false);
  });
});
