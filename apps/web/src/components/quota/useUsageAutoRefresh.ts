import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import type { EnvironmentId } from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import { useEffect } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentPresentation } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { usageRefreshDue } from "./usagePresentation";

/** The environment's provider refresh interval in ms; non-positive means off. */
export function useUsageRefreshIntervalMs(environmentId: EnvironmentId): number {
  return useEnvironmentSettings(environmentId, (settings) =>
    Duration.toMillis(
      resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
  );
}

/**
 * Keeps on-screen meters current. The server only re-probes while some client
 * holds a foreground lease (visible *and* focused or recently used, outside
 * the performance profile), so a strip left visible on a second monitor, or
 * one shown again after idle, would otherwise sit on numbers from hours ago.
 *
 * Requests go through upstream's `refreshUsageLimits` as automatic calls: they
 * join a refresh already in flight and share the Usage page's five-minute
 * floor, so a stale read the server cannot improve on is retried at most that
 * often. The Claude driver's capabilities cache bounds the endpoint further.
 */
export function useUsageAutoRefresh(input: {
  readonly environmentId: EnvironmentId;
  readonly checkedMs: number | null;
  readonly nowMs: number;
  readonly refreshIntervalMs: number;
}) {
  const { environmentId, checkedMs, nowMs, refreshIntervalMs } = input;
  const { presentation } = useEnvironmentPresentation(environmentId);
  const connected = presentation?.connection.phase === "connected";
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  useEffect(() => {
    if (!connected || document.visibilityState !== "visible") return;
    if (!usageRefreshDue(checkedMs, nowMs, refreshIntervalMs)) return;
    void refreshUsageLimits(
      environmentId,
      () => refreshProviders({ environmentId, input: {} }),
      true,
    );
  }, [checkedMs, connected, environmentId, nowMs, refreshIntervalMs, refreshProviders]);
}
