import { createUsageEnvironmentAtoms } from "@t3tools/client-runtime/state/quota";
import type {
  ProviderInstanceId,
  QueuedMessage,
  ServerProvider,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { providersWithLimits } from "@t3tools/shared/usageLimits";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

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

const EMPTY_ACCOUNTS: ReadonlyArray<UsageAccountView> = [];
const EMPTY_QUEUED_MESSAGES: ReadonlyArray<QueuedMessage> = [];

/** Accounts with usage limits on the primary environment. */
export const primaryUsageAccountsAtom = Atom.make((get): ReadonlyArray<UsageAccountView> => {
  const accounts = groupUsageAccounts(get(primaryServerProvidersAtom));
  return accounts.length === 0 ? EMPTY_ACCOUNTS : accounts;
}).pipe(Atom.withLabel("web-primary-usage-accounts"));

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
