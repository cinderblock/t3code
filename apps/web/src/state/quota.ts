import {
  createUsageEnvironmentAtoms,
  scheduledThreadKeys,
  usageResetsForInstance,
} from "@t3tools/client-runtime/state/quota";
import type { SnoozeUsageResets } from "@t3tools/client-runtime/state/thread-settled";
import type {
  EnvironmentId,
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
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "./server";

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
 * The account behind the thread's selected provider instance first, the rest
 * in their grouped order. Pure, exported for tests.
 */
export function orderUsageAccountsForSelection(
  accounts: ReadonlyArray<UsageAccountView>,
  selectedInstanceId: ProviderInstanceId | null,
): ReadonlyArray<UsageAccountView> {
  if (selectedInstanceId === null) return accounts;
  const index = accounts.findIndex((account) => account.instanceIds.includes(selectedInstanceId));
  if (index <= 0) return accounts;
  return [accounts[index]!, ...accounts.slice(0, index), ...accounts.slice(index + 1)];
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
const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const EMPTY_QUEUED_MESSAGES: ReadonlyArray<QueuedMessage> = [];

/**
 * Accounts with usage limits on one environment. Reads the raw provider list,
 * not `providersIgnoringCheckedAtAtom`: the strip shows how old the numbers
 * are, so a push that only moves `checkedAt` matters here.
 */
export const usageAccountsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<UsageAccountView> => {
    const accounts = groupUsageAccounts(
      get(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_PROVIDERS,
    );
    return accounts.length === 0 ? EMPTY_ACCOUNTS : accounts;
  }).pipe(Atom.withLabel(`web-usage-accounts:${environmentId}`)),
);

/** Usage-reporting drivers on one environment whose limits have not arrived. */
export const usageWaitingDriversAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<ServerProvider["driver"]> => {
    const drivers = usageWaitingDrivers(
      get(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_PROVIDERS,
    );
    return drivers.length === 0 ? EMPTY_DRIVERS : drivers;
  }).pipe(Atom.withLabel(`web-usage-waiting-drivers:${environmentId}`)),
);

/** All queued messages on one environment; each server owns its own queue. */
export const queuedMessagesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<QueuedMessage> => {
    const projection = Option.getOrNull(
      AsyncResult.value(
        get(usageEnvironment.queuedMessagesProjection({ environmentId, input: {} })),
      ),
    );
    return projection?.messages ?? EMPTY_QUEUED_MESSAGES;
  }).pipe(Atom.withLabel(`web-queued-messages:${environmentId}`)),
);

const NO_SCHEDULED_THREADS: ReadonlySet<string> = new Set();

/**
 * `${environmentId}:${threadId}` of threads holding a send-later message, across the
 * comma-joined environment ids. Read by the sidebar's Working placement only.
 */
export const scheduledThreadKeysAtom = Atom.family((environmentIds: string) =>
  Atom.make((get): ReadonlySet<string> => {
    const keys = environmentIds
      .split(",")
      .filter((environmentId) => environmentId.length > 0)
      .flatMap((environmentId) =>
        scheduledThreadKeys(environmentId, get(queuedMessagesAtom(environmentId as EnvironmentId))),
      );
    return keys.length === 0 ? NO_SCHEDULED_THREADS : new Set(keys);
  }).pipe(Atom.withLabel(`web-scheduled-thread-keys:${environmentIds}`)),
);

/**
 * Next usage resets for the account a thread runs on, read once when a snooze
 * menu opens rather than subscribed, so sidebar rows don't re-render on every
 * provider probe.
 */
export function readThreadSnoozeUsageResets(thread: {
  readonly environmentId: EnvironmentId;
  readonly modelSelection: { readonly instanceId: string };
  readonly runtime?: { readonly providerInstanceId?: string | null } | null;
}): SnoozeUsageResets {
  return usageResetsForInstance(
    appAtomRegistry.get(serverEnvironment.providersValueAtom(thread.environmentId)) ??
      EMPTY_PROVIDERS,
    thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
  );
}

/** The resets every thread shares, so a bulk snooze wakes them all at the same moment. */
export function commonSnoozeUsageResets(
  resets: ReadonlyArray<SnoozeUsageResets>,
): SnoozeUsageResets {
  const [first, ...rest] = resets;
  if (first === undefined) return {};
  return {
    session: rest.every((entry) => entry.session === first.session) ? first.session : undefined,
    weekly: rest.every((entry) => entry.weekly === first.weekly) ? first.weekly : undefined,
  };
}
