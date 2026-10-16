import { createUsageEnvironmentAtoms } from "@t3tools/client-runtime/state/quota";
import type {
  ProviderInstanceId,
  QueuedMessage,
  ServerProvider,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { isProviderAvailable } from "@t3tools/contracts";
import { providersWithLimits } from "@t3tools/shared/usageLimits";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { primaryServerProvidersAtom } from "./server";

export const usageEnvironment = createUsageEnvironmentAtoms(connectionAtomRuntime);

/**
 * One signed-in account as the meter strip shows it. Several provider
 * instances can share a login; they collapse into one account the same way
 * upstream's Limits tab groups them, by driver and signed-in address, so the
 * strip never shows the same windows twice.
 */
export interface UsageAccountView {
  /** Stable across snapshots: `${driver}:${email}` or the lone instance id. */
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  /** Every instance on this account; queue triggers and history reads use the first. */
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly instanceId: ProviderInstanceId;
  /** The instance's configured name, or the driver id when it has none. */
  readonly label: string;
  readonly email: string | undefined;
  /** Plan as the provider labels it (`Max 20x`), when it says. */
  readonly plan: string | undefined;
  /** The freshest limits any instance on the account published. */
  readonly limits: ServerProviderUsageLimits;
}

/** Pure grouping, exported for tests. */
export function groupUsageAccounts(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<UsageAccountView> {
  const accounts = new Map<string, UsageAccountView>();
  for (const provider of providersWithLimits(providers)) {
    const limits = provider.usageLimits;
    if (limits === undefined) continue;
    const email = provider.auth.email?.trim() || undefined;
    const key = email ? `${provider.driver}:${email.toLowerCase()}` : String(provider.instanceId);
    const previous = accounts.get(key);
    if (previous === undefined) {
      accounts.set(key, {
        key,
        driver: provider.driver,
        instanceIds: [provider.instanceId],
        instanceId: provider.instanceId,
        label: provider.displayName?.trim() || String(provider.instanceId),
        email,
        plan: provider.auth.label,
        limits,
      });
      continue;
    }
    const fresher = Date.parse(limits.checkedAt) > Date.parse(previous.limits.checkedAt);
    accounts.set(key, {
      ...previous,
      instanceIds: [...previous.instanceIds, provider.instanceId],
      plan: previous.plan ?? provider.auth.label,
      limits: fresher ? limits : previous.limits,
    });
  }
  return [...accounts.values()];
}

/**
 * Drivers whose probe publishes `usageLimits` (the server's Claude, Codex,
 * Cursor, Grok and OpenCode drivers). A ready provider on one of these with no
 * limits yet is waiting on its first successful probe, which can take tens of
 * seconds after startup; a driver outside this set simply has no usage to show.
 */
const USAGE_REPORTING_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
]);

/**
 * Drivers the meter strip is still waiting on: ready providers that report
 * usage but have not published limits yet. Empty once any account has limits,
 * since the meters then speak for themselves. Pure, exported for tests.
 */
export function usageWaitingDrivers(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider["driver"]> {
  if (providersWithLimits(providers).length > 0) return [];
  const drivers = new Set<ServerProvider["driver"]>();
  for (const provider of providers) {
    if (
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits === undefined &&
      USAGE_REPORTING_DRIVERS.has(provider.driver)
    ) {
      drivers.add(provider.driver);
    }
  }
  return [...drivers];
}

const EMPTY_ACCOUNTS: ReadonlyArray<UsageAccountView> = [];
const EMPTY_DRIVERS: ReadonlyArray<ServerProvider["driver"]> = [];
const EMPTY_QUEUED_MESSAGES: ReadonlyArray<QueuedMessage> = [];

/** Accounts with usage limits on the primary environment. */
export const primaryUsageAccountsAtom = Atom.make((get): ReadonlyArray<UsageAccountView> => {
  const accounts = groupUsageAccounts(get(primaryServerProvidersAtom));
  return accounts.length === 0 ? EMPTY_ACCOUNTS : accounts;
}).pipe(Atom.withLabel("web-primary-usage-accounts"));

/** Usage-reporting drivers on the primary environment whose limits have not arrived. */
export const primaryUsageWaitingDriversAtom = Atom.make(
  (get): ReadonlyArray<ServerProvider["driver"]> => {
    const drivers = usageWaitingDrivers(get(primaryServerProvidersAtom));
    return drivers.length === 0 ? EMPTY_DRIVERS : drivers;
  },
).pipe(Atom.withLabel("web-primary-usage-waiting-drivers"));

/** All queued messages for the primary environment. */
export const primaryQueuedMessagesAtom = Atom.make((get): ReadonlyArray<QueuedMessage> => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return EMPTY_QUEUED_MESSAGES;
  }
  const projection = Option.getOrNull(
    AsyncResult.value(get(usageEnvironment.queuedMessagesProjection({ environmentId, input: {} }))),
  );
  return projection?.messages ?? EMPTY_QUEUED_MESSAGES;
}).pipe(Atom.withLabel("web-primary-queued-messages"));
