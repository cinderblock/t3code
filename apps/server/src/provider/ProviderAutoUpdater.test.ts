import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderAutoUpdater from "./ProviderAutoUpdater.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");

function makeProvider(input: {
  readonly instanceId: string;
  readonly driver?: ProviderDriverKind;
  readonly latestVersion?: string | null;
  readonly canUpdate?: boolean;
  readonly updateState?: ServerProviderUpdateState;
}): ServerProvider {
  const latestVersion = input.latestVersion === undefined ? "2.0.0" : input.latestVersion;
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.driver ?? CLAUDE,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-24T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: latestVersion === null ? "current" : "behind_latest",
      currentVersion: "1.0.0",
      latestVersion,
      updateCommand: "claude update",
      canUpdate: input.canUpdate ?? true,
      checkedAt: null,
      message: null,
    },
    ...(input.updateState ? { updateState: input.updateState } : {}),
  };
}

const finished = (status: ServerProviderUpdateState["status"]): ServerProviderUpdateState => ({
  status,
  startedAt: null,
  finishedAt: null,
  message: null,
  output: null,
});

describe("selectAutoUpdateTargets", () => {
  it("updates one instance per driver and quiesces all of that driver's instances", () => {
    const targets = ProviderAutoUpdater.selectAutoUpdateTargets(
      [
        makeProvider({ instanceId: "claude" }),
        makeProvider({ instanceId: "claude-work" }),
        makeProvider({ instanceId: "codex", driver: CODEX }),
      ],
      new Map(),
      0,
    );
    assert.deepStrictEqual(
      targets.map((target): ReadonlyArray<unknown> => [target.instanceId, target.instanceIds]),
      [
        ["claude", ["claude", "claude-work"]],
        ["codex", ["codex"]],
      ],
    );
  });

  it("leaves a driver alone while one of its updates is queued or running", () => {
    const targets = ProviderAutoUpdater.selectAutoUpdateTargets(
      [
        makeProvider({ instanceId: "claude" }),
        makeProvider({ instanceId: "claude-work", updateState: finished("running") }),
      ],
      new Map(),
      0,
    );
    assert.deepStrictEqual(targets, []);
  });

  it("skips providers that are current or need a manual update", () => {
    const targets = ProviderAutoUpdater.selectAutoUpdateTargets(
      [
        makeProvider({ instanceId: "claude", latestVersion: null }),
        makeProvider({ instanceId: "codex", driver: CODEX, canUpdate: false }),
      ],
      new Map(),
      0,
    );
    assert.deepStrictEqual(targets, []);
  });

  it("waits before retrying a version that failed, but not a newer one", () => {
    const failures = new Map([[ProviderInstanceId.make("claude"), { version: "2.0.0", atMs: 0 }]]);
    const hour = 60 * 60 * 1000;
    const select = (latestVersion: string, nowMs: number) =>
      ProviderAutoUpdater.selectAutoUpdateTargets(
        [makeProvider({ instanceId: "claude", latestVersion })],
        failures,
        nowMs,
      ).length;
    assert.equal(select("2.0.0", hour), 0);
    assert.equal(select("2.0.1", hour), 1);
    assert.equal(select("2.0.0", 6 * hour), 1);
  });
});

describe("ProviderAutoUpdater.poll", () => {
  const makeHarness = (input: {
    readonly enabled: boolean;
    readonly idle: boolean;
    readonly result: ServerProviderUpdateState["status"];
  }) =>
    Effect.gen(function* () {
      const providers = [makeProvider({ instanceId: "claude" })];
      const updates = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const unused = Effect.die("unused");
      const registry: ProviderRegistry.ProviderRegistry["Service"] = {
        getProviders: Effect.succeed(providers),
        refresh: () => unused,
        refreshInstance: () => Effect.succeed(providers),
        refreshWorkspaceSnapshot: () => unused,
        getProviderMaintenanceCapabilitiesForInstance: () => unused,
        setProviderMaintenanceActionState: () => unused,
        streamChanges: Stream.empty,
      };
      const layer = Layer.mergeAll(
        ServerSettings.layerTest({ autoUpdateProviders: input.enabled }),
        Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
        Layer.succeed(ProviderMaintenanceRunner.ProviderMaintenanceRunner, {
          updateProvider: (target) =>
            Ref.update(updates, (current) => [...current, target]).pipe(
              Effect.as({
                providers: providers.map((provider) => ({
                  ...provider,
                  updateState: finished(input.result),
                })),
              }),
            ),
        }),
        Layer.succeed(
          ProviderSessionManager.ProviderSessionManagerV2,
          ProviderSessionManager.ProviderSessionManagerV2.of({
            shutdown: Effect.void,
            open: () => Effect.die("unused open"),
            get: () => Effect.succeed(Option.none()),
            isLive: () => Effect.succeed(false),
            close: () => Effect.void,
            closeInstance: () => Effect.void,
            release: () => Effect.void,
            detach: () => Effect.void,
            runWhenIdle: (_, effect) => (input.idle ? Effect.asSome(effect) : Effect.succeedNone),
          }),
        ),
      );
      const { poll } = yield* ProviderAutoUpdater.make().pipe(Effect.provide(layer));
      return { poll, updates };
    });

  it.effect("does nothing unless the setting is on", () =>
    Effect.gen(function* () {
      const { poll, updates } = yield* makeHarness({
        enabled: false,
        idle: true,
        result: "succeeded",
      });
      yield* poll;
      assert.deepStrictEqual(yield* Ref.get(updates), []);
    }),
  );

  it.effect("updates nothing while the provider is busy", () =>
    Effect.gen(function* () {
      const { poll, updates } = yield* makeHarness({
        enabled: true,
        idle: false,
        result: "succeeded",
      });
      yield* poll;
      assert.deepStrictEqual(yield* Ref.get(updates), []);
    }),
  );

  it.effect("runs an automatic update once idle and backs off after a failure", () =>
    Effect.gen(function* () {
      const { poll, updates } = yield* makeHarness({
        enabled: true,
        idle: true,
        result: "failed",
      });
      yield* poll;
      yield* poll;
      assert.deepStrictEqual(yield* Ref.get(updates), [
        { provider: CLAUDE, instanceId: ProviderInstanceId.make("claude"), automatic: true },
      ]);
    }),
  );
});
