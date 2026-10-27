import type { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const AUTO_UPDATE_IDLE = Duration.minutes(5);
const AUTO_UPDATE_POLL = Duration.minutes(1);
// A failed install tends to fail the same way again (permissions, a locked
// file), so that version waits before it is retried.
const AUTO_UPDATE_RETRY_AFTER = Duration.hours(6);

export interface FailedAutoUpdate {
  readonly version: string;
  readonly atMs: number;
}

export interface AutoUpdateTarget {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly version: string;
  /** Every instance of the driver, since instances can share one install. */
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
}

function isAutoUpdateCandidate(provider: ServerProvider): boolean {
  const advisory = provider.versionAdvisory;
  return (
    provider.enabled &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "broken" &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "unsupported" &&
    advisory?.status === "behind_latest" &&
    advisory.latestVersion !== null &&
    advisory.canUpdate === true &&
    advisory.updateCommand !== null
  );
}

/** One target per driver; another instance with its own install follows on a later poll. */
export function selectAutoUpdateTargets(
  providers: ReadonlyArray<ServerProvider>,
  failures: ReadonlyMap<ProviderInstanceId, FailedAutoUpdate>,
  nowMs: number,
): ReadonlyArray<AutoUpdateTarget> {
  const byDriver = new Map<ProviderDriverKind, Array<ServerProvider>>();
  for (const provider of providers) {
    byDriver.set(provider.driver, [...(byDriver.get(provider.driver) ?? []), provider]);
  }
  const targets: Array<AutoUpdateTarget> = [];
  for (const [driver, driverProviders] of byDriver) {
    const updating = driverProviders.some(
      (provider) =>
        provider.updateState?.status === "queued" || provider.updateState?.status === "running",
    );
    if (updating) continue;
    const candidate = driverProviders.find((provider) => {
      if (!isAutoUpdateCandidate(provider)) return false;
      const failed = failures.get(provider.instanceId);
      return (
        failed === undefined ||
        failed.version !== provider.versionAdvisory?.latestVersion ||
        nowMs - failed.atMs >= Duration.toMillis(AUTO_UPDATE_RETRY_AFTER)
      );
    });
    const version = candidate?.versionAdvisory?.latestVersion;
    if (candidate === undefined || version == null) continue;
    targets.push({
      driver,
      instanceId: candidate.instanceId,
      version,
      instanceIds: driverProviders.map((provider) => provider.instanceId),
    });
  }
  return targets;
}

export const make = Effect.fn("ProviderAutoUpdater.make")(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const runner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const failures = yield* Ref.make<ReadonlyMap<ProviderInstanceId, FailedAutoUpdate>>(new Map());

  const recordOutcome = (target: AutoUpdateTarget, succeeded: boolean, atMs: number) =>
    Ref.update(failures, (current) => {
      const next = new Map(current);
      if (succeeded) next.delete(target.instanceId);
      else next.set(target.instanceId, { version: target.version, atMs });
      return next;
    });

  const updateTarget = Effect.fn("ProviderAutoUpdater.updateTarget")(function* (
    target: AutoUpdateTarget,
  ) {
    const result = yield* sessions.runWhenIdle(
      {
        instanceIds: target.instanceIds,
        idleForMs: Duration.toMillis(AUTO_UPDATE_IDLE),
        detail: "Released so the provider could update while idle.",
      },
      Effect.logInfo("Updating provider while idle", target).pipe(
        Effect.andThen(
          runner.updateProvider({
            provider: target.driver,
            instanceId: target.instanceId,
            automatic: true,
          }),
        ),
        Effect.map(
          ({ providers }) =>
            providers.find((provider) => provider.instanceId === target.instanceId)?.updateState,
        ),
        Effect.catch((error) =>
          Effect.logWarning("Automatic provider update was refused", {
            ...target,
            reason: error.reason,
          }).pipe(Effect.as(undefined)),
        ),
      ),
    );
    if (Option.isNone(result)) return;
    const state = result.value;
    const succeeded = state?.status === "succeeded";
    yield* Effect.logInfo("Automatic provider update finished", {
      ...target,
      status: state?.status ?? "refused",
      message: state?.message ?? null,
    });
    yield* recordOutcome(target, succeeded, yield* Clock.currentTimeMillis);
    // The runner re-reads only the instance it updated; siblings may share the install.
    yield* Effect.forEach(
      target.instanceIds.filter((instanceId) => instanceId !== target.instanceId),
      (instanceId) => providerRegistry.refreshInstance(instanceId),
      { discard: true },
    );
  });

  const poll = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    if (!settings.autoUpdateProviders || !settings.enableProviderUpdateChecks) return;
    const targets = selectAutoUpdateTargets(
      yield* providerRegistry.getProviders,
      yield* Ref.get(failures),
      yield* Clock.currentTimeMillis,
    );
    yield* Effect.forEach(targets, updateTarget, { discard: true });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Automatic provider update poll failed", cause)),
  );

  return { poll };
});

// Startup counts as activity: a provider that is behind waits a full idle
// window rather than updating under the first turn after launch.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { poll } = yield* make();
    yield* Effect.sleep(AUTO_UPDATE_IDLE).pipe(
      Effect.andThen(poll.pipe(Effect.repeat(Schedule.spaced(AUTO_UPDATE_POLL)))),
      Effect.forkScoped,
    );
  }),
);
