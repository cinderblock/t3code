import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { usageResetsForInstance } from "@t3tools/client-runtime/state/quota";
import type { SnoozeUsageResets } from "@t3tools/client-runtime/state/thread-settled";
import {
  needsCursorKeychainAccess,
  refreshUsage,
  usageSummaryInput,
} from "@t3tools/client-runtime/state/usage";
import { resolveUsageAccess } from "@t3tools/client-runtime/state/usage-access";
import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentSession, readEnvironmentScope } from "./session";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly isConnected: boolean;
  readonly canReadDiagnostics: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
  readonly needsCursorKeychainAccess: boolean;
}

const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const access = resolveUsageAccess({
        connectionPhase: presentation.connection.phase,
        session: AsyncResult.getOrElse(sessionResult, () => null),
        hasSessionError: sessionResult._tag === "Failure",
      });
      if (!access.canReadDiagnostics) {
        statuses.push({
          environmentId,
          label: presentation.entry.target.label,
          isConnected: presentation.connection.phase === "connected",
          ...access,
          summary: null,
          needsCursorKeychainAccess: false,
        });
        continue;
      }
      const result = get(
        serverEnvironment.usageSummary({
          environmentId,
          input: usageSummaryInput(
            input,
            get(serverEnvironment.usageModelFilterAtom(environmentId)),
          ),
        }),
      );
      const summary = AsyncResult.getOrElse(result, () => null);
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        isConnected: presentation.connection.phase === "connected",
        canReadDiagnostics: true,
        error: result._tag === "Failure" ? "This environment could not report usage." : null,
        summary,
        needsCursorKeychainAccess: needsCursorKeychainAccess(
          summary,
          get(serverEnvironment.providersValueAtom(environmentId)),
        ),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`mobile-usage:window:${windowKey}`)),
);

// Keyed and valued as strings so a row re-renders only when a reset time moves,
// not on every provider probe.
const snoozeUsageResetsAtom = Atom.family((key: string) =>
  Atom.make((get): string => {
    const [environmentId, instanceId] = JSON.parse(key) as [EnvironmentId, string];
    const resets = usageResetsForInstance(
      get(serverEnvironment.providersValueAtom(environmentId)) ?? [],
      instanceId,
    );
    return JSON.stringify([resets.session ?? null, resets.weekly ?? null]);
  }).pipe(Atom.withLabel(`mobile-snooze-usage-resets:${key}`)),
);

/** Next usage resets for the account a thread runs on, for its snooze presets. */
export function useThreadSnoozeUsageResets(thread: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: string;
}): SnoozeUsageResets {
  const value = useAtomValue(
    snoozeUsageResetsAtom(JSON.stringify([thread.environmentId, thread.providerInstanceId])),
  );
  return useMemo(() => {
    const [session, weekly] = JSON.parse(value) as [string | null, string | null];
    return { session: session ?? undefined, weekly: weekly ?? undefined };
  }, [value]);
}

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];

  readonly isPending: boolean;

  readonly isPartial: boolean;
  readonly refresh: (input?: UsageSummaryInput) => Promise<void>;
}

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
): UsageView {
  const windowKey = useMemo(
    () =>
      JSON.stringify({
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        timeZone: input.timeZone,
        resolution: input.resolution,
        sinceTime: input.sinceTime,
        untilTime: input.untilTime,
      }),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
    ],
  );
  const atom = usageByWindowAtom(windowKey);
  const environments = useAtomValue(atom);
  const selectedEnvironments = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? environments
        : environments.filter(({ environmentId }) => selectedEnvironmentIds.has(environmentId)),
    [environments, selectedEnvironmentIds],
  );

  const refresh = useCallback(
    (nextInput?: UsageSummaryInput) =>
      refreshUsage({
        registry: appAtomRegistry,
        server: serverEnvironment,
        presentations: environmentPresentations,

        environmentIds: selectedEnvironments
          .filter(
            (environment) =>
              environment.canReadDiagnostics &&
              readEnvironmentScope(environment.environmentId, AuthDiagnosticsReadScope),
          )
          .map(({ environmentId }) => environmentId),
        input: nextInput ?? (JSON.parse(windowKey) as UsageSummaryInput),
      }),
    [selectedEnvironments, windowKey],
  );

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = selectedEnvironments.flatMap((environment) =>
      environment.summary === null
        ? []
        : [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary: environment.summary,
            },
          ],
    );
    return mergeUsage(answered, USAGE_CONTRACT_VERSION);
  }, [selectedEnvironments]);

  const answeredCount = selectedEnvironments.filter(
    (environment) => environment.summary !== null,
  ).length;
  const stillReporting = selectedEnvironments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    merged,
    environments,
    selectedEnvironments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
