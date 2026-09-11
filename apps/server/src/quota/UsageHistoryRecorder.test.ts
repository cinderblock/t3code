import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import ForkMigration0001 from "../persistence/Migrations/fork/001_UsageSamples.ts";
import * as UsageHistoryRecorder from "./UsageHistoryRecorder.ts";

/** Only the fields the recorder reads; the rest of a provider snapshot is irrelevant here. */
const provider = (instanceId: string, usageLimits: ServerProvider["usageLimits"]): ServerProvider =>
  ({ instanceId: instanceId as ProviderInstanceId, usageLimits }) as unknown as ServerProvider;

const limitsAt = (checkedAt: string, usedPercent: number): ServerProvider["usageLimits"] => ({
  checkedAt,
  windows: [
    { id: "five_hour", kind: "session", label: "Session", usedPercent, windowDurationMins: 300 },
    { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: usedPercent / 2 },
  ],
});

const layer = it.layer(
  Layer.mergeAll(
    Layer.effect(UsageHistoryRecorder.UsageHistoryRecorder, UsageHistoryRecorder.make).pipe(
      Layer.provide(makeProviderRegistryLayer([])),
      Layer.provideMerge(NodeSqliteClient.layerMemory()),
    ),
  ),
);

layer("UsageHistoryRecorder", (it) => {
  it.effect("writes one sample per window when an instance publishes a new read", () =>
    Effect.gen(function* () {
      yield* ForkMigration0001;
      const recorder = yield* UsageHistoryRecorder.UsageHistoryRecorder;

      const first = yield* recorder.recordProviders([
        provider("claude-main", limitsAt("2026-09-10T10:00:00.000Z", 40)),
      ]);
      assert.equal(first, 2);

      // The same read republished (a snapshot change unrelated to limits) adds nothing.
      const repeat = yield* recorder.recordProviders([
        provider("claude-main", limitsAt("2026-09-10T10:00:00.000Z", 40)),
      ]);
      assert.equal(repeat, 0);

      const next = yield* recorder.recordProviders([
        provider("claude-main", limitsAt("2026-09-10T10:05:00.000Z", 46)),
      ]);
      assert.equal(next, 2);

      const history = yield* recorder.getHistory({
        instanceId: "claude-main" as ProviderInstanceId,
        windowId: "five_hour",
        since: "2026-09-10T00:00:00.000Z",
      });
      assert.deepEqual(
        history.samples.map((sample) => [sample.capturedAt, sample.percent]),
        [
          ["2026-09-10T10:00:00.000Z", 40],
          ["2026-09-10T10:05:00.000Z", 46],
        ],
      );
    }),
  );

  it.effect("skips instances whose limits are unavailable or empty", () =>
    Effect.gen(function* () {
      yield* ForkMigration0001;
      const recorder = yield* UsageHistoryRecorder.UsageHistoryRecorder;
      const written = yield* recorder.recordProviders([
        provider("codex-main", {
          checkedAt: "2026-09-10T10:00:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" },
        }),
        provider("cursor-main", undefined),
      ]);
      assert.equal(written, 0);
    }),
  );
});
